// 同步引擎：异步后台、仅最终态、防抖折叠、失败重试、LWW 合并
import { getNotes, getNote, getSettings } from './storage.js';
import { uploadJson, downloadJson } from './qiniu.js';
import {
  writeLiveSnapshot, pullLiveSnapshot, mergeLiveNotes,
  cleanupLiveSnapshots, wipeLiveSnapshots,
} from './live.js';
import {
  localUrlOf, localPull, localPush, wipeLocalNotes,
  markLocalOk, markLocalFail, readLocalStatus,
} from './local.js';

let timer = null;
const pending = new Set();

// ===== 同步状态徽标：只认真实推送成功（v0.5.24）=====
// 历史假阳性：旧版页面 selectNote() 里 `settings && settings.ak ? 'synced' : 'local'`
// ——只要配置了 AK 就显示绿色"已同步"：从未推送、推送失败、本地有新改动，
// 全都骗成绿色。现在把"已同步"绑定到七牛上传链路真正返回（笔记文件 +
// notes/index.json 全部成功）后落下的持久化戳；页面每次从 storage 重新读取，
// 不在内存里永久缓存"已同步"，关窗重开也不会回到假阳性。
// 本状态【只读 UI 反馈】：不参与 ensurePulled / LWW / 删除 / 备份的任何决策。
const PUSH_SYNC_STATE_KEY = 'pushSyncState';

function errText(e) {
  return (e && e.message) || String(e || '未知错误');
}

// 成功戳：at=这次全量推送成功时刻；through=本次推送覆盖到的最新本地
// note.updatedAt（readSyncStatus 用它判断此后是否有未推送的新改动）；error 清空
async function markPushOk() {
  try {
    const notes = await getNotes();
    let through = 0;
    for (const n of Object.values(notes)) {
      const t = Number((n && n.updatedAt) || 0);
      if (t > through) through = t;
    }
    await chrome.storage.local.set({
      [PUSH_SYNC_STATE_KEY]: { at: Date.now(), through, error: '' },
    });
  } catch (_) { /* 状态戳只影响 UI，存储异常绝不阻断推送主流程 */ }
}

// 失败戳：保留上次成功的 at/through 供回溯，只写入失败原因（UI 红色 + title）
async function markPushFail(reason) {
  try {
    const r = await chrome.storage.local.get(PUSH_SYNC_STATE_KEY);
    const old = r[PUSH_SYNC_STATE_KEY] || {};
    await chrome.storage.local.set({
      [PUSH_SYNC_STATE_KEY]: {
        at: Number(old.at) || 0,
        through: Number(old.through) || 0,
        error: String(reason || '未知错误'),
      },
    });
  } catch (_) { /* 同上：状态戳失败不影响同步决策 */ }
}

// 本地数据服务是否已覆盖到「最新本地改动」——与云端戳同款判定
// （at>0 && error 空 && through >= 最新本地 note.updatedAt）。
// 本地服务用的是 LWW 合并（不是七牛的「本地权威覆盖索引」），所以本地成功
// 同样能证明「这一轮改动已经落到唯一副本上」，徽标可以据此转绿。
async function localCoversLatest() {
  const st = await readLocalStatus();
  if (!st || typeof st !== 'object') return false;
  if (st.error) return false;
  if (!(Number(st.at) > 0)) return false;
  try {
    const notes = await getNotes();
    let latest = 0;
    for (const n of Object.values(notes)) {
      const t = Number((n && n.updatedAt) || 0);
      if (t > latest) latest = t;
    }
    return Number(st.through) >= latest;
  } catch (_) { return false; }
}

