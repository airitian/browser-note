import { getSettings, saveSettings } from '../lib/storage.js';
import { pullSync, createSnapshot, listSnapshots, rollbackTo, addPendingSnapshot } from '../lib/sync.js';
import {
  getGithubBackupConfig, saveGithubBackupConfig, validateRepo,
  getGithubBackupStatus, markGithubPullOk, requestFullBackup,
} from '../lib/github-backup.js';
import { readLiveStatus } from '../lib/live.js';

const $ = (id) => document.getElementById(id);

// 相对时间：1 小时内显示分钟，24 小时内显示小时，更早显示月日时分
function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function absTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function showSnapTip(text) {
  const tip = $('snapTip');
  tip.textContent = text;
  tip.hidden = false;
  clearTimeout(showSnapTip._t);
  showSnapTip._t = setTimeout(() => { tip.hidden = true; }, 4000);
}

// 自动快照留痕（v0.5.22）：后台每次尝试都写 chrome.storage.local.autoSnapshotStatus
// = {at, ok, reason, trigger, snapshotAt}。历史事故：v0.5.21 及以前后台取不到配置
// 或闸门未过时直接静默跳过，用户只看到"快照一直没有"却无从排查；这里把成功时间
// 与失败/跳过原因直接摆出来，用户可自查"自动快照到底跑没跑、为什么没跑"。
function snapTriggerText(trigger) {
  return trigger === 'alarm' ? '定时' : trigger === 'startup' ? '启动补跑' : '后台';
}

async function renderAutoSnapStatus() {
  const box = $('autoSnapStatus');
  if (!box) return; // 老版本 HTML 缺元素时不打断初始化
  let r = {};
  try {
    r = await chrome.storage.local.get(['autoSnapshotStatus', 'lastSnapshotAt']);
  } catch (_) { /* 存储不可用：展示降级文案，不抛错 */ }
  const st = r.autoSnapshotStatus;
  const last = r.lastSnapshotAt || 0;
  box.hidden = false;
  if (!st || typeof st.at !== 'number') {
    box.className = 'snap-status';
    box.textContent = '自动快照：尚无运行记录（每小时一次，浏览器启动也会补跑）。';
    return;
  }
  const when = absTime(st.at);
  const trigger = snapTriggerText(st.trigger);
  if (st.ok) {
    box.className = 'snap-status ok';
    box.textContent = `上次自动快照：${absTime(st.snapshotAt || st.at)}（${trigger}，尝试于 ${when}）`
      + (last ? `；最近一次快照（含手动）：${absTime(last)}` : '');
  } else {
    box.className = 'snap-status fail';
    box.textContent = `上次自动快照失败：${st.reason || '未知原因'}（${when}，${trigger}）`
      + (last ? `；最近一次成功快照：${absTime(last)}` : '；尚无成功快照');
  }
}

// 后台写入状态时实时刷新，用户开着设置页也能看到自动快照的结果
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.autoSnapshotStatus) renderAutoSnapStatus();
  // GitHub 全量备份状态由 SW 写入，开着设置页也能实时看到手动/每日结果
  if (changes.githubBackupStatus) renderGithubBackupStatus();
  if (changes.githubBackup) refreshGithubConfigForm();
  // 实时通道状态（推送写入 / 拉取命中与否）
  if (changes.liveSyncStatus) renderLiveStatus();
});

// ===== 实时同步通道状态（v0.5.28）=====
// 通道命中与否是用户判断「另一台浏览器能不能立刻看到」的唯一客观依据，
// 必须显式呈现：pullMode='live' 说明拉取走的是实时快照（秒级可见），
// 'fallback' 说明实时通道不可用、已退回普通索引通道（CDN 缓存，可能延迟数分钟）。
async function renderLiveStatus() {
  const box = $('liveStatus');
  if (!box) return;
  let st = {};
  try {
    st = await readLiveStatus();
  } catch (_) { /* 存储不可用：展示降级文案 */ }
  box.hidden = false;
  const pushPart = st.pushAt
    ? `上次推送实时快照：${absTime(st.pushAt)}`
    : '尚未写入实时快照';
  if (st.pullMode === 'live') {
    box.className = 'snap-status ok';
    box.textContent = `实时通道：正常。${pushPart}；上次拉取命中实时快照（${relTime(st.pullAt)}），另一台浏览器可秒级看到。`;
  } else if (st.pullMode === 'fallback') {
    box.className = 'snap-status fail';
    box.textContent = `实时通道：已回退到普通索引通道${st.error ? '（' + st.error + '）' : ''}。${pushPart}。`
      + '此状态下另一台浏览器可能需等待数分钟才能看到新内容。';
  } else {
    box.className = 'snap-status';
    box.textContent = `实时通道：${pushPart}。下次拉取后这里会显示是否命中。`;
  }
}

