// 实时快照通道（v0.5.28）：绕开七牛 CDN 的一年缓存，让「A 推送 → B 秒级可见」
//
// ===== 为什么需要这条通道（2026-11-27 六轮真云实证）=====
// 七牛测试域名对私有对象返回 `cache-control: public, max-age=31536000`（缓存 1 年），
// 且【按路径缓存、覆盖写不触发边缘失效】：表单上传实时写源站成功，但下游读同一
// 个固定 key 命中边缘缓存副本（x-response-cache: edge_hit / TCP_HIT，连 etag 都
// 还是旧值）。旧同步通道的三个 key 全是固定名、且都是覆盖写：
//     notes/index.json   （索引，覆盖写）
//     notes/<id>.json    （单篇正文，覆盖写）
//     notes/changelog.json
// 于是 A 推完、B 拉取拿到的是一年前的缓存副本——「拉取确实触发了，但读到旧索引
// 就判断无变更」，看起来像没同步。实测各边缘节点刷新延迟 >3.5 分钟且无保证，
// 不同集群进度还不一致。
//
// 已实测**全部无效**的破缓存手段（勿再试）：私有 URL 加随机参数重签（鉴权 200
// 通过仍旧内容）、Cache-Control: no-cache / Pragma / max-age=0、If-Modified-Since
// / If-None-Match:*（直接 304）、Range: bytes=0-（首次能拿新内容，但 206 同样被
// 按路径缓存）、上传侧设 x-qn-meta-Cache-Control（CDN 强制覆盖成 1 年）、
// 融合 CDN 刷新接口（401 bad token，且刷新本就异步，做不到「马上」）。
//
// ===== 唯一必然实时的免费通道 =====
// 每次写一个【全新 key】——CDN 从未缓存过 → TCP_MISS → 必然回源 → 拿到最新内容。
// 配套依赖均已实证可用：
//   - rsf list 实时（刚上传的 key 立刻可见，实测列举耗时 193ms）
//   - rs delete 可用（POST /delete/<enc(bucket:key)>，QBox 签名串 = path + '\n'，
//     返回 200；此前记录的「delete 401」是签名/host 用错）
//
// ===== 通道设计 =====
//   写：推送成功后额外写一份【全量笔记快照】到 notes/live/live-<ms>-<rand>.json
//       （全新 key = 必然回源）。实测真实数据全量仅 12KB（9 篇），成本极低。
//   读：列举 notes/live/ 前缀 → 按 putTime 降序取最新 → 下载该全新 key（一次 GET
//       拿到全部正文，不做旧通道那种「索引 + 逐篇下载」的 N+1 次缓存请求）
//   并：仍按 LWW（updatedAt）合并，语义与旧通道完全一致；不删本地独有笔记
//   清：每次推送后清理旧快照，只保留最近 3 份（并跳过 60 秒内的新文件，避免
//       删掉另一台浏览器刚写的）；清空（wipeCloud）时必须一并删除，否则拉取
//       会把清空前的数据复活
//   兜底：实时通道不可用（列举失败 / 无快照 / 下载失败）时，自动回退旧 CDN
//       通道（notes/index.json + notes/<id>.json），行为退化为「最终一致」
import { getNotes } from './storage.js';
import { uploadJson, downloadJson, listKeys, deleteObject } from './qiniu.js';

export const LIVE_PREFIX = 'notes/live/';
// 云端保留份数：≥2 才能容忍「另一台浏览器刚写的快照被本机清理规则误删」，
// 取 3 留一层余量（删除只针对更旧的文件，不会误删最新那份）
const LIVE_KEEP = 3;
// 清理保护期：60 秒内写入的快照一律不删（多浏览器并发推送时对方可能正在读）
const LIVE_PROTECT_MS = 60 * 1000;
// 「内容未变则跳过写入」的有效窗口。窗口内不重复产生对象（点刷新/关窗很频繁）；
// 超过窗口仍会补写一份，防止云端快照被别人清理掉后本地指纹让通道永久失效。
const SKIP_WINDOW_MS = 5 * 60 * 1000;
// rsf /list 的 limit 上限 1000。实测 rsf 按 key 字典序升序返回、limit 截断取
// 【最旧】的 N 个——所以必须给足 limit 再本地按 putTime 倒序，否则会拿到最旧的
// 那几份而不是最新的。本通道每次推送后清理到 ≤3 份，1000 有 300 倍余量。
const LIVE_LIST_LIMIT = 1000;

