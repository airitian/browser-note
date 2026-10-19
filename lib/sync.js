// 同步引擎：异步后台、仅最终态、防抖折叠、失败重试、LWW 合并
import { getNotes, getNote, getSettings } from './storage.js';
import { uploadJson, downloadJson } from './qiniu.js';

let timer = null;
const pending = new Set();

async function pushNote(id, settings) {
  const note = await getNote(id);
  if (!note) return;
  await uploadJson('notes/' + id + '.json', note, settings);
}

async function pushIndex(settings) {
  const notes = await getNotes();
  const local = Object.values(notes).map((n) => ({
    id: n.id,
    title: n.title,
    updatedAt: n.updatedAt,
    deleted: !!n.deleted,
  }));
  // 本地索引直接覆盖云端（单一用户工具：以本地为权威来源）。
  // 曾经的"与云端并集合并"会导致本地删除/清永远无法生效——
  // 本地清空后任何一次同步都会把云端旧索引合并回来，数据反复复活，已废弃
  await uploadJson('notes/index.json', local, settings);
}

// 停输 800ms 后，将本次改动涉及的笔记 + 索引一起直传（最终态）
export function scheduleSync(noteId, settings, statusCb) {
  if (!settings || !settings.ak) {
    statusCb && statusCb('local');
    return;
  }
  pending.add(noteId);
  statusCb && statusCb('syncing');
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ids = [...pending];
    pending.clear();
    runSyncIds(ids, settings, statusCb);
  }, 800);
}

async function runSyncIds(ids, settings, statusCb) {
  try {
    for (const id of ids) await pushNote(id, settings);
    await pushIndex(settings);
    statusCb && statusCb('synced');
  } catch (e) {
    statusCb && statusCb('error', e.message);
    // 保留 pending 以便下次编辑时重试
  }
}

// 立即把全部本地笔记 + 索引推上去
export async function pushAll(settings, statusCb) {
  if (!settings || !settings.ak) {
    statusCb && statusCb('local');
    return;
  }
  try {
    const notes = await getNotes();
    for (const id of Object.keys(notes)) await pushNote(id, settings);
    await pushIndex(settings);
    statusCb && statusCb('synced');
  } catch (e) {
    statusCb && statusCb('error', e.message);
  }
}

// 从远端拉取索引并与本地按 updatedAt 合并（LWW，完全静默）
export async function pullSync(settings, onMerged) {
  if (!settings || !settings.ak) return;
  let index;
  try {
    index = await downloadJson('notes/index.json', settings);
  } catch (_) {
    return; // 远端尚无索引，跳过
  }
  if (!Array.isArray(index)) return;
  const local = await getNotes();
  const merged = { ...local };
  let changed = false;
  for (const entry of index) {
    const localNote = local[entry.id];
    if (!localNote || entry.updatedAt > localNote.updatedAt) {
      if (entry.deleted) {
        if (localNote && !localNote.deleted) {
          merged[entry.id] = { ...localNote, deleted: true };
          changed = true;
        }
        continue;
      }
      let remoteNote = null;
      try {
        remoteNote = await downloadJson('notes/' + entry.id + '.json', settings);
      } catch (_) {
        continue; // 云端笔记文件缺失（孤儿索引条目）：跳过，不影响其他笔记同步
      }
      if (!remoteNote || !remoteNote.id) continue;
      merged[entry.id] = remoteNote;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ notes: merged });
    onMerged && onMerged();
  }
}

// 变更记录：只存七牛云，本地不持久化。每次变更追加并保留最近 50 条（展示取最后 10 条）
export async function recordChange(settings, entry) {
  if (!settings || !settings.ak) return;
  let log = [];
  try {
    log = await downloadJson('notes/changelog.json', settings);
    if (!Array.isArray(log)) log = [];
  } catch (_) {
    // 远端尚无记录
  }
  log.push(entry);
  if (log.length > 50) log = log.slice(-50);
  await uploadJson('notes/changelog.json', log, settings);
}

