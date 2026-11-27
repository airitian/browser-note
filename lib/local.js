// 本地数据服务客户端：让同一台电脑上的多个浏览器共用【唯一一份】笔记数据
//
// ===== 为什么需要它 =====
// chrome.storage.local 落在每个浏览器 profile 各自的
//   <user-data-dir>/Default/Local Extension Settings/<扩展ID>/
// 那是一个 LevelDB 目录，有单写者锁（LOCK 文件 + Windows LockFileEx）。
// 实测（probe-shared-store.mjs）：A 开着时 B 用 junction 指向同一目录会直接
// 失败——`IO error: .../LOCK: Access denied. (LockFile::5)`。
// ⇒ 多个浏览器【同时开着】共用同一份物理存储，物理上不可行。
//
// 把存储收拢到一个本机常驻进程后，锁的问题消失：四个浏览器都只是 HTTP 客户端，
// 真正的写入由服务端单点串行完成。
//
// ===== 与七牛通道的分工 =====
//   本地服务：同机多浏览器的【唯一一份】物理副本 + 断网可用 + 毫秒级
//   七牛云：  跨设备同步 + 远端备份（保留原逻辑，一字不改）
//   GitHub：   灾难兜底备份（不动）
//
// ===== 启用方式 =====
// settings.localUrl 为空（默认）→ 本地服务完全不参与，零网络开销。
// 在设置页填入地址并点「启用并测试」后写入 settings.localUrl 才开始生效。
// 【显式启用】而非自动探测：服务没启动时自动探测会让每次同步白等一次超时；
// 显式开关也让用户清楚「现在到底走哪条通道」。
//
// ===== 失败语义 =====
// 本模块所有导出在失败时返回 null / false，【绝不抛错】——
// 上层 sync.js 的降级链依赖这一点：本地服务挂了必须无缝退回七牛通道。
import { getNotes } from './storage.js';

export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:8787';

// 状态留痕（设置页展示 + 排查）：{ at, through, error, url }
//   at      = 最近一次成功推送到本地服务的时刻
//   through = 那次推送覆盖到的最新本地 note.updatedAt
//   error   = 最近一次失败原因（成功时清空）
const LOCAL_STATUS_KEY = 'localSyncStatus';

// 探测缓存：避免每次同步都重新试连。
//   成功 → 缓存 30 秒（服务在跑，探活没必要每次都做）
//   失败 → 缓存 5 秒（服务没开时，连续同步也不会每次都白等满超时）
const PROBE_OK_TTL = 30 * 1000;
const PROBE_FAIL_TTL = 5 * 1000;
let probeCache = { url: '', at: 0, ok: false };