// ===== GitHub 全量备份独立卡片（v0.5.23）=====
// 配置/状态/令牌全部走独立 storage key：设置页上方 saveSettings 构造的是固定
// 五字段整体覆盖，七牛配置一旦与 GitHub 配置同键保存就会被擦掉；SW 的
// getSnapshotSettings() 还依赖 settings.ak 空 = 主动关闭语义，更不能混写。
function flashGhTip(tip, text, ok) {
  if (!tip) return;
  tip.textContent = text;
  tip.className = ok ? 'saved-tip' : 'snap-status fail';
  tip.hidden = false;
  // 计时器挂在各自元素上：两个提示区若共用一个 timer，后一条会取消前一条的
  // 隐藏回调，导致前一条永远留在页面上（历史 saved/snapTip 也踩过同类坑）
  clearTimeout(tip._hideTimer);
  tip._hideTimer = setTimeout(() => { tip.hidden = true; }, 6000);
}

function showGhSavedTip(text, ok = true) {
  flashGhTip($('ghSavedTip'), text, ok);
}

function showGhBackupTip(text, ok = true) {
  flashGhTip($('ghBackupTip'), text, ok);
}

// 令牌字段永不回显已存值：只填占位说明，留空保存即保持原令牌。
// 明文 PAT 一旦渲染进 DOM（哪怕 type=password）就是多一个肩窥/截图外泄面。
async function refreshGithubConfigForm() {
  const owner = $('ghOwner');
  const repo = $('ghRepo');
  const deviceName = $('ghDeviceName');
  const token = $('ghToken');
  if (!owner || !repo || !deviceName || !token) return;
  let cfg;
  try {
    cfg = await getGithubBackupConfig();
  } catch (_) { return; }
  owner.value = cfg.owner || '';
  repo.value = cfg.repo || '';
  deviceName.value = cfg.deviceName || '';
  token.value = '';
  token.placeholder = cfg.token ? '已配置，留空则不修改' : '粘贴 fine-grained PAT';
}

async function renderGithubBackupStatus() {
  const box = $('ghStatus');
  if (!box) return;
  let data = { status: null, lastDate: '' };
  try {
    data = await getGithubBackupStatus();
  } catch (_) { /* 存储不可用：展示降级文案，不抛错 */ }
  const st = data.status;
  box.hidden = false;
  if (!st || typeof st.at !== 'number') {
    box.className = 'snap-status';
    box.textContent = 'GitHub 全量备份：尚无运行记录。保存配置后可手动触发，或等每日首次打开自动执行。';
    return;
  }
  const when = absTime(st.at);
  if (st.running) {
    // MV3 可能在长流程中回收 SW：停在 running 就是中断信号，不伪装成成功
    box.className = 'snap-status';
    box.textContent = `GitHub 全量备份进行中（开始于 ${when}）…若长时间不更新，`
      + '可能已被浏览器中断，下次打开笔记会自动重试。';
    return;
  }
  const skippedCount = st.skippedAssetCount || (st.skippedAssets ? st.skippedAssets.length : 0);
  const skipped = skippedCount
    ? '；跳过原图 ' + skippedCount + ' 张：'
      + (st.skippedAssets || []).slice(0, 5)
        .map((s) => s.name + '（' + s.reason + '）').join('、')
    : '';
  if (st.ok) {
    box.className = 'snap-status ok';
    box.textContent = `上次全量备份成功：${when}（${st.trigger === 'daily' ? '每日自动' : '手动'}，`
      + `${st.noteCount || 0} 篇 / ${st.assetCount || 0} 张原图，`
      + `${st.committed ? '已提交' : '内容无差异未提交'}）`
      + (st.reason ? '；' + st.reason : '') + skipped
      + (data.lastDate ? `；UTC ${data.lastDate} 已执行` : '');
  } else {
    box.className = 'snap-status fail';
    box.textContent = `上次全量备份失败：${st.reason || '未知原因'}（${when}）`
      + (/令牌失效|401|403/.test(st.reason || '') ? '，请重新配置 fine-grained PAT' : '')
      + skipped;
  }
}