// 只读判定（页面 await 调用）：返回 { key, msg }，key 与 setStatus 映射一一对应。
// 判定顺序：未启用云 → 进行中 → 最近失败 → 已成功且覆盖最新本地改动 → 待同步。
// 只有第四支是绿色；"配置了 AK"本身永远不足以显示"已同步"。
//
// v0.5.30（本地数据服务）：云端失败时，若本地服务已成功覆盖最新改动，
// 徽标仍转绿——数据确实已经落到本机唯一副本上，云端不可达只影响跨设备备份。
// 未启用本地服务时判定与 v0.5.24 逐字一致（QA 断言零回归）。
export async function readSyncStatus(settings, { syncing = false } = {}) {
  if (!settings || !settings.ak) {
    // 没配七牛：若本地数据服务已覆盖到最新本地改动，徽标仍该转绿——
    // 数据确实已经落到本机唯一副本上，只是没上云。没覆盖则维持「本地」灰态。
    const localOk = await localCoversLatest();
    return localOk ? { key: 'synced', msg: '' } : { key: 'local', msg: '' };
  }
  if (syncing) return { key: 'syncing', msg: '' };
  let st = null;
  try {
    const r = await chrome.storage.local.get(PUSH_SYNC_STATE_KEY);
    st = r[PUSH_SYNC_STATE_KEY];
  } catch (_) { return { key: 'pending', msg: '' }; }
  const localOk = await localCoversLatest();
  if (!st || typeof st !== 'object') {
    return localOk ? { key: 'synced', msg: '' } : { key: 'pending', msg: '' };
  }
  if (st.error && !localOk) return { key: 'error', msg: String(st.error) };
  if (Number(st.at) > 0) {
    try {
      const notes = await getNotes();
      let latest = 0;
      for (const n of Object.values(notes)) {
        const t = Number((n && n.updatedAt) || 0);
        if (t > latest) latest = t;
      }
      // through >= 最新本地改动时间 = 这一轮改动确实推上去了；否则只给"待同步"
      if (Number(st.through) >= latest) return { key: 'synced', msg: '' };
    } catch (_) { /* 读不到本地笔记时保守显示待同步，绝不误报绿色 */ }
  }
  if (localOk) return { key: 'synced', msg: '' };
  if (st.error) return { key: 'error', msg: String(st.error) };
  return { key: 'pending', msg: '本地改动尚未成功推送到七牛云' };
}

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

// 推送成功后补写一份实时快照（全新 key → CDN 必然回源 → 别的浏览器秒级可见）。
// 失败绝不阻断主同步：旧 CDN 通道仍然可用，只是延迟照旧。
// 同时清理旧快照，避免空间线性增长。
async function pushLiveSnapshot(settings) {
  try {
    const r = await writeLiveSnapshot(settings);
    if (r) await cleanupLiveSnapshots(settings);
    return r;
  } catch (_) {
    return null;
  }
}

// 推送到本地数据服务（同机唯一副本）。返回 true/false。
// 与七牛推送完全解耦：
//   - 不经过 ensurePulled 闸门（本地是 LWW 合并，没有「索引覆盖致孤儿」的风险）
//   - 失败不抛错（只留痕），云端推送照常进行
// 服务端返回的是【合并后】的全量，顺带把别的浏览器写的新内容带回本地——
// 于是「推送」这个动作本身就完成了一次同机同步。
async function pushLocal(settings) {
  if (!localUrlOf(settings)) return false;
  try {
    const notes = await getNotes();
    const r = await localPush(settings, notes);
    if (!r) {
      await markLocalFail('本地数据服务不可达', settings);
      return false;
    }
    if (r.notes) {
      const { notes: merged, changed } = await mergeLiveNotes(r.notes);
      if (changed) await chrome.storage.local.set({ notes: merged });
    }
    await markLocalOk(settings);
    return true;
  } catch (e) {
    await markLocalFail(errText(e), settings);
    return false;
  }
}

