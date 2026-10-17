// 后台 service worker：工具栏点击 → 独立窗口管理（尺寸/位置记忆）+ 每日备份调度
// 说明：MV3 弹窗（default_popup）既不能手动缩放、也无法偏移位置，因此默认入口
// 改为独立窗口（chrome.windows.create type=popup）：可自由拖拽调整，位置可编程控制。
import { getSettings } from './lib/storage.js';
import { backupRecent, pushAll, oneTimeWipe, WIPE_STAMP } from './lib/sync.js';

const BIG_URL = chrome.runtime.getURL('pages/main.html?mode=window');
const BOUNDS_KEY = 'windowBounds';
const WINID_KEY = 'appWinId';
const DEFAULT = { width: 600, height: 400 };
// 新建窗口时整体右移 100px（用户要求：默认打开位置往右移 100px）。
// 只对"无位置记忆"的新窗生效；用户手动拖过窗口后按记忆位置打开，不再偏移
const OFFSET_X = 100;

let saveTimer = null;

// 读取记忆的窗口参数：尺寸缺失或小得离谱（<600×400，属历史脏数据）则回默认；
// left/top 仅在用户拖动过窗口（有记忆）时才返回，否则交给浏览器默认定位 + 右移
async function getBounds() {
  const r = await chrome.storage.local.get(BOUNDS_KEY);
  const b = r[BOUNDS_KEY] || {};
  const out = { ...DEFAULT };
  if (b.width && b.height && b.width >= 600 && b.height >= 400) {
    out.width = b.width;
    out.height = b.height;
  }
  if (typeof b.left === 'number' && typeof b.top === 'number') {
    out.left = b.left;
    out.top = b.top;
  }
  return out;
}

// 开窗自愈：扩展更新/重载后的首次 windows.create 偶发解析不了扩展页 URL，
// Chromium 会把窗口退化成 about:blank/新标签页（用户实测：更新后首次打开是 Google 新标签页）。
// 校验窗口内任一 tab：没有任何扩展页 → 把活动 tab 直接导航到笔记页，用户无感修复。
// 只认 url/pendingUrl 明确以 chrome-extension:// 开头才算"已经是我们的页"——
// 无 tabs 权限时 chrome:// 页的 url 不可见（undefined），恰好落入"需要修复"分支，符合预期
async function healWindowUrl(winId) {
  try {
    const tabs = await chrome.tabs.query({ windowId: winId });
    if (!tabs || !tabs.length) return;
    const ours = tabs.some((t) => ((t.url || t.pendingUrl || '')).startsWith('chrome-extension://'));
    if (ours) return;
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url: BIG_URL });
  } catch (_) { /* 自愈失败不影响窗口已创建 */ }
}

async function openBigWindow(reset = false) {
  if (reset) await chrome.storage.local.remove(BOUNDS_KEY);
  const bounds = await getBounds();
  const s = await chrome.storage.local.get(WINID_KEY);
  if (s[WINID_KEY] != null) {
    try {
      const w = await chrome.windows.get(s[WINID_KEY]);
      if (w) {
        // reset 时把已开着的窗口直接拉回默认尺寸，而不是再开一个新窗
        await chrome.windows.update(w.id, reset
          ? { focused: true, width: bounds.width, height: bounds.height }
          : { focused: true });
        // 上次更新可能留下 newtab 空壳窗：聚焦的同时顺手修好
        await healWindowUrl(w.id);
        return;
      }
    } catch (_) {
      // 窗口已不存在
    }
  }
  const createOpts = {
    url: BIG_URL,
    type: 'popup',
    width: bounds.width,
    height: bounds.height,
    focused: true,
  };
  if (typeof bounds.left === 'number') createOpts.left = bounds.left;
  if (typeof bounds.top === 'number') createOpts.top = bounds.top;
  let win;
  try {
    win = await chrome.windows.create(createOpts);
  } catch (_) {
    // 位置/尺寸含历史脏数据时降级重试：去掉 left/top，交给浏览器默认定位
    win = await chrome.windows.create({
      url: BIG_URL, type: 'popup', width: bounds.width, height: bounds.height, focused: true,
    });
  }
  await chrome.storage.local.set({ [WINID_KEY]: win.id });
  // 更新换装瞬间的首次创建可能落地成新标签页：校验并导航修复
  await healWindowUrl(win.id);
  // 无位置记忆的新窗：创建后整体右移 100px（读实际落点再偏移，不依赖屏幕坐标计算）
  if (typeof bounds.left !== 'number') {
    try {
      const cur = await chrome.windows.get(win.id);
      if (cur && typeof cur.left === 'number' && cur.left > -30000) {
        await chrome.windows.update(win.id, { left: cur.left + OFFSET_X });
      }
    } catch (_) {
      // 读取落点失败不影响窗口已创建
    }
  }
}

