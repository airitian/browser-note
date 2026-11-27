// 后台 service worker：工具栏点击 → 独立窗口管理（尺寸/位置记忆）+ 每日备份调度
// 说明：MV3 弹窗（default_popup）既不能手动缩放、也无法偏移位置，因此默认入口
// 改为独立窗口（chrome.windows.create type=popup）：可自由拖拽调整，位置可编程控制。
import { getSettings, migrateStoredSettings } from './lib/storage.js';
import { backupRecent, pushAll, createSnapshot, oneTimeWipe, awaitWipeIfRunning, WIPE_STAMP } from './lib/sync.js';
import { runFullBackup } from './lib/github-backup.js';

const BIG_URL = chrome.runtime.getURL('pages/main.html?mode=window');
const BOUNDS_KEY = 'windowBounds';
const WINID_KEY = 'appWinId';
const DEFAULT = { width: 600, height: 400 };
// 新建窗口时整体右移 100px（用户要求：默认打开位置往右移 100px）。
// 只对"无位置记忆"的新窗生效；用户手动拖过窗口后按记忆位置打开，不再偏移
const OFFSET_X = 100;

// 自动快照留痕键（v0.5.22）：每次后台尝试都写一条
// {at, ok, reason, trigger, snapshotAt}，由设置页「数据回退」卡片渲染。
// 历史事故（2026-10-15 用户报告）：v0.5.21 及以前后台取不到配置或闸门未过时
// 直接 return，catch 也把过程吞掉——用户只看到"自动快照一直没有"，却查不到
// 任何线索，连"到底跑没跑"都无法自证。失败必须可见，这是本次修复的硬要求。
const AUTO_SNAP_STATUS_KEY = 'autoSnapshotStatus';
// 启动补跑与 alarm 可能在 SW 同一次唤醒里并发；共享同一次执行，避免
// 同秒双快照互相覆盖（snapStamp 精确到秒）
let autoSnapshotRunning = null;

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
    getSettings().then((s) => { if (s && (s.ak || s.localUrl)) pushAll(s); }).catch(() => {});
  }
  // 页面启动兜底（v0.5.22）：页面是最可靠的"用户回来了"信号，请 SW 重建
  // 可能丢失的 alarm 并补跑一次快照。只走后台链路，不在页面直接写云；
  // ensurePulled 闸门与 in-flight 守卫仍在 SW 内，安全语义不变
  if (msg.type === 'ensure-alarms') {
    safeEnsureAlarm();
    // 清空若正在飞行中，等它完成再补跑——否则会给"即将被清空的数据"做快照
    const running = awaitWipeIfRunning();
    if (running) running.then(() => ensureSnapshotFresh(), () => {});
    else ensureSnapshotFresh();
  }
  // 一次性清空（P1 修复后）：本消息【只等待、不触发】——清空执行权只保留在
  // onInstalled(reason=update)/onStartup 两个 SW 生命周期事件，页面加载不再
  // 触发清空。旧语义"页面加载即触发一次 wipe 检查"是漏戳误清的放大面：
  // 任一次页面加载读漏即清空当期活数据（QA 实证重载页 1/5 概率）。
  // 现有清空正在飞行中（onStartup 刚启动的）→ 挂到同一个 promise 上等它完成
  // 再回结果（共享 sync.js 的 in-flight 守卫，不会二次执行）；没有 → 直接回
  // {wiped:false}。两种情况都 return true 保持消息通道，云端清理耗时期间
  // SW 不被休眠杀掉；页面收到 { ok:false } 时按原样放行、下次重试。
  // 注意（有意为之的语义改变）：过期戳的数据将存活到下次浏览器启动
  // （onStartup）才清——宁可晚清，不可误清（k-wipe-race B4 场景相应改变）
  if (msg.type === 'one-time-wipe') {
    const running = awaitWipeIfRunning();
    if (running) {
      running.then(
        (wiped) => { try { sendResponse({ ok: true, wiped: !!wiped, waited: true }); } catch (_) { /* 页面已关闭 */ } },
        (e) => { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) { /* 页面已关闭 */ } }
      );
    } else {
      try { sendResponse({ ok: true, wiped: false, waited: false }); } catch (_) { /* 页面已关闭 */ }
    }
    return true;
  }
  // GitHub 私有仓库全量备份（v0.5.23）：页面只发触发消息，Git Data 流程在 SW 执行。
  // 与 one-time-wipe 同款异步响应通道——SW 在 sendResponse 前不会被回收，
  // 避免"关窗丢数据"；模块内单飞守卫让手动/每日同秒触发共享一次执行。
  // 失败一律在 github-backup.js 内写状态且不标日期，下次打开自动重试。
  if (msg.type === 'github-full-backup') {
    const trigger = msg.trigger === 'daily' ? 'daily' : 'manual';
    runFullBackup({ trigger }).then(
      (r) => { try { sendResponse(r || { ok: false, reason: '后台无结果' }); } catch (_) { /* 页面已关闭 */ } },
      (e) => {
        try { sendResponse({ ok: false, reason: '后台异常：' + String((e && e.message) || e) }); }
        catch (_) { /* 页面已关闭 */ }
      }
    );
    return true;
  }
});

