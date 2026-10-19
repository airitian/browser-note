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
    // 首次推送前必须已拉取过（ensurePulled）：没拉过就推会把云端索引
    // 覆写成本地子集（本地权威覆盖语义），其余笔记文件沦为孤儿
    if (!(await ensurePulled(settings))) {
      statusCb && statusCb('error', '首次拉取未完成，已暂停推送');
      return;
    }
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
  // 同 runSyncIds：未拉取过的浏览器禁止全量推送（防索引覆写）
  if (!(await ensurePulled(settings))) {
    statusCb && statusCb('error', '首次拉取未完成，已暂停推送');
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

// 从远端拉取索引并与本地按 updatedAt 合并（LWW，完全静默）。
// 返回值（供「未拉取过的浏览器禁止推送」闸门判定，见 ensurePulled）：
//   'ok'    已合并（无论是否有变更）
//   'empty' 云端无索引（404，全新用户）——没东西可拉，推送安全
//   'error' 远端不可达/内容非法——不可标记为已拉取
export async function pullSync(settings, onMerged) {
  if (!settings || !settings.ak) return 'error';
  let index;
  try {
    index = await downloadJson('notes/index.json', settings);
  } catch (e) {
    // 404 = 云端还没有索引（全新用户）：remote 可达、无数据可拉；
    // 其余（网络失败/403/5xx/域名错）一律视为未拉取
    return /404/.test(String((e && e.message) || e)) ? 'empty' : 'error';
  }
  if (!Array.isArray(index)) return 'error';
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
  return 'ok';
}

// 推送闸门（跨浏览器数据安全）：「本地权威覆盖」语义下，一个从未拉取过云端
// 数据的浏览器一旦推送（关页面 flush-sync / 手动保存 / 停输 scheduleSync），
// 就会把云端索引覆写成自己的本地子集——其余笔记文件沦为孤儿（文件还在七牛，
// 但索引不再引用，同步再也拉不回来；其他浏览器本地副本不受影响，pull 不删本地）。
// 因此任何推送前都确保已成功拉取过：有 lastPullAt 直接放行；没有则先拉一次，
// 拉取可达（'ok'/'empty'）才落 lastPullAt 并放行，不可达（'error'）则暂停本次推送
async function ensurePulled(settings) {
  const p = await chrome.storage.local.get('lastPullAt');
  if (p.lastPullAt) return true;
  const st = await pullSync(settings);
  if (st === 'error') return false;
  await chrome.storage.local.set({ lastPullAt: Date.now() });
  return true;
}

// 变更记录：只存七牛云，本地不持久化。每次变更追加并保留最近 50 条（展示取最后 10 条）
export async function recordChange(settings, entry) {
  if (!settings || !settings.ak) return;
  // 闸门：从未成功拉取过的浏览器不写云端（本地视图不完整，日志会缺前史）
  if (!(await ensurePulled(settings))) return;
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
  // 闸门：从未成功拉取过的浏览器不写云端——它的本地视图不完整，这份备份会
  // 覆写云端更完整的当天备份（SW 定时备份路径也由此兜底）
  if (!(await ensurePulled(settings))) return;
  const notes = await getNotes();
  // 本地整个为空（如清空后）：不覆写云端备份——否则会把当天
  // 其他浏览器刚备份的好数据打成空文件（前几天的备份文件会幸存，但当天丢失）
  if (Object.keys(notes).length === 0) return;
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

// ===== 小时级快照与手动回退（v0.5.14）=====
// 痛点：误删/误改后想回到几个小时前的状态。每日 backups/<日期>.json 粒度太粗，
// 且只含近 7 天改动过的笔记（不是完整视图），承担不了"回退"职责。
// 设计：
//   - SW 每小时（alarm 'hourlySnapshot'）+ 浏览器启动补跑，把【全量笔记】
//     （含墓碑——回退需要完整视图）存到 snapshots/<auto|manual>-<时间>.json；
//   - snapshots/index.json 维护可选列表（at/key/auto/条数），保留 7 天。
//     七牛管理 API 对该密钥无删除权限（401），旧文件物理留存，只能控制可选范围；
//   - 写快照与备份同款闸门：没成功拉取过不写（本地视图不完整）、本地为空不写；
//   - 回退 rollbackTo：先把当前状态存成手动快照（安全网，可再回退回来）→
//     本地替换为快照内容（updatedAt 统一推到当前时刻——回退是权威重置而非
//     时间倒流，确保其他浏览器下次拉取时按 LWW 采用这个状态）→ 快照之后
//     新建的笔记补墓碑一并推送（删除传播）→ 全量推送 → 变更记录留痕。
// 多浏览器语义：回退以本浏览器为准推向云端；其他浏览器下次拉取时按 LWW
// 采用（较新时间戳/墓碑压过其本地副本）。两端同时编辑的冲突不在管辖内
// （后推送者赢，既定代价）。
const SNAP_INDEX_KEY = 'snapshots/index.json';
const SNAP_KEEP_MS = 7 * 24 * 3600 * 1000; // 索引保留 7 天

// 快照键时间戳：精确到秒。同一分钟内创建两份手动快照（如回退后马上又建）
// 必须落在不同键上，否则后一份会覆写前一份——「可再回退回来」的安全网
// 就是这么丢的。自动快照整点触发，秒位恒为 00，不影响可读性
function snapStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 创建全量快照。返回 {at, key, auto, n}；跳过条件（无 ak / 未拉取过 /
// 本地为空）返回 null；上传失败抛错（调用方决定降级：SW 侧静默，回退侧中止）
export async function createSnapshot(settings, { auto = true } = {}) {
  if (!settings || !settings.ak) return null;
  // 闸门：从未成功拉取过的浏览器不写云端——它的本地视图不完整，这份快照
  // 会覆写云端更完整的同一小时快照（与 backupRecent 同款理由）
  if (!(await ensurePulled(settings))) return null;
  const notes = await getNotes();
  if (Object.keys(notes).length === 0) return null;
  const at = Date.now();
  const key = `snapshots/${auto ? 'auto' : 'manual'}-${snapStamp(new Date(at))}.json`;
  await uploadJson(key, { at, auto, notes }, settings);
  await updateSnapIndex(settings, { at, key, auto, n: Object.keys(notes).length });
  await chrome.storage.local.set({ lastSnapshotAt: at });
  return { at, key, auto, n: Object.keys(notes).length };
}

// 快照索引：追加 + 时间倒序 + 剪掉超保留期条目。读-改-写存在多浏览器竞争
// （后写赢，可能丢另一浏览器刚追加的条目）——快照文件按分钟命名、内容不可变，
// 最坏损失是索引少一条，可接受；不上锁（个人工具，七牛也无 CAS 原语）
async function updateSnapIndex(settings, entry) {
  let idx = [];
  try {
    const cur = await downloadJson(SNAP_INDEX_KEY, settings);
    if (Array.isArray(cur)) idx = cur;
  } catch (_) { /* 云端尚无索引 */ }
  idx.push(entry);
  const cutoff = Date.now() - SNAP_KEEP_MS;
  idx = idx.filter((e) => e && e.at >= cutoff).sort((a, b) => b.at - a.at);
  await uploadJson(SNAP_INDEX_KEY, idx, settings);
}

// 可选快照列表（新→旧）。拉取失败返回 []（UI 展示空态）
export async function listSnapshots(settings) {
  if (!settings || !settings.ak) return [];
  try {
    const idx = await downloadJson(SNAP_INDEX_KEY, settings);
    return Array.isArray(idx) ? idx : [];
  } catch (_) {
    return [];
  }
}

// 回退到指定快照（at 为快照时间戳）。返回 {restored, tombstoned, safetyAt}。
// 任一前置失败（快照不存在/下载失败/内容损坏/安全快照创建失败）都抛错，
// 且本地数据保持原样——回退是破坏性操作，宁可中止不可半吊子
export async function rollbackTo(settings, at) {
  if (!settings || !settings.ak) throw new Error('未配置七牛同步，无法回退');
  const idx = await listSnapshots(settings);
  const entry = idx.find((e) => e.at === at);
  if (!entry) throw new Error('快照不存在或已超过保留期');
  let snap;
  try {
    snap = await downloadJson(entry.key, settings);
  } catch (_) {
    throw new Error('快照文件下载失败');
  }
  if (!snap || !snap.notes || typeof snap.notes !== 'object') throw new Error('快照内容损坏');
  // 安全网：当前状态先存手动快照。本地为空时 createSnapshot 返回 null——
  // 无东西可保，放行；本地非空却没建成（闸门未过/上传失败）→ 中止回退，
  // 宁可推不回去，不可把用户当前数据裸奔替换掉。上传异常归一成一句人话，
  // UI 直接展示，不暴露底层 fetch 错误
  let safety = null;
  try {
    safety = await createSnapshot(settings, { auto: false });
  } catch (e) {
    throw new Error('无法创建安全快照（' + ((e && e.message) || e) + '），已取消回退');
  }
  const current = await getNotes();
  if (!safety && Object.keys(current).length > 0) {
    throw new Error('无法创建安全快照，已取消回退（当前数据未改动）');
  }
  const now = Date.now();
  const restored = {};
  for (const [id, n] of Object.entries(snap.notes)) {
    if (!n || typeof n !== 'object') continue;
    restored[id] = { ...n, updatedAt: now };
  }
  let tombstoned = 0;
  for (const [id, n] of Object.entries(current)) {
    // 快照之后新建的笔记：补墓碑随回退推送一起传播删除（其他浏览器 LWW 采用）
    if (!snap.notes[id]) {
      restored[id] = {
        id, title: '', content: '', deleted: true,
        createdAt: n.createdAt || now, updatedAt: now,
      };
      tombstoned++;
    }
  }
  await chrome.storage.local.set({ notes: restored });
  for (const id of Object.keys(restored)) await pushNote(id, settings);
  await pushIndex(settings);
  await recordChange(settings, {
    type: 'rollback', at: entry.at, t: now,
    restored: Object.keys(snap.notes).length, tombstoned,
  });
  return { restored: Object.keys(snap.notes).length, tombstoned, safetyAt: safety ? safety.at : null };
}

// ===== 一次性彻底清空（v0.3.0 重置专用，本地 + 云端）=====
export const WIPE_STAMP = 'v0.3.1';

// 云端清空：索引/变更记录/快照索引覆写为空数组，各笔记文件打成墓碑。
// 管理 API 对该密钥无删除权限（401），无法物理删文件，只能覆写——
// 索引清空后 pullSync 永远不会再拉回任何文件，功能上等于彻底清空。
// 快照索引（snapshots/index.json）一并清空：小时级快照文件物理删不掉，
// 但清掉索引后回退 UI 无列表可选，"清空"在用户视角才是彻底的
// （snapshots/*.json 文件残留在空间里，只是再也无法通过界面触达）
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
  await uploadJson(SNAP_INDEX_KEY, [], settings);
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
//   跨上下文由 SW 收口——页面发 'one-time-wipe' 消息给 SW（background.js），
//   SW 是唯一执行者，三个触发点天然串行，页面侧不再直跑。
let wipeInFlight = null;

export function oneTimeWipe() {
  if (wipeInFlight) return wipeInFlight;
  wipeInFlight = runOneTimeWipe().finally(() => { wipeInFlight = null; });
  return wipeInFlight;
}

// P1 修复（2026-10-18，读漏戳误清活数据）：background.js 的 'one-time-wipe'
// 消息处理器【只等待、不触发】——清空执行权收敛到 SW 的 onInstalled(update)/
// onStartup 两个生命周期事件，页面加载不再触发清空（旧语义是漏戳误清的放大面：
// 任一次页面加载读漏即清空当期活数据，QA 实证 1/5 概率）。
// 本导出供该处理器查询"是否有清空正在飞行中"：有则返回其 promise（调用方
// 挂 .then 等完成，共享 in-flight 守卫不会二次执行）；没有则返回 null
export function awaitWipeIfRunning() {
  return wipeInFlight;
}

// 四层防护（P1 修复，全部落实）——
//   1) 双读确认：首读缺戳 → 等 150ms 再读，两次都缺戳才继续；任一次读到戳即放弃。
//      另加交叉验证：resetStamp 与 resetStampAt 只由本函数末尾 / onInstalled 的
//      同一个 set({resetStamp, resetStampAt}) 原子写入、也从不被单独 remove——
//      "有 At 无 Stamp"在物理上只可能是一次漏读（正是 QA 取证中事发的存储状态），
//      同样放弃。宁可晚清，不可误清。
//   2) 销毁前最后一道闸：wipeCloud（可能耗时数秒）完成之后、本地 remove 之前
//      再读一次戳——期间其他上下文可能刚补写戳，读到即放弃本地销毁。
//   3) 触发入口收敛：'one-time-wipe' 消息只等待不触发（见 background.js 与
//      awaitWipeIfRunning），执行权只在 SW 生命周期事件。
//   4) 清空前本地快照 preWipeSnapshot（仅本地、永不上云、不自动恢复）：
//      万一前三层全部失守，按下方注释里的控制台片段可手工恢复。
// 误清恢复（DevTools 控制台执行）：
//   (async () => {
//     const s = (await chrome.storage.local.get('preWipeSnapshot')).preWipeSnapshot;
//     if (!s) { console.log('无快照可恢复'); return; }
//     await chrome.storage.local.set({ notes: s.notes || {}, ...(s.imgs || {}) });
//     await chrome.storage.local.remove('preWipeSnapshot');
//     console.log('已恢复', Object.keys(s.notes || {}).length, '条笔记、',
//       Object.keys(s.imgs || {}).length, '张原图');
//   })();
async function runOneTimeWipe() {
  // 第 1 层：双读确认（+ 交叉验证）。SW 冷启动/存储后端初始化窗口的读取会瞬时
  // 漏戳，单次返回值无法区分"真没有"和"没读到"——两次都缺戳才允许继续。
  // 正常已打戳用户首读即命中，无感；只有未打戳/漏读路径付出 150ms 代价
  const r = await chrome.storage.local.get(['resetStamp', 'resetStampAt']);
  if (r.resetStamp === WIPE_STAMP) return false;
  if (r.resetStampAt && !r.resetStamp) {
    console.warn('[browser-note] oneTimeWipe：检测到漏读戳（有 resetStampAt 无 resetStamp），'
      + '判定为瞬时漏读而非未清过，跳过本次清空（防止误清活数据）');
    return false;
  }
  await new Promise((res) => setTimeout(res, 150));
  const r2 = await chrome.storage.local.get(['resetStamp', 'resetStampAt']);
  if (r2.resetStamp === WIPE_STAMP) return false;
  if (r2.resetStampAt && !r2.resetStamp) {
    console.warn('[browser-note] oneTimeWipe：二次确认仍为漏读签名（有 At 无 Stamp），跳过本次清空');
    return false;
  }
  const settings = await getSettings();
  if (settings && settings.ak) await wipeCloud(settings);
  // 第 2 层：销毁前最后一道闸。云端清理可能耗时数秒，期间其他上下文可能刚补写戳
  const r3 = await chrome.storage.local.get(['resetStamp', 'resetStampAt']);
  if (r3.resetStamp === WIPE_STAMP) {
    console.warn('[browser-note] oneTimeWipe：本地销毁前读到戳（其他上下文已清过），放弃本地销毁');
    return false;
  }
  if (r3.resetStampAt && !r3.resetStamp) {
    console.warn('[browser-note] oneTimeWipe：本地销毁前检测到漏读戳，放弃本地销毁');
    return false;
  }
  // 第 4 层：清空前本地快照（安全网）。扩展无 unlimitedStorage，storage.local
  // 默认 10MB 配额，快照写入可能 QUOTA_EXCEEDED——失败时静默跳过：
  // 快照是保险不是闸门，绝不阻断清空主流程
  try {
    const all = await chrome.storage.local.get(null);
    const imgs = {};
    for (const k of Object.keys(all)) {
      if (k.startsWith('img:')) imgs[k] = all[k];
    }
    await chrome.storage.local.set({
      preWipeSnapshot: { at: Date.now(), notes: all.notes || {}, imgs },
    });
  } catch (_) { /* 配额超限等：跳过快照，继续清空 */ }
  await chrome.storage.local.remove(['notes', 'lastBackup', 'windowBounds', 'appWinId']);
  // resetStampAt 记录清空时刻：弹窗启动时若发现刚清空不久（<10min），跳过云端拉取——
  // CDN 边缘节点在覆写后仍会 Serve 陈旧副本（实测墓碑笔记被旧缓存原样拉回），
  // 在清空后的首次打开里拉云只会让旧数据复活。
  // 注意：与 resetStamp 同一个 set 原子写入——第 1 层的交叉验证依赖此不变式
  await chrome.storage.local.set({ resetStamp: WIPE_STAMP, resetStampAt: Date.now() });
  return true;
}