// 拉取最近 10 条变更记录（新→旧）
export async function fetchChangelog(settings) {
  if (!settings || !settings.ak) return null;
  try {
    const log = await downloadJson('notes/changelog.json', settings);
    return Array.isArray(log) ? log.slice(-10).reverse() : [];
  } catch (_) {
    return [];
  }
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 每日备份：只备份近 days 天的笔记，存到七牛 backups/<日期>.json（本地不落盘）
export async function backupRecent(settings, days = 7) {
  if (!settings || !settings.ak) return;
  const notes = await getNotes();
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = Object.values(notes).filter((n) => (n.updatedAt || 0) >= cutoff);
  const data = { date: dateStamp(), days, notes: recent };
  await uploadJson('backups/' + dateStamp() + '.json', data, settings);
}

// 打开应用时兜底：距上次备份 >24h 则补一次，确保即使定时任务错过也基本一致
export async function maybeBackup(settings) {
  if (!settings || !settings.ak) return;
  const r = await chrome.storage.local.get('lastBackup');
  const last = r.lastBackup || 0;
  if (Date.now() - last > 24 * 3600 * 1000) {
    await backupRecent(settings, 7);
    await chrome.storage.local.set({ lastBackup: Date.now() });
  }
}

// ===== 一次性彻底清空（v0.3.0 重置专用，本地 + 云端）=====
export const WIPE_STAMP = 'v0.3.1';

// 云端清空：索引/变更记录/当日备份覆写为空数组，各笔记文件打成墓碑。
// 管理 API 对该密钥无删除权限（401），无法物理删文件，只能覆写——
// 索引清空后 pullSync 永远不会再拉回任何文件，功能上等于彻底清空。
export async function wipeCloud(settings) {
  if (!settings || !settings.ak) return;
  let ids = [];
  try {
    const idx = await downloadJson('notes/index.json', settings);
    if (Array.isArray(idx)) ids = idx.map((e) => e && e.id).filter(Boolean);
  } catch (_) {
    // 云端无索引
  }
  const now = Date.now();
  for (const id of ids) {
    await uploadJson('notes/' + id + '.json', { id, title: '', content: '', deleted: true, updatedAt: now }, settings);
  }
  await uploadJson('notes/index.json', [], settings);
  await uploadJson('notes/changelog.json', [], settings);
  const stamp = dateStamp();
  await uploadJson('backups/' + stamp + '.json', { date: stamp, days: 7, notes: [] }, settings);
}

// 一次性重置：本地 + 云端全部清空，带版本戳，每个版本只执行一次。
// 语义（全部成功或整体不变）：
//   - 云端清理失败会抛错 → 不落戳、不清本地，下次启动自动重试；
//     防止"本地清了、云端没清"导致下次开机数据从云端复活
//   - 未配置七牛（无 ak）时只清本地
// 并发串行化（2026-10-17 修启动竞态）：
//   调用方曾有三处且分属两个 JS 上下文——SW 的 onInstalled(update)、onStartup，
//   以及弹窗/大窗启动 IIFE（页面侧另开一个 sync.js 模块实例，互不可见）。
//   并发触发时两个上下文各跑一遍完整清空，两次 remove(['notes']) 交叉执行，
//   后落地的那次会把用户刚写入的笔记删掉（症状：新建笔记启动后莫名消失）。
//   现改为：本函数带 in-flight 守卫，同上下文内并发调用共享同一个 promise；
//   跨上下文由 SW 收口——页面发 'one-time-wipe' 消息给 SW 执行（background.js），
//   SW 是唯一执行者，三个触发点天然串行，页面侧不再直跑。
let wipeInFlight = null;

export function oneTimeWipe() {
  if (wipeInFlight) return wipeInFlight;
  wipeInFlight = runOneTimeWipe().finally(() => { wipeInFlight = null; });
  return wipeInFlight;
}

async function runOneTimeWipe() {
  // 闸门加固（P1 数据丢失修复）：销毁动作曾只由一次 storage.get 把门，
  // 而 SW 冷启动/存储后端初始化窗口的读取会【瞬时漏戳】——QA 实证：戳已落盘
  // 600ms 且从未被移除，get 却返回空 → 误判"未清过" → 把用户当期笔记和原图
  // 全部清掉（重载页 1/5 概率复现，storage.onChanged 全程取证）。
  // 漏读无法从单次返回值区分"真没有"和"没读到"，改用三重验证：
  //   1) 交叉验证：resetStamp 与 resetStampAt 只由本函数末尾 / onInstalled
  //      的同一个 set({resetStamp, resetStampAt}) 原子写入，也从不被单独 remove
  //      ——"有 At 无 Stamp"在物理上只可能是一次漏读，直接放弃本次清空；
  //   2) 整区漏读（两个键都没有）时单次读同样无法区分，隔 100ms 二次确认，
  //      第二次读到戳（或同样的漏读特征）同样放弃；
  //   3) 页面侧（main.js 启动 IIFE）已先自查戳，已打戳根本不会发消息过来。
  // 正常已打戳用户首读即命中，无感；只有未打戳/漏读路径付出 100ms 代价
  const r = await chrome.storage.local.get(['resetStamp', 'resetStampAt']);
  if (r.resetStamp === WIPE_STAMP) return false;
  if (r.resetStampAt && !r.resetStamp) {
    console.warn('[browser-note] oneTimeWipe：检测到漏读戳（有 resetStampAt 无 resetStamp），'
      + '判定为瞬时漏读而非未清过，跳过本次清空（防止误清活数据）');
    return false;
  }
  await new Promise((res) => setTimeout(res, 100));
  const r2 = await chrome.storage.local.get(['resetStamp', 'resetStampAt']);
  if (r2.resetStamp === WIPE_STAMP || (r2.resetStampAt && !r2.resetStamp)) {
    console.warn('[browser-note] oneTimeWipe：二次确认读到戳，判定首次整区漏读，跳过本次清空');
    return false;
  }
  const settings = await getSettings();
  if (settings && settings.ak) await wipeCloud(settings);
  await chrome.storage.local.remove(['notes', 'lastBackup', 'windowBounds', 'appWinId']);
  // resetStampAt 记录清空时刻：弹窗启动时若发现刚清空不久（<10min），跳过云端拉取——
  // CDN 边缘节点在覆写后仍会 Serve 陈旧副本（实测墓碑笔记被旧缓存原样拉回），
  // 在清空后的首次打开里拉云只会让旧数据复活。
  // 注意：与 resetStamp 同一个 set 原子写入——闸门的交叉验证依赖此不变式
  await chrome.storage.local.set({ resetStamp: WIPE_STAMP, resetStampAt: Date.now() });
  return true;
}
