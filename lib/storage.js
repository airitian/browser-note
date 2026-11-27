// 本地存储层：notes 字典 + settings + 跨窗口变更广播
const NOTES_KEY = 'notes';
const SETTINGS_KEY = 'settings';
// 本地数据服务的配置挂在【独立键】上，不放进 settings：
// saveSettings 是整体覆盖 settings 的（七牛那五字段表单），地址放里面
// 会被用户每保存一次七牛配置就冲掉。独立键与 GitHub 备份配置同款做法。
const LOCAL_SERVICE_KEY = 'localService';

import { DEFAULT_SETTINGS } from './config.js';

// 旧端点迁移（2026-11-26）：用户浏览器里可能存着历史 bucket/domain/region。
// 只认已知旧值，用户自行填的其他域名绝不覆盖；命中即改写并清 lastPullAt——
// 否则「已拉取过」闸门会放行直接推送，把本地子集覆写到新空间的权威索引上
// （跨浏览器丢数据的老坑，见 sync.js ensurePulled 注释）。
const LEGACY_BUCKETS = new Set(['browser-note', 'video2notehaiwai']);
const LEGACY_DOMAINS = new Set([
  'tmycvi0la.hn-bkt.clouddn.com',
  'tmralw2m1.hn-bkt.clouddn.com',
  'video.ainitian.cyou',
]);
const LEGACY_REGIONS = new Set(['na0']);

export async function migrateStoredSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const next = { ...s };
  let changed = false;
  if (LEGACY_BUCKETS.has(next.bucket)) { next.bucket = DEFAULT_SETTINGS.bucket; changed = true; }
  if (LEGACY_DOMAINS.has(next.domain)) { next.domain = DEFAULT_SETTINGS.domain; changed = true; }
  if (LEGACY_REGIONS.has(next.region)) { next.region = DEFAULT_SETTINGS.region; changed = true; }
  if (!changed) return s;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next, lastPullAt: 0 });
  // 上传成功戳证明的是旧端点：换空间后一次没推过也不能显示绿色"已同步"
  await chrome.storage.local.remove('pushSyncState');
  return next;
}

// 未单独保存过设置时，回落到代码内置的七牛配置
export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const base = r[SETTINGS_KEY] ? await migrateStoredSettings(r[SETTINGS_KEY]) : { ...DEFAULT_SETTINGS };
  // 本地数据服务地址并进返回值：同步逻辑要像普通设置一样一眼看到它，
  // 但它的真身存在独立键上（见 LOCAL_SERVICE_KEY 注释）
  const ls = await getLocalServiceConfig();
  if (ls.enabled && ls.url) base.localUrl = ls.url;
  return base;
}

// 本地数据服务配置：{ enabled, url }
// 未启用时 url 视为空串 —— lib/local.js 据此【完全跳过】本地通道（零网络开销）。
export async function getLocalServiceConfig() {
  try {
    const r = await chrome.storage.local.get(LOCAL_SERVICE_KEY);
    const c = r[LOCAL_SERVICE_KEY];
    if (c && typeof c === 'object' && c.enabled && c.url) {
      return { enabled: true, url: String(c.url).trim() };
    }
  } catch (_) { /* 存储不可用：按未启用处理 */ }
  return { enabled: false, url: '' };
}

// 保存本地数据服务配置。地址变了 → 旧的成功戳不再作数（它证明的是上一个地址），
// 同步戳与云端节流戳一并清掉，下次同步会重新走一遍。
export async function saveLocalServiceConfig(cfg) {
  const next = {
    enabled: !!(cfg && cfg.enabled),
    url: cfg && cfg.url ? String(cfg.url).trim() : '',
  };
  if (next.enabled && !next.url) next.enabled = false;
  await chrome.storage.local.set({ [LOCAL_SERVICE_KEY]: next });
  await chrome.storage.local.remove(['localSyncStatus', 'lastCloudPullAt']);
  return next;
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  // 密钥/空间一变，旧戳证明的就不是当前目标空间了：作废成功戳（徽标回落
  // "待同步"，下次真实推送成功再转绿）。只影响 UI 反馈，不碰 lastPullAt/同步闸门
  await chrome.storage.local.remove('pushSyncState');
  // 换空间同理要清实时快照指纹：新空间里还没有任何 live 快照，若因"内容未变"
  // 跳过写入，实时通道在新空间会一直空转（拉取只能回退到旧索引通道）
  await chrome.storage.local.remove(['liveSnapshotFingerprint', 'liveSnapshotAt', 'liveSyncStatus']);
}

export async function getNotes() {
  const r = await chrome.storage.local.get(NOTES_KEY);
  return r[NOTES_KEY] || {};
}

export async function getNote(id) {
  const notes = await getNotes();
  return notes[id] || null;
}

export async function upsertNote(note) {
  const notes = await getNotes();
  notes[note.id] = note;
  await chrome.storage.local.set({ [NOTES_KEY]: notes });
  return note;
}

export async function deleteNote(id) {
  const notes = await getNotes();
  delete notes[id];
  await chrome.storage.local.set({ [NOTES_KEY]: notes });
}

export async function listNotes() {
  const notes = await getNotes();
  return Object.values(notes).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function onNotesChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[NOTES_KEY]) cb(changes[NOTES_KEY].newValue || {});
  });
}