// 渲染快照列表（新→旧，最多 30 条）。无密钥/无快照/拉取失败都有明确空态。
// listSnapshots 已合并本地 pending（CDN 延迟期间刚建的快照）——这里只负责
// 把 pending 条目标出来（「生效中」+ 回退按钮 title 说明），让用户知道
// 它不是坏了，是云端 CDN 还在传播
async function refreshSnapshots() {
  const box = $('snapList');
  const s = await getSettings();
  if (!s.ak) {
    box.innerHTML = '<p class="hint">配置并保存七牛密钥后可用。</p>';
    return;
  }
  let list = [];
  try {
    list = await listSnapshots(s);
  } catch (_) { /* listSnapshots 已内部容错，双保险 */ }
  if (!list.length) {
    box.innerHTML = '<p class="hint">暂无快照。每小时自动保存一份，也可点上方按钮立即创建。</p>';
    return;
  }
  const pend = new Set((await chrome.storage.local.get('pendingSnapshots')).pendingSnapshots?.map((e) => e.at) || []);
  box.innerHTML = '';
  for (const e of list.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'snap-row';
    const time = document.createElement('span');
    time.className = 'snap-time';
    time.textContent = `${absTime(e.at)}（${relTime(e.at)}）`;
    const meta = document.createElement('span');
    meta.className = 'snap-meta';
    meta.textContent = `${e.auto ? '自动' : '手动'} · ${e.n} 条`;
    const btn = document.createElement('button');
    btn.textContent = '回退';
    if (pend.has(e.at)) {
      // 刚从 CDN 延迟期顶上的条目：按钮仍可点（rollbackTo 有下载重试），
      // 但明确告知生效窗口，失败时用户知道该等而不是重试
      meta.textContent += ' · 生效中';
      btn.title = '快照已存入云端，CDN 正在传播（通常几分钟）。若回退失败请稍后重试';
    }
    btn.onclick = async () => {
      // 回退是破坏性操作：confirm 里讲清三条——安全网、传播范围、不可撤销性
      const ok = confirm(`确定把笔记回退到 ${absTime(e.at)} 的状态吗？\n\n`
        + '· 当前数据会先自动存为一份快照，可随时再回退回来\n'
        + '· 其他浏览器下次同步时会采用这个状态\n'
        + '· 回退后新建的笔记会被删除（以墓碑形式同步）');
      if (!ok) return;
      btn.disabled = true;
      try {
        const r = await rollbackTo(s, e.at);
        if (r.safety) await addPendingSnapshot(r.safety); // 安全网快照也顶着延迟立即显示
        showSnapTip(`已回退：恢复 ${r.restored} 条`
          + (r.tombstoned ? `，删除回退后新建的 ${r.tombstoned} 条` : ''));
      } catch (err) {
        showSnapTip('回退失败：' + (err && err.message ? err.message : err));
      }
      btn.disabled = false;
      refreshSnapshots();
    };
    row.append(time, meta, btn);
    box.appendChild(row);
  }
}

$('snapNow').onclick = async () => {
  const s = await getSettings();
  if (!s.ak) { showSnapTip('请先保存七牛密钥'); return; }
  try {
    const r = await createSnapshot(s, { auto: false });
    if (r) {
      await addPendingSnapshot(r); // 立即顶上列表，不等 CDN 索引刷新
      showSnapTip(`快照已创建（${r.n} 条）——已存入云端，列表重开本页刷新`);
    } else {
      showSnapTip('本地为空或未完成首次拉取，已跳过');
    }
  } catch (err) {
    showSnapTip('创建失败：' + (err && err.message ? err.message : err));
  }
  refreshSnapshots();
  renderAutoSnapStatus(); // 手动快照会更新 lastSnapshotAt，状态栏同步刷新
};

(async () => {
  const s = await getSettings();
  $('ak').value = s.ak || '';
  $('sk').value = s.sk || '';
  $('bucket').value = s.bucket || '';
  $('domain').value = s.domain || '';
  $('region').value = s.region || 'z2';
  renderAutoSnapStatus();
  refreshSnapshots();
  refreshGithubConfigForm();
  renderGithubBackupStatus();
  renderLiveStatus();
})();

$('saveSettings').onclick = async () => {
  const s = {
    ak: $('ak').value.trim(),
    sk: $('sk').value.trim(),
    bucket: $('bucket').value.trim(),
    domain: $('domain').value.trim(),
    region: $('region').value,
  };
  await saveSettings(s);
  // 配好密钥立即从云端拉取一次（只拉不推——此刻本地可能还是空的，推送会按
  // 「本地权威覆盖」把云端索引打小）。拉取可达（含云端无索引）落 lastPullAt，
  // 推送闸门由此放行；失败不影响保存，主页面打开时会重试
  if (s.ak) {
    try {
      const st = await pullSync(s);
      if (st !== 'error') await chrome.storage.local.set({ lastPullAt: Date.now() });
    } catch (_) { /* 拉取失败不阻塞保存提示 */ }
  }
  const tip = $('saved');
  tip.hidden = false;
  setTimeout(() => (tip.hidden = true), 1500);
  refreshSnapshots();
};

