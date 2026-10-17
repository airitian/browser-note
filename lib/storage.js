// 本地存储层：notes 字典 + settings + 跨窗口变更广播
const NOTES_KEY = 'notes';
const SETTINGS_KEY = 'settings';

import { DEFAULT_SETTINGS } from './config.js';

// 未单独保存过设置时，回落到代码内置的七牛配置
export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return r[SETTINGS_KEY] || { ...DEFAULT_SETTINGS };
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
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