// 状态留痕（设置页展示 + 排查用）：{ pushAt, pushKey, pullMode, pullAt, error }
// pullMode: 'live' = 实时通道命中；'fallback' = 回退旧 CDN 通道；'' = 未知
const LIVE_STATUS_KEY = 'liveSyncStatus';

async function writeStatus(patch) {
  try {
    const r = await chrome.storage.local.get(LIVE_STATUS_KEY);
    const old = r[LIVE_STATUS_KEY] || {};
    await chrome.storage.local.set({ [LIVE_STATUS_KEY]: { ...old, ...patch } });
  } catch (_) { /* 状态只影响 UI，存储异常绝不阻断同步主流程 */ }
}

export async function readLiveStatus() {
  try {
    const r = await chrome.storage.local.get(LIVE_STATUS_KEY);
    return r[LIVE_STATUS_KEY] || {};
  } catch (_) { return {}; }
}

// djb2 指纹：用于「内容没变就不重复写快照」，避免每次点刷新/关窗都产生新对象
function fingerprint(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + str.length;
}

// 写一份全量快照到全新 key。返回 {at, key, n}；跳过时返回 null。
// 跳过条件：无 ak / 本地笔记为空（与 backupRecent 同款理由：空本地视图不该
// 覆写云端更完整的内容）/ 内容指纹与上次相同且上次写入在 SKIP_WINDOW 内
// （避免每次点刷新/关窗都产生新对象；但超过窗口仍会补写一份，防止云端快照
//  被别处清理掉后、本地指纹却让通道永久失效）。
export async function writeLiveSnapshot(settings, notes) {
  if (!settings || !settings.ak) return null;
  const all = notes || (await getNotes());
  const ids = Object.keys(all || {});
  if (ids.length === 0) return null;
  const body = JSON.stringify(all);
  const fp = fingerprint(body);
  const now = Date.now();
  let lastFp = null, lastAt = 0;
  try {
    const r = await chrome.storage.local.get(['liveSnapshotFingerprint', 'liveSnapshotAt']);
    lastFp = r.liveSnapshotFingerprint;
    lastAt = Number(r.liveSnapshotAt) || 0;
  } catch (_) { /* 读不到指纹就照写 */ }
  if (lastFp === fp && now - lastAt < SKIP_WINDOW_MS) return null;
  const at = now;
  // 随机后缀：同一毫秒内多台设备/多次推送不会撞成同一个 key（撞了会互相覆盖，
  // 覆盖写又会被 CDN 缓存住——那正是本通道要绕开的东西）
  const rand = Math.random().toString(36).slice(2, 8) + at.toString(36);
  const key = `${LIVE_PREFIX}live-${at}-${rand}.json`;
  await uploadJson(key, { at, notes: all }, settings);
  try {
    await chrome.storage.local.set({
      liveSnapshotFingerprint: fp,
      liveSnapshotAt: at,
    });
  } catch (_) { /* 指纹写失败只导致下次多写一份，无害 */ }
  await writeStatus({ pushAt: at, pushKey: key, error: '' });
  return { at, key, n: ids.length };
}

// 列举通道内的快照，按 putTime 倒序（新的在前）。
// 注意 rsf 返回的 putTime 是 100ns 单位，数值大小关系与时间先后一致。
export async function listLiveSnapshots(settings) {
  if (!settings || !settings.ak) return [];
  const raw = await listKeys(settings.ak, settings.sk, {
    bucket: settings.bucket,
    prefix: LIVE_PREFIX,
    limit: LIVE_LIST_LIMIT,
    region: settings.region,
  });
  const arr = (Array.isArray(raw) ? raw : (raw.items || [])).slice();
  arr.sort((a, b) => (Number(b.putTime) || 0) - (Number(a.putTime) || 0));
  return arr;
}