// 取本地服务地址。空串 = 未启用（调用方直接跳过，不发任何请求）。
export function localUrlOf(settings) {
  const raw = settings && settings.localUrl ? String(settings.localUrl).trim() : '';
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

// 带超时的 fetch。MV3 service worker 里 fetch 必须有超时——
// 无超时的 fetch 是「无响应无报错」三大成因之一（见项目铁律）。
async function fetchTimeout(url, options = {}, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, ms) {
  try {
    const r = await fetchTimeout(url, { method: 'GET', cache: 'no-store' }, ms);
    if (!r || !r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function postJson(url, body, ms) {
  try {
    const r = await fetchTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    }, ms);
    if (!r || !r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

// 探活。返回 { ok, service, version, notes, updatedAt } 或 null（不可达）。
// 走缓存：同一地址在 TTL 内不重复探。
export async function localHealth(settings, { force = false } = {}) {
  const base = localUrlOf(settings);
  if (!base) return null;
  const now = Date.now();
  if (!force && probeCache.url === base && now - probeCache.at < (probeCache.ok ? PROBE_OK_TTL : PROBE_FAIL_TTL)) {
    return probeCache.ok ? { ok: true, cached: true } : null;
  }
  const data = await getJson(base + '/health', 1200);
  const ok = !!(data && data.ok);
  probeCache = { url: base, at: now, ok };
  return ok ? data : null;
}

// 拉取服务端全量。返回 { notes, updatedAt } 或 null。
// 返回结构必须严格校验：mock/异常响应可能给出数组或别的形状，
// 那种情况一律当「不可用」，绝不能把脏数据合并进本地。
export async function localPull(settings, { timeoutMs = 8000 } = {}) {
  const base = localUrlOf(settings);
  if (!base) return null;
  const data = await getJson(base + '/notes', timeoutMs);
  if (!data || !data.notes || typeof data.notes !== 'object' || Array.isArray(data.notes)) return null;
  return { notes: data.notes, updatedAt: Number(data.updatedAt) || 0 };
}

// 推送本地全量到服务端（服务端按 updatedAt 做 LWW 合并）。
// 返回 { notes, updatedAt, merged } 或 null。
// 返回的 notes 是【合并后】的服务端全量——顺带把别的浏览器写的新内容带回来。
export async function localPush(settings, notes, { timeoutMs = 12000 } = {}) {
  const base = localUrlOf(settings);
  if (!base) return null;
  const payload = notes && typeof notes === 'object' ? notes : await getNotes();
  const data = await postJson(base + '/notes', { notes: payload }, timeoutMs);
  if (!data || !data.ok) return null;
  if (!data.notes || typeof data.notes !== 'object' || Array.isArray(data.notes)) {
    return { notes: null, updatedAt: Number(data.updatedAt) || 0, merged: Number(data.merged) || 0 };
  }
  return { notes: data.notes, updatedAt: Number(data.updatedAt) || 0, merged: Number(data.merged) || 0 };
}

// 清空服务端数据（物理抹掉）。返回 true/false。
// 注意：日常「清空笔记」流程不走这里——那需要写墓碑让其它浏览器也知道删除，
// 见 wipeLocalNotes。
export async function localWipe(settings, { timeoutMs = 8000 } = {}) {
  const base = localUrlOf(settings);
  if (!base) return false;
  const data = await postJson(base + '/wipe', {}, timeoutMs);
  return !!(data && data.ok);
}

// 把本地所有笔记以墓碑形式推到服务端，让删除能传播到其它浏览器。
// 与七牛的 wipeCloud 语义一致（云端清空 = 逐篇写墓碑 + 清索引，而不是抹掉）。
// 墓碑而不是直接清空的理由：直接清空会让「还没来得及拉取」的其它浏览器
// 永远拉不到删除信号，本地副本会留下来——数据复活。
//
// 墓碑要覆盖服务端上的【全部】笔记，不只是本浏览器本地有的那些：
// 服务端可能存着别的浏览器推来的笔记（本浏览器没有）——不写它们的墓碑，
// 那些笔记就会在别的浏览器下一次拉取时原样回来。做法：先读服务端全量，
// 与本地并集后逐篇写墓碑。
export async function wipeLocalNotes(settings, { timeoutMs = 15000 } = {}) {
  const base = localUrlOf(settings);
  if (!base) return false;
  const now = Date.now();
  const ids = new Set();
  // 本地笔记
  const local = await getNotes();
  for (const id of Object.keys(local || {})) ids.add(id);
  // 服务端已有笔记（别的浏览器推来的）
  try {
    const remote = await localPull(settings, { timeoutMs });
    if (remote && remote.notes) for (const id of Object.keys(remote.notes)) ids.add(id);
  } catch (_) { /* 读不到服务端就只覆盖本地那部分 */ }
  const tombs = {};
  for (const id of ids) {
    const n = local[id] || {};
    tombs[id] = {
      id,
      title: '',
      content: '',
      deleted: true,
      createdAt: Number(n.createdAt) || now,
      updatedAt: now,
    };
  }
  // 一篇都没有 → 仍要调一次：让服务端的 updatedAt 前移，其它浏览器下次拉取时
  // 能感知到「有人清过」（且不会因为这次调用产生任何墓碑条目）
  const data = await postJson(base + '/notes', { notes: tombs }, timeoutMs);
  return !!(data && data.ok);
}

// 状态留痕
async function writeStatus(patch) {
  try {
    const r = await chrome.storage.local.get(LOCAL_STATUS_KEY);
    const old = r[LOCAL_STATUS_KEY] || {};
    await chrome.storage.local.set({ [LOCAL_STATUS_KEY]: { ...old, ...patch } });
  } catch (_) { /* 状态只影响 UI，存储异常绝不阻断同步主流程 */ }
}

export async function readLocalStatus() {
  try {
    const r = await chrome.storage.local.get(LOCAL_STATUS_KEY);
    return r[LOCAL_STATUS_KEY] || {};
  } catch (_) { return {}; }
}

// 记录一次成功推送：at=时刻，through=本次覆盖到的最新本地 note.updatedAt
export async function markLocalOk(settings) {
  try {
    const notes = await getNotes();
    let through = 0;
    for (const n of Object.values(notes)) {
      const t = Number((n && n.updatedAt) || 0);
      if (t > through) through = t;
    }
    await writeStatus({ at: Date.now(), through, error: '', url: localUrlOf(settings) });
  } catch (_) { /* 同上 */ }
}

export async function markLocalFail(reason, settings) {
  try {
    await writeStatus({ error: String(reason || '未知错误'), url: localUrlOf(settings) });
  } catch (_) { /* 同上 */ }
}

// 探测缓存复位（设置页改地址后调用；否则旧地址的探测结果会被误用）
export function resetLocalProbe() {
  probeCache = { url: '', at: 0, ok: false };
}