// 关闭浏览器时：先同步到七牛，再关笔记窗（v0.5.27）。
// 笔记是 type=popup 的独立窗口；用户关掉最后一个普通浏览窗口（type=normal）后，
// Chrome 不会退出（popup 窗仍让进程存活），笔记窗会留下。此时页面 pagehide 的
// persist + flushSyncSafe 是否跑完并不可靠（防抖定时器随页面卸载被杀、MV3 SW
// 可能回收）。所以在 SW 里显式做一次全量推送：await pushAll 跑完再关窗，确保
// 最后一笔编辑先落到七牛云，避免关窗把未同步数据带走。边界：
//   ① 关的就是笔记窗自身 → 只清 WINID_KEY，不触发同步（用户主动关，页面
//      pagehide 已有兜底；且此时笔记窗可能已失效，推完也无处可关）；
//   ② 还有其他 normal 窗口 → 不动，浏览器还在用；
//   ③ 无 appWinId / getAll 抛错 → 静默空操作；
//   ④ pushAll 内部吞掉所有错误（失败只 markPushFail），无论成功失败都继续关窗，
//      绝不让同步失败把用户卡在孤儿窗里；getSettings 走页面同款带内置回退口径
//      （不可用 SW 快照专用的 getStoredSettings，否则未保存过配置的 profile 不推）；
//   ⑤ 只认 type=normal 为"浏览窗口"，devtools / 别的扩展 popup 不算，
//      避免开着 F12 时把笔记窗误判成"浏览器还在"而漏做同步与关闭；
//   ⑥ SW 存活：pushAll 内部连续 fetch 会不断重置 MV3 空闲计时器，撑到同步完成。
async function syncThenCloseAppWindow(removedWinId) {
  let appId;
  try {
    const s = await chrome.storage.local.get(WINID_KEY);
    appId = s[WINID_KEY];
  } catch (_) { return; }
  if (appId == null) return;
  // 笔记窗自己被关（用户点 X，或后续我们 remove 触发的回调）：清记录，不级联
  if (appId === removedWinId) {
    try { await chrome.storage.local.remove(WINID_KEY); } catch (_) {}
    return;
  }
  let windows = [];
  try {
    windows = await chrome.windows.getAll();
  } catch (_) { return; }
  const hasBrowserWindow = (windows || []).some(
    (w) => w && w.type === 'normal' && w.id !== removedWinId,
  );
  if (hasBrowserWindow) return;

  // 关键顺序：先同步到七牛（await 跑完），再关笔记窗。pushAll 内部已吞错误，
  // 这里再包一层防御；getSettings 用带内置回退的页面口径，保证在用的 profile 能推。
  try {
    const settings = await getSettings();
    if (settings && (settings.ak || settings.localUrl)) await pushAll(settings);
  } catch (_) { /* 同步失败也不阻断关窗 */ }

  try {
    await chrome.windows.remove(appId);
  } catch (_) { /* 笔记窗可能已被关，或浏览器正在整体退出 */ }
  try { await chrome.storage.local.remove(WINID_KEY); } catch (_) {}
}