// 拉取最新快照内容。返回 {at, notes} 或 null（无快照/列举失败/下载失败）。
// 依次尝试最新的几份：最新那份可能刚被另一台浏览器清理掉。
export async function pullLiveSnapshot(settings) {
  let snaps;
  try {
    snaps = await listLiveSnapshots(settings);
  } catch (_) {
    await writeStatus({ pullMode: 'fallback', error: '列举实时快照失败' });
    return null;
  }
  if (!snaps.length) {
    await writeStatus({ pullMode: 'fallback', error: '' });
    return null;
  }
  for (const s of snaps.slice(0, 3)) {
    try {
      const data = await downloadJson(s.key, settings);
      if (data && data.notes && typeof data.notes === 'object') {
        await writeStatus({ pullMode: 'live', pullAt: Date.now(), error: '' });
        return data;
      }
    } catch (_) { /* 试下一份 */ }
  }
  await writeStatus({ pullMode: 'fallback', error: '实时快照下载失败' });
  return null;
}

// 按 LWW（updatedAt）把远端全量快照合并进本地。
// 语义与旧 pullSync 逐条合并保持一致：
//   - 远端更新（updatedAt 更大）→ 采用远端
//   - 远端是墓碑 → 保留本地正文、只打 deleted 标记（与旧通道一致）
//   - 本地独有的笔记不删（旧通道也不删）
// 返回 {notes, changed}
export async function mergeLiveNotes(remoteNotes) {
  const local = await getNotes();
  const merged = { ...local };
  let changed = false;
  for (const [id, remote] of Object.entries(remoteNotes || {})) {
    if (!remote || typeof remote !== 'object') continue;
    const localNote = local[id];
    const rAt = Number(remote.updatedAt) || 0;
    const lAt = Number(localNote && localNote.updatedAt) || 0;
    if (localNote && !(rAt > lAt)) continue;      // 本地更新 → 保留本地
    if (remote.deleted) {
      if (localNote && !localNote.deleted) {
        merged[id] = { ...localNote, deleted: true };
        changed = true;
      }
      continue;                                   // 本地没有这篇 → 不凭空造墓碑
    }
    merged[id] = remote;
    changed = true;
  }
  return { notes: merged, changed };
}

// 清理旧快照：只保留最近 LIVE_KEEP 份，且跳过保护期（60 秒）内的新文件。
// 返回删除数量。清理失败不影响主流程（空间会缓慢增长，但不影响功能）。
export async function cleanupLiveSnapshots(settings, keep = LIVE_KEEP) {
  if (!settings || !settings.ak) return 0;
  let snaps;
  try {
    snaps = await listLiveSnapshots(settings);
  } catch (_) { return 0; }
  if (snaps.length <= keep) return 0;
  const nowUnits = Date.now() * 10000;            // 当前时刻的 100ns 单位
  let removed = 0;
  for (const s of snaps.slice(keep)) {
    try {
      // 保护期内的文件不删：可能是另一台浏览器刚推的、对方正在读
      if (nowUnits - (Number(s.putTime) || 0) < LIVE_PROTECT_MS * 10000) continue;
      await deleteObject(s.key, settings);
      removed++;
    } catch (_) { /* 单个失败不影响其余 */ }
  }
  return removed;
}

// 清空（wipeCloud）时一并删除通道内全部快照。
// 漏了这一步的后果很严重：云端索引/笔记已清空，但 live 快照里还留着清空前的
// 正文，拉取时会被当成「远端最新」合并回来——数据复活。
//
// 注意：这里【只删云端对象，不碰本地 storage】。本地指纹/状态键由
// runOneTimeWipe 的那一次 chrome.storage.local.remove 统一清理——
// 「清空全程只 remove 一次」是 oneTimeWipe 竞态守卫的核心不变式
// （并发触发时两次 remove(['notes']) 交叉执行，会删掉用户刚写入的笔记，
// 见 k-wipe-race B1/B2/B3）。在这里额外 remove 一次会打破该不变式。
export async function wipeLiveSnapshots(settings) {
  if (!settings || !settings.ak) return 0;
  let snaps;
  try {
    snaps = await listLiveSnapshots(settings);
  } catch (_) { return 0; }
  let removed = 0;
  for (const s of snaps) {
    try {
      await deleteObject(s.key, settings);
      removed++;
    } catch (_) { /* 继续删下一个 */ }
  }
  return removed;
}