// GitHub 配置独立保存按钮：独立校验，绝不走上方固定五字段的 saveSettings。
// 校验失败不保存、不反复弹窗——只用行内 tip 且按钮在途禁用（节流）。
let ghSaveBusy = false;
$('ghSaveConfig').onclick = async () => {
  if (ghSaveBusy) return;
  const btn = $('ghSaveConfig');
  const token = $('ghToken').value.trim();
  const owner = $('ghOwner').value.trim();
  const repo = $('ghRepo').value.trim();
  const deviceName = $('ghDeviceName').value.trim();
  let cur;
  try {
    cur = await getGithubBackupConfig();
  } catch (e) {
    showGhSavedTip('读取本地配置失败：' + ((e && e.message) || e), false);
    return;
  }
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    showGhSavedTip('Owner / Repo 只能含字母、数字、点、下划线、连字符，且不能为空', false);
    return;
  }
  if (!token && !cur.token) {
    showGhSavedTip('请填写 GitHub fine-grained PAT（只勾该仓库 Contents 读写）', false);
    return;
  }
  ghSaveBusy = true;
  btn.disabled = true;
  try {
    const realToken = token || cur.token;
    const check = await validateRepo(realToken, owner, repo);
    // 保存令牌只在校验通过后进行：仓库非私有 / 401 / 403 一律不落盘
    await saveGithubBackupConfig({
      token: realToken, owner, repo, deviceName, branch: check.defaultBranch,
    });
    // 配置保存后仍需七牛拉取成功才允许备份。这里主动拉一次（只拉不推），
    // 成功落 lastPullAt + 独立 githubBackupPullOkAt；失败不标戳、不阻塞保存。
    let pulled = false;
    const s = await getSettings();
    if (s.ak) {
      try {
        const st = await pullSync(s);
        if (st !== 'error') {
          await chrome.storage.local.set({ lastPullAt: Date.now() });
          pulled = true;
        }
      } catch (_) { /* 拉取异常按失败处理：不标戳 */ }
    }
    if (pulled) await markGithubPullOk();
    showGhSavedTip(pulled
      ? '配置已保存，拉取成功，可立即全量备份'
      : '配置已保存，但七牛拉取未成功，备份暂缓（打开笔记页会自动重试拉取）', true);
  } catch (e) {
    const kind = e && e.kind;
    const msg = kind === 'auth'
      ? '令牌失效或权限不足（401/403），请重新生成 fine-grained PAT（只勾该仓库 Contents 读写）'
      : kind === 'private'
        ? '该仓库不是私有仓库，已拒绝保存：明文笔记不能推到公开仓库'
        : kind === 'network'
          ? '校验失败：网络不可达，请稍后重试（配置未保存）'
          : '校验失败：' + ((e && e.message) || e);
    showGhSavedTip(msg, false);
  } finally {
    ghSaveBusy = false;
    btn.disabled = false;
    refreshGithubConfigForm();
    renderGithubBackupStatus();
  }
};

$('ghBackupNow').onclick = async () => {
  const btn = $('ghBackupNow');
  let cfg;
  try {
    cfg = await getGithubBackupConfig();
  } catch (e) {
    showGhBackupTip('读取本地配置失败：' + ((e && e.message) || e), false);
    return;
  }
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    showGhBackupTip('请先保存 GitHub 备份配置', false);
    return;
  }
  btn.disabled = true;
  showGhBackupTip('正在拉取并全量备份，请勿关闭设置页…', true);
  try {
    // 手动按钮同样先 pullSync 成功再备份：没拉取过的浏览器本地视图不完整，
    // 此刻做全量镜像会漏笔记（与 ensurePulled / createSnapshot 同款闸门）。
    const s = await getSettings();
    const st = await pullSync(s);
    if (st === 'error') {
      showGhBackupTip('七牛拉取失败，已暂停备份（本地视图可能不完整）', false);
      return;
    }
    await chrome.storage.local.set({ lastPullAt: Date.now() });
    await markGithubPullOk();
    const r = await requestFullBackup('manual');
    showGhBackupTip(r && r.ok
      ? (r.reason || '全量备份完成')
      : '备份失败：' + ((r && r.reason) || '未知原因'), !!(r && r.ok));
  } catch (e) {
    showGhBackupTip('备份失败：' + ((e && e.message) || e), false);
  } finally {
    btn.disabled = false;
    renderGithubBackupStatus();
  }
};