// 工具栏图标点击 → 打开独立窗口（无 default_popup 时 onClicked 才会触发）
chrome.action.onClicked.addListener(() => { openBigWindow(false); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'open-big-window') openBigWindow(!!msg.reset);
  // 弹窗关闭时补推：SW 生命周期比 popup 长，防抖定时器被杀导致的最后一笔丢失
  if (msg.type === 'flush-sync') {
    getSettings().then((s) => { if (s && s.ak) pushAll(s); }).catch(() => {});
  }
  // 一次性清空执行权收口到 SW：页面启动时发消息触发并等待结果。
  // 与 onInstalled(update)/onStartup 共享 sync.js 的 in-flight 守卫——清空进行中时
  // 本调用直接挂到同一个 promise 上，不会二次执行。return true 保持消息通道，
  // 云端清理耗时期间 SW 不被休眠杀掉；页面收到 { ok:false } 时按原样放行、下次重试
  if (msg.type === 'one-time-wipe') {
    oneTimeWipe().then(
      (wiped) => { try { sendResponse({ ok: true, wiped: !!wiped }); } catch (_) { /* 页面已关闭 */ } },
      (e) => { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) { /* 页面已关闭 */ } }
    );
    return true;
  }
});

chrome.windows.onRemoved.addListener(async (winId) => {
  const s = await chrome.storage.local.get(WINID_KEY);
  if (s[WINID_KEY] === winId) await chrome.storage.local.remove(WINID_KEY);
});

chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (win.type !== 'popup') return;
  const s = await chrome.storage.local.get(WINID_KEY);
  if (s[WINID_KEY] !== win.id) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({
      [BOUNDS_KEY]: {
        width: win.width,
        height: win.height,
        left: win.left,
        top: win.top,
      },
    });
  }, 400);
});

// 每日备份（近 7 天）调度：周期 1440 分钟，SW 在后台唤醒时执行
async function ensureAlarm() {
  const existing = await chrome.alarms.get('dailyBackup');
  if (!existing) chrome.alarms.create('dailyBackup', { periodInMinutes: 1440 });
}

// ===== 一次性彻底清空（v0.3.0 重置）：本地 + 云端全部数据 =====
// 触发点 1：版本更新（reason=update）时自动执行——用户无感知，重载即生效
// 触发点 2：每次浏览器启动（onStartup）兜底重试——防止 onInstalled 时断网导致清空失败
// 触发点 3：弹窗/大窗启动时页面发 'one-time-wipe' 消息过来执行（见下方 onMessage）。
//   页面自身不直跑 sync.js 的 oneTimeWipe——页面与 SW 各持一个模块实例，两边同时跑
//   会并发双清空、交叉 remove(['notes']) 删掉刚写入的笔记（2026-10-17 修启动竞态）。
//   三个触发点都收口到 SW 这一个执行者，靠 sync.js 的 in-flight 守卫保证串行。
// 全新安装（reason=install）不清云端：保留云端数据，重装后可恢复
chrome.runtime.onInstalled.addListener(async (details) => {
  ensureAlarm();
  try {
    if (details.reason === 'update') {
      await oneTimeWipe();
    } else {
      // 全新安装：只打版本戳，不清任何数据
      const r = await chrome.storage.local.get('resetStamp');
      if (r.resetStamp !== WIPE_STAMP) await chrome.storage.local.set({ resetStamp: WIPE_STAMP, resetStampAt: Date.now() });
    }
  } catch (_) {
    // 云端清理失败：不落戳，onStartup / 下次开弹窗会重试
  }
});

chrome.runtime.onStartup.addListener(async () => {
  ensureAlarm();
  try { await oneTimeWipe(); } catch (_) { /* 已打戳则无事发生；失败则下次重试 */ }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dailyBackup') return;
  const s = await getSettings();
  if (s && s.ak) {
    await backupRecent(s, 7);
    await chrome.storage.local.set({ lastBackup: Date.now() });
  }
});