chrome.windows.onRemoved.addListener(async (winId) => {
  await syncThenCloseAppWindow(winId);
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
// 每小时全量快照（数据回退用，v0.5.14）：周期 60 分钟，SW 唤醒时执行
// 定时器重建（v0.5.22）：旧版两处缺陷——① 调用方未 await，SW 冷启动可能在
// create 完成前被回收，alarm 静默丢失，自动快照/备份再也不触发；② 只判断
// "是否存在"，旧版本残留的错误周期不会被纠正。现在两个 alarm 都校验周期，
// 缺失/漂移即重建；调用方一律 await，并在 alarm 事件与页面启动时再次自愈。
async function ensureAlarm() {
  const daily = await chrome.alarms.get('dailyBackup');
  if (!daily || daily.periodInMinutes !== 1440) {
    await chrome.alarms.create('dailyBackup', { periodInMinutes: 1440 });
  }
  const snap = await chrome.alarms.get('hourlySnapshot');
  if (!snap || snap.periodInMinutes !== 60) {
    await chrome.alarms.create('hourlySnapshot', { periodInMinutes: 60 });
  }
}

// 定时器 API 异常不能阻断清空/快照主流程，但必须留痕（不再是彻底静默）
async function safeEnsureAlarm() {
  try { await ensureAlarm(); }
  catch (e) { console.warn('[browser-note] 重建定时 alarm 失败：' + ((e && e.message) || e)); }
}

// SW 侧读取【显式保存】的 settings（与页面 getSettings 的内置回退相区分）。
// 历史背景：这里刻意不回退 DEFAULT_SETTINGS，是为了防止从未配置过的 profile
// 在浏览器启动瞬间拿内置密钥同步（拉别人云端数据进本地、还往上写快照）。
// v0.5.22 修正：仅"显式保存过"的 profile 走这里；从未保存过、但本地已有笔记
// 的在用 profile 走下方 getSnapshotSettings 的受限回退——解决"密钥只写在
// gitignore 的 config.js、从没点过设置页保存 → 后台两条路径永远拿空配置"
// 的静默失效（2026-10-15 用户报告）。
// 旧端点迁移照旧（na0/旧域名不能带进快照链路）。
async function getStoredSettings() {
  const r = await chrome.storage.local.get('settings');
  return r.settings ? migrateStoredSettings(r.settings) : null;
}

// 自动快照专用配置解析（v0.5.22）：
//  1) 用户显式保存过 settings → 原样尊重；ak 为空即视为"主动关闭同步"，不回退，
//     否则会把用户明确关掉的同步又用内置密钥打开；
//  2) 从未保存过 → 只有本地已有笔记（证明是在用的旧 profile，而非全新安装/
//     测试 profile）才回退 getSettings() 的内置密钥，与页面启动口径一致；
//     本地为空直接跳过，连网络请求都不发，守住"不配置则仅本地保存"的承诺。
// 安全检查全部留在 createSnapshot 内部（ensurePulled 先拉后写、本地为空不写），
// 这里只决定"用哪套配置"，绝不绕过闸门。
async function getSnapshotSettings() {
  const explicit = await getStoredSettings();
  if (explicit) {
    return {
      settings: explicit.ak ? explicit : null,
      source: explicit.ak ? 'stored' : 'disabled',
    };
  }
  const local = await chrome.storage.local.get('notes');
  if (!local.notes || typeof local.notes !== 'object' || !Object.keys(local.notes).length) {
    return { settings: null, source: 'empty-local' };
  }
  const fallback = await getSettings();
  return fallback && fallback.ak
    ? { settings: fallback, source: 'builtin' }
    : { settings: null, source: 'no-key' };
}

// 自动快照留痕（v0.5.22）：成功/失败/跳过都落一条状态，设置页可读。
// 写入失败只打 console.warn——留痕本身是保险，绝不能反过来阻断快照主流程。
async function recordAutoSnapshot({ ok, reason, trigger, snapshotAt }) {
  const status = {
    at: Date.now(),
    ok: !!ok,
    reason: reason || '',
    trigger: trigger || '',
    snapshotAt: snapshotAt || 0,
  };
  try {
    await chrome.storage.local.set({ [AUTO_SNAP_STATUS_KEY]: status });
  } catch (e) {
    console.warn('[browser-note] 自动快照状态写入失败：' + ((e && e.message) || e));
  }
}

async function doRunAutoSnapshot(trigger) {
  let ok = false;
  let reason = '';
  let snapshotAt = 0;
  try {
    const { settings, source } = await getSnapshotSettings();
    if (!settings) {
      // 跳过也留痕：用户能从设置页看到"为什么没有自动快照"，而不是一片空白
      reason = source === 'empty-local'
        ? '本地暂无笔记，跳过（全新浏览器或尚未使用）'
        : source === 'disabled' ? '已保存空配置，视为关闭同步，跳过'
          : '未配置七牛密钥，跳过';
    } else {
      // onSkip 只回填原因，不改变 createSnapshot 的返回契约（跳过仍返回 null）。
      // ensurePulled 闸门原样留在 sync.js：lastPullAt 被域名迁移清掉时会先拉一次，
      // 远端不可达则 'error' 暂停并在此留痕，绝不落戳绕过安全语义。
      let skipReason = '';
      const r = await createSnapshot(settings, {
        auto: true,
        onSkip: (why) => { skipReason = why || ''; },
      });
      if (r) {
        ok = true;
        snapshotAt = r.at;
      } else {
        reason = skipReason || '快照被跳过（本地为空或未完成首次拉取）';
      }
    }
  } catch (e) {
    // 上传/签名/网络异常：明确原因，不再吞掉
    reason = '快照失败：' + ((e && e.message) || e);
  }
  await recordAutoSnapshot({ ok, reason, trigger, snapshotAt });
}

function runAutoSnapshot(trigger) {
  if (autoSnapshotRunning) return autoSnapshotRunning;
  autoSnapshotRunning = doRunAutoSnapshot(trigger).finally(() => { autoSnapshotRunning = null; });
  return autoSnapshotRunning;
}

// 启动补跑：距上次快照 >50 分钟则立即补一份。定时 alarm 在浏览器关闭期间
// 不触发，开机首次启动兜底（与 createSnapshot 内部闸门叠加，双保险）。
// 放在 oneTimeWipe 之后调用——wipe 成功时本地已空，createSnapshot 自然跳过
// （跳过原因同样写进 autoSnapshotStatus，不再无声无息）。
async function ensureSnapshotFresh() {
  try {
    const r = await chrome.storage.local.get('lastSnapshotAt');
    if (Date.now() - (r.lastSnapshotAt || 0) > 50 * 60 * 1000) {
      await runAutoSnapshot('startup');
    }
  } catch (e) {
    // 读取存储失败也应留痕：快照链路整体不可用，不能假装一切正常
    await recordAutoSnapshot({
      ok: false,
      reason: '启动补跑读取失败：' + ((e && e.message) || e),
      trigger: 'startup',
    });
  }
}

// ===== 一次性彻底清空（v0.3.0 重置）：本地 + 云端全部数据 =====
// 触发点 1：版本更新（reason=update）时自动执行——用户无感知，重载即生效
// 触发点 2：每次浏览器启动（onStartup）兜底重试——防止 onInstalled 时断网导致清空失败
// （P1 修复 2026-10-18：触发入口已收敛，执行权只剩以上两个 SW 生命周期事件。）
// 原触发点 3（页面加载发 'one-time-wipe' 消息触发）已改为【只等待、不触发】：
//   历史演进——2026-10-17 修启动竞态：页面自身不直跑 sync.js 的 oneTimeWipe
//   （页面与 SW 各持一个模块实例，同时跑会并发双清空、交叉 remove(['notes'])）；
//   2026-10-18 修漏戳误清（P1）：页面加载触发清空的路径整个移除——任一次页面
//   加载读漏戳即清空当期活数据（QA 实证 1/5），现由消息处理器等待在途清空
//   （见 onMessage 处注释），过期戳数据存活到下次浏览器启动才清，宁可晚清不可误清。
// 全新安装（reason=install）不清云端：保留云端数据，重装后可恢复
chrome.runtime.onInstalled.addListener(async (details) => {
  await safeEnsureAlarm();
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
  await ensureSnapshotFresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await safeEnsureAlarm();
  try { await oneTimeWipe(); } catch (_) { /* 已打戳则无事发生；失败则下次重试 */ }
  await ensureSnapshotFresh();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // alarm 事件本身就是 SW 被唤醒的证据：顺手自愈被旧版本/异常弄丢的定时器
  await safeEnsureAlarm();
  if (alarm.name === 'hourlySnapshot') {
    // v0.5.22：与启动补跑同口径（显式配置优先 + 在用 profile 受限回退），
    // 失败/跳过全部留痕，不再静默 return
    await runAutoSnapshot('alarm');
    return;
  }
  if (alarm.name !== 'dailyBackup') return;
  const s = await getSettings();
  if (s && s.ak) {
    await backupRecent(s, 7);
    await chrome.storage.local.set({ lastBackup: Date.now() });
  }
});
