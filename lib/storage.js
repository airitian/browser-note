// 本地存储层：notes 字典 + settings + 跨窗口变更广播
const NOTES_KEY = 'notes';
const SETTINGS_KEY = 'settings';

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
  if (!r[SETTINGS_KEY]) return { ...DEFAULT_SETTINGS };
  return migrateStoredSettings(r[SETTINGS_KEY]);
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  // 密钥/空间一变，旧戳证明的就不是当前目标空间了：作废成功戳（徽标回落
  // "待同步"，下次真实推送成功再转绿）。只影响 UI 反馈，不碰 lastPullAt/同步闸门
  await chrome.storage.local.remove('pushSyncState');
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