// 停输 800ms 后，将本次改动涉及的笔记 + 索引一起直传（最终态）
export function scheduleSync(noteId, settings, statusCb) {
  // 两条通道都没配 → 纯本地模式，无从同步
  if (!settings || (!settings.ak && !localUrlOf(settings))) {
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
  const hasCloud = !!(settings && settings.ak);
  // ① 本地数据服务优先（同机唯一副本，毫秒级可见）
  const localOk = hasCloud || localUrlOf(settings) ? await pushLocal(settings) : false;
  if (!hasCloud) {
    // 只配了本地服务：推到唯一副本即完成
    statusCb && statusCb(localOk ? 'synced' : 'local');
    return;
  }
  // ② 七牛云端（原逻辑，一字未改）
  try {
    // 首次推送前必须已拉取过（ensurePulled）：没拉过就推会把云端索引
    // 覆写成本地子集（本地权威覆盖语义），其余笔记文件沦为孤儿
    if (!(await ensurePulled(settings))) {
      const reason = '首次拉取未完成，已暂停推送';
      // 闸门未过也必须留失败痕迹，不能停在旧的成功绿上
      await markPushFail(reason);
      // 本地已推成功 → 数据已落到本机唯一副本，徽标应转绿而非报红
      statusCb && statusCb(localOk ? 'synced' : 'error', reason);
      return;
    }
    for (const id of ids) await pushNote(id, settings);
    await pushIndex(settings);
    // pushIndex 内部 uploadJson('notes/index.json') 成功返回才落成功戳：
    // 这是"真推送到七牛云"的唯一凭据，早于它的任何一步失败都不算成功
    await markPushOk();
    // 实时快照另写：全新 key → CDN 必然回源 → 另一台浏览器切回窗口即见最新。
    // 放在 markPushOk 之后且失败静默：它是「快」的增强通道，不该影响「是否已同步」
    await pushLiveSnapshot(settings);
    statusCb && statusCb('synced');
  } catch (e) {
    await markPushFail(errText(e));
    // 云端失败但本地成功 → 数据已在唯一副本上，徽标转绿（云端不可达只影响跨设备）
    statusCb && statusCb(localOk ? 'synced' : 'error', errText(e));
    // 保留 pending 以便下次编辑时重试
  }
}

// 立即把全部本地笔记 + 索引推上去
export async function pushAll(settings, statusCb) {
  const hasCloud = !!(settings && settings.ak);
  // 两条通道都没配 → 纯本地模式
  if (!hasCloud && !localUrlOf(settings)) {
    statusCb && statusCb('local');
    return;
  }
  // ① 本地数据服务优先（同机唯一副本）
  const localOk = await pushLocal(settings);
  if (!hasCloud) {
    // 只配了本地服务：推到唯一副本即完成（云端无凭据，不可能有第二次推送）
    statusCb && statusCb(localOk ? 'synced' : 'local');
    return;
  }
  // ② 七牛云端（原逻辑，一字未改）
  try {
    // 同 runSyncIds：未拉取过的浏览器禁止全量推送（防索引覆写）
    if (!(await ensurePulled(settings))) {
      const reason = '首次拉取未完成，已暂停推送';
      await markPushFail(reason);
      statusCb && statusCb(localOk ? 'synced' : 'error', reason);
      return;
    }
    const notes = await getNotes();
    for (const id of Object.keys(notes)) await pushNote(id, settings);
    await pushIndex(settings);
    // 手动保存与自动 scheduleSync 共用同一条成功戳路径，两条入口状态一致
    await markPushOk();
    // 实时快照：关窗前的最后一次全量推送同样要写，否则关窗后对方仍看不到
    await pushLiveSnapshot(settings);
    statusCb && statusCb('synced');
  } catch (e) {
    await markPushFail(errText(e));
    statusCb && statusCb(localOk ? 'synced' : 'error', errText(e));
  }
}

// ===== 云端拉取（v0.5.24–v0.5.28 的原有逻辑，一字未改）=====
// 返回值（供「未拉取过的浏览器禁止推送」闸门判定，见 ensurePulled）：
//   'ok'    已合并（无论是否有变更）
//   'empty' 云端无索引（404，全新用户）——没东西可拉，推送安全
//   'error' 远端不可达/内容非法——不可标记为已拉取
//
// v0.5.28：优先走【实时快照通道】——列举 notes/live/ 取最新一份全新 key，
// 一次 GET 拿到全部正文（全新 key 从未被 CDN 缓存 → 必然回源 → 拿到刚推送的
// 内容，绕开一年缓存）。通道不可用（列举失败/无快照/下载失败）时自动回退旧
// CDN 通道（notes/index.json + notes/<id>.json），行为退化为「最终一致」。
// 两条通道的合并语义完全一致（LWW + 墓碑标记 + 不删本地独有笔记）。
async function pullCloudBody(settings, onMerged) {
  if (!settings || !settings.ak) return 'error';

  // ① 实时快照通道（首选）
  const live = await pullLiveSnapshot(settings);
  if (live && live.notes) {
    const { notes: merged, changed } = await mergeLiveNotes(live.notes);
    if (changed) {
      await chrome.storage.local.set({ notes: merged });
      onMerged && onMerged();
    }
    return 'ok';
  }

  // ② 旧 CDN 通道（兜底）
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

// 云端拉取（含节流戳落盘）。单独成函数的原因：推送闸门 ensurePulled 必须
// 【只看云端】——本地服务成功不能放行云端推送（云端是「本地权威覆盖索引」
// 语义，一个从未拉过云端的浏览器推送会用本地子集覆写云端权威索引，
// 其余笔记文件沦为孤儿。这是 v0.5.6 起的老坑，不能因为加了本地通道而破）。
async function pullCloudInto(settings, onMerged) {
  const st = await pullCloudBody(settings, onMerged);
  if (st === 'ok' || st === 'empty') await markCloudPulled();
  return st;
}

// ===== 本地数据服务拉取（v0.5.30 新增）=====
// 同一台电脑上多个浏览器共用唯一一份数据的读取端。
// 合并语义与七牛完全一致（LWW + 墓碑 + 不删本地独有笔记），直接复用
// mergeLiveNotes ——两条通道的裁决规则必须一致，否则会出现「同一篇笔记在
// 云端判 A 更新、在本地判 B 更新」的分裂。
// 未启用本地服务（settings.localUrl 为空）→ 直接返回 false，零网络开销。
async function pullLocalInto(settings, onMerged) {
  if (!localUrlOf(settings)) return false;
  let data = null;
  try {
    data = await localPull(settings);
  } catch (_) {
    return false;
  }
  if (!data || !data.notes) return false;
  const { notes: merged, changed } = await mergeLiveNotes(data.notes);
  if (changed) {
    await chrome.storage.local.set({ notes: merged });
    onMerged && onMerged();
  }
  return true;
}

// ===== 组合入口：本地优先 + 云端兜底 =====
// 云端下载节流：本地服务可用时，它就是本机唯一副本，同机同步在本地通道
// 就已完成（毫秒级）。云端只负责跨设备与远端备份，下载侧没必要每次切窗口
// 都跑一趟——七牛不可达时更会白等满 15s 超时。故：本地成功且距上次云端
// 拉取不足 CLOUD_PULL_THROTTLE_MS 时跳过云端下载（【推送】侧不受影响，
// 改动照样实时上云）。手动刷新走 forceCloud 强制拉一次。
const CLOUD_PULL_THROTTLE_MS = 5 * 60 * 1000;
const CLOUD_PULL_AT_KEY = 'lastCloudPullAt';

async function cloudPullDue() {
  try {
    const r = await chrome.storage.local.get(CLOUD_PULL_AT_KEY);
    const last = Number(r[CLOUD_PULL_AT_KEY]) || 0;
    if (!last) return true;
    return Date.now() - last >= CLOUD_PULL_THROTTLE_MS;
  } catch (_) { return true; }
}

async function markCloudPulled() {
  try { await chrome.storage.local.set({ [CLOUD_PULL_AT_KEY]: Date.now() }); }
  catch (_) { /* 只影响节流，读不到就每次都拉 */ }
}

// 返回 { st, local, cloud }：
//   st    = 面向调用方的总体状态（'ok'/'empty'/'error'），与 v0.5.24 契约一致
//   local = 本地服务是否可用并成功
//   cloud = 云端状态：'ok'/'empty'/'error'/'skipped'（节流跳过）
// 调用方若要区分「云端是否真的拉过」（如 lastPullAt 闸门），必须看 cloud。
export async function pullSyncDetail(settings, onMerged, opts = {}) {
  const local = await pullLocalInto(settings, onMerged);
  let cloud = 'skipped';
  if (!local || opts.forceCloud) {
    cloud = await pullCloudInto(settings, onMerged);
  } else if (await cloudPullDue()) {
    cloud = await pullCloudInto(settings, onMerged);
  }
  const st = (cloud === 'ok' || cloud === 'empty') ? cloud : (local ? 'ok' : 'error');
  return { st, local, cloud };
}

// 从远端拉取并与本地按 updatedAt 合并（LWW，完全静默）。
// 契约与 v0.5.24 一致：'ok' 已合并 / 'empty' 云端无索引 / 'error' 远端不可达。
export async function pullSync(settings, onMerged, opts = {}) {
  const d = await pullSyncDetail(settings, onMerged, opts);
  return d.st;
}

// 推送闸门（跨浏览器数据安全）：「本地权威覆盖」语义下，一个从未拉取过云端
// 数据的浏览器一旦推送（关页面 flush-sync / 手动保存 / 停输 scheduleSync），
// 就会把云端索引覆写成自己的本地子集——其余笔记文件沦为孤儿（文件还在七牛，
// 但索引不再引用，同步再也拉不回来；其他浏览器本地副本不受影响，pull 不删本地）。
// 因此任何【云端】推送前都确保已成功拉取过云端：有 lastPullAt 直接放行；没有则先拉一次，
// 云端可达（'ok'/'empty'）才落 lastPullAt 并放行，不可达（'error'）则暂停本次推送
//
// v0.5.30：这里必须用 pullCloudInto（云端专用），【不能用 pullSync】——
// pullSync 在本地服务可用时会返回 'ok'，若用它放行，一个「从未拉过云端、只
// 拉过本地」的浏览器就会拿本地子集覆写云端权威索引 → 其它设备上的笔记全成孤儿。
// 本地服务用的是 LWW 合并不存在这个风险，所以本地推送【不经过】本闸门。
async function ensurePulled(settings) {
  const p = await chrome.storage.local.get('lastPullAt');
  if (p.lastPullAt) return true;
  const st = await pullCloudInto(settings);
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
// 本地待确认快照（pending）：新建快照的索引写进源站后，clouddn CDN 边缘节点
// 有传播延迟（测试域名实测可达 >10 分钟），期间 listSnapshots 从 CDN 读到的
// 还是旧索引——用户刚建的快照「不显示」，点回退也会被告知「快照不存在」。
// 对策：创建成功即把已知条目 {at,key,auto,n} 记本地；listSnapshots 每次把
// 云端索引 ∪ pending 合并返回，云端索引刷出来含同 at 条目后自动交棒移除。
// 最坏损失：列表多显示一条几分钟的旧条目（快照文件本身在源站，回退可用）
const SNAP_PENDING_KEY = 'pendingSnapshots';
const SNAP_PENDING_MAX = 20; // 防膨胀：只留最近 20 条待确认

// 记一条待确认快照（createSnapshot 的返回值即索引条目格式，直接存）
export async function addPendingSnapshot(entry) {
  if (!entry || typeof entry.at !== 'number' || !entry.key) return;
  const r = await chrome.storage.local.get(SNAP_PENDING_KEY);
  const p = Array.isArray(r[SNAP_PENDING_KEY]) ? r[SNAP_PENDING_KEY] : [];
  if (p.some((e) => e && e.at === entry.at)) return; // 已记录
  p.push({ at: entry.at, key: entry.key, auto: !!entry.auto, n: entry.n });
  p.sort((a, b) => b.at - a.at);
  await chrome.storage.local.set({ [SNAP_PENDING_KEY]: p.slice(0, SNAP_PENDING_MAX) });
}

// 交棒：云端索引已包含该 at → 从 pending 移除（静默失败不影响主流程）
async function dropPendingAt(at) {
  try {
    const r = await chrome.storage.local.get(SNAP_PENDING_KEY);
    const p = Array.isArray(r[SNAP_PENDING_KEY]) ? r[SNAP_PENDING_KEY] : [];
    const next = p.filter((e) => !e || e.at !== at);
    if (next.length !== p.length) await chrome.storage.local.set({ [SNAP_PENDING_KEY]: next });
  } catch (_) { /* 存储异常时下次再交棒 */ }
}

// 快照键时间戳：精确到秒。同一分钟内创建两份手动快照（如回退后马上又建）
// 必须落在不同键上，否则后一份会覆写前一份——「可再回退回来」的安全网
// 就是这么丢的。自动快照整点触发，秒位恒为 00，不影响可读性
function snapStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 创建全量快照。返回 {at, key, auto, n}；跳过条件（无 ak / 未拉取过 /
// 本地为空）返回 null；上传失败抛错（调用方可降级或中止，取决于场景）。
// onSkip（v0.5.22，可选）：跳过时回填人类可读原因，供后台写 autoSnapshotStatus
// 留痕。只回调、不改变返回契约（跳过仍返回 null），页面侧与 QA 老调用不受影响。
// 历史事故：后台跳过时一声不吭，用户只看到"自动快照一直没有"，无从排查。
export async function createSnapshot(settings, { auto = true, onSkip = null } = {}) {
  if (!settings || !settings.ak) {
    if (onSkip) onSkip('未配置七牛密钥，跳过');
    return null;
  }
  // 闸门：从未成功拉取过的浏览器不写云端——它的本地视图不完整，这份快照
  // 会覆写云端更完整的同一小时快照（与 backupRecent 同款理由）。
  // lastPullAt 被域名迁移清掉后，这里会先拉一次；'error' 不可达则暂停，
  // 绝不落戳——恢复路径就是本闸门自己，不需要也不允许旁路放行。
  if (!(await ensurePulled(settings))) {
    if (onSkip) onSkip('首次拉取未完成，已暂停快照（远端不可达）');
    return null;
  }
  const notes = await getNotes();
  if (Object.keys(notes).length === 0) {
    if (onSkip) onSkip('本地笔记为空，跳过');
    return null;
  }
  const at = Date.now();
  const key = `snapshots/${auto ? 'auto' : 'manual'}-${snapStamp(new Date(at))}.json`;
  await uploadJson(key, { at, auto, notes }, settings);
  const entry = { at, key, auto, n: Object.keys(notes).length };
  await updateSnapIndex(settings, entry);
  await chrome.storage.local.set({ lastSnapshotAt: at });
  // v0.5.25：自动快照同样立即进本地 pending。历史事故（2026-11-27 用户报告）：
  // 后台 createSnapshot 成功后只落 lastSnapshotAt/autoSnapshotStatus，没写 pending，
  // CDN 索引刷新前列表读不到新快照——状态说「12:26 已备份」，列表却只有两条
  // 10 月 pending 残留。页面手动创建/回退安全网都写了 pending，唯独后台漏掉。
  // 这里统一收口，所有创建路径都立刻可见；调用点重复的 addPendingSnapshot 按 at 去重。
  await addPendingSnapshot(entry);
  return entry;
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
  // v0.5.25：CDN 传播延迟下，downloadJson 读到的索引可能是几分钟前的旧版本。
  // 若直接「旧索引 + 新条目」覆盖写，会把期间别的浏览器/本浏览器刚追加的条目
  // 冲掉——2026-11-27 实测源站有 5 份 auto 快照文件，index.json 却只剩最后 1 条。
  // 把本地 pending 一并并入再上传：这些条目都是本机已成功上传过的真实快照，
  // 合并后云端索引最多短暂多一条（随后交棒去重），远好过静默丢失可回退记录。
  // 只在合并后去重 + 7 天剪枝，保留原有契约。
  try {
    const r = await chrome.storage.local.get(SNAP_PENDING_KEY);
    if (Array.isArray(r[SNAP_PENDING_KEY])) {
      for (const e of r[SNAP_PENDING_KEY]) {
        if (!e || typeof e.at !== 'number' || !e.key) continue;
        if (!idx.some((x) => x && x.at === e.at)) idx.push(e);
      }
    }
  } catch (_) { /* pending 读取失败不阻断索引更新 */ }
  idx.push(entry);
  const cutoff = Date.now() - SNAP_KEEP_MS;
  idx = idx.filter((e) => e && e.at >= cutoff).sort((a, b) => b.at - a.at);
  await uploadJson(SNAP_INDEX_KEY, idx, settings);
}

// 可选快照列表（新→旧）。拉取失败返回 []（UI 展示空态）。
// 合并本地 pending：CDN 延迟期间刚建的快照先由本地条目顶上，云端索引
// 刷新出来含同 at 后自动交棒。rollbackTo 依赖本函数找条目 key，
// 因此 pending 条目在延迟期内同样可回退
export async function listSnapshots(settings) {
  if (!settings || !settings.ak) return [];
  let cloud = [];
  try {
    const idx = await downloadJson(SNAP_INDEX_KEY, settings);
    if (Array.isArray(idx)) cloud = idx;
  } catch (_) { /* 云端尚无索引或拉取失败 */ }
  let pending = [];
  try {
    const r = await chrome.storage.local.get(SNAP_PENDING_KEY);
    if (Array.isArray(r[SNAP_PENDING_KEY])) pending = r[SNAP_PENDING_KEY];
  } catch (_) { /* 存储不可用则纯云端列表 */ }
  const merged = cloud.slice();
  for (const e of pending) {
    if (!e || typeof e.at !== 'number') continue;
    if (merged.some((x) => x && x.at === e.at)) {
      await dropPendingAt(e.at); // 云端已刷出，交棒
    } else {
      merged.push(e);
    }
  }
  return merged.sort((a, b) => b.at - a.at);
}

// 回退到指定快照（at 为快照时间戳）。返回 {restored, tombstoned, safetyAt, safety}。
// 任一前置失败（快照不存在/下载失败/内容损坏/安全快照创建失败）都抛错，
// 且本地数据保持原样——回退是破坏性操作，宁可中止不可半吊子
export async function rollbackTo(settings, at) {
  if (!settings || !settings.ak) throw new Error('未配置七牛同步，无法回退');
  const idx = await listSnapshots(settings); // 含 pending：CDN 延迟期内刚建的快照也能回退
  const entry = idx.find((e) => e && e.at === at);
  if (!entry) throw new Error('快照不存在或已超过保留期');
  // CDN 传播延迟：刚创建的快照文件可能几分钟内从边缘节点下载 404（实测 >10 分钟）。
  // 重试 3 次（间隔 3s）覆盖短延迟；仍失败给明确文案，用户知道是等 CDN 而非操作错
  let snap = null;
  for (let i = 0; i < 3 && !snap; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      snap = await downloadJson(entry.key, settings);
    } catch (_) { /* 下次重试 */ }
  }
  if (!snap) throw new Error('快照文件下载失败（云端 CDN 生效中，请几分钟后重试）');
  if (!snap || typeof snap !== 'object' || !snap.notes || typeof snap.notes !== 'object') {
    throw new Error('快照内容损坏');
  }
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
  // 回退也是一次真实全量推送：updatedAt 已统一推到当前时刻，落成功戳后
  // 徽标自然转绿；否则会永远停在"待同步"（同样不影响回退本身的同步语义）
  await markPushOk();
  // 回退结果也要走实时通道：否则其他浏览器要等 CDN 缓存过期才看到回退
  await pushLiveSnapshot(settings);
  await recordChange(settings, {
    type: 'rollback', at: entry.at, t: now,
    restored: Object.keys(snap.notes).length, tombstoned,
  });
  // safety 带完整条目（{at,key,auto,n}）：UI 直接 addPendingSnapshot，
  // 回退后的安全网快照同样顶着 CDN 延迟立即显示在列表里
  return {
    restored: Object.keys(snap.notes).length,
    tombstoned,
    safetyAt: safety ? safety.at : null,
    safety: safety || null,
  };
}

// ===== 一次性彻底清空（v0.3.0 重置专用，本地 + 云端）=====
export const WIPE_STAMP = 'v0.3.1';

// 云端清空：索引/变更记录/快照索引覆写为空数组，各笔记文件打成墓碑。
// 快照索引（snapshots/index.json）一并清空：小时级快照文件物理删不掉，
// 但清掉索引后回退 UI 无列表可选，"清空"在用户视角才是彻底的
// （snapshots/*.json 文件残留在空间里，只是再也无法通过界面触达）。
// v0.5.28：实时快照通道（notes/live/）现在【物理删除】——实测 rs delete 可用
// （此前记的「delete 401」是签名/host 用错）。必须删干净，否则清空前的正文
// 会被别的浏览器当「远端最新」拉回来。
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
  // 实时快照必须一并删除（v0.5.28）：快照里存的是全量正文，若留着，
  // 别的浏览器拉取时会把「清空前的内容」当成远端最新合并回来——数据复活。
  // 这是清空语义的硬要求，漏掉即为严重缺陷。
  await wipeLiveSnapshots(settings);
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
  // 本地数据服务也要一并清空（v0.5.30）：它存着本机唯一一份全量正文，
  // 不清的话下次拉取会把「清空前的内容」当远端最新合并回来——数据复活。
  // 与 wipeCloud 同一道硬要求：本地服务已启用却清不掉 → 抛错中止本次清空，
  // 不清本地（下次启动自动重试）。宁可晚清，不可复活。
  if (localUrlOf(settings)) {
    const localOk = await wipeLocalNotes(settings);
    if (!localOk) {
      throw new Error('本地数据服务清空失败（服务未运行？），已取消本地清空以防数据复活');
    }
  }
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
  // pushSyncState 一并清掉：清空后旧的成功戳会骗出绿色"已同步"假阳性。
  // liveSnapshotFingerprint 同样要清：它记录着"上次写的快照内容指纹"，
  // 清空后本地为空、内容指纹若还在，下次推送会因"内容未变"跳过写快照——
  // 云端通道就会停在清空前的旧快照上。
  // localSyncStatus 同理：清空后旧的成功戳会让徽标误报绿色。
  // lastCloudPullAt 一并清：清空后的首次拉取必须真去云端拉一次（节流戳若留着，
  // 会跳过这次拉取，把清空前的云端旧内容拉回来——数据复活）。
  // 注意：仍是【一次 remove】，这是 oneTimeWipe 竞态守卫的核心不变式。
  await chrome.storage.local.remove(['notes', 'lastBackup', 'windowBounds', 'appWinId', 'pushSyncState',
    'liveSnapshotFingerprint', 'liveSnapshotAt', 'liveSyncStatus',
    'localSyncStatus', 'lastCloudPullAt']);
  // resetStampAt 记录清空时刻：弹窗启动时若发现刚清空不久（<10min），跳过云端拉取——
  // CDN 边缘节点在覆写后仍会 Serve 陈旧副本（实测墓碑笔记被旧缓存原样拉回），
  // 在清空后的首次打开里拉云只会让旧数据复活。
  // 注意：与 resetStamp 同一个 set 原子写入——第 1 层的交叉验证依赖此不变式
  await chrome.storage.local.set({ resetStamp: WIPE_STAMP, resetStampAt: Date.now() });
  return true;
}
