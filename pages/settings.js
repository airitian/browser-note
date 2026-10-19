import { getSettings, saveSettings } from '../lib/storage.js';
import { pullSync, createSnapshot, listSnapshots, rollbackTo, addPendingSnapshot } from '../lib/sync.js';

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
};

(async () => {
  const s = await getSettings();
  $('ak').value = s.ak || '';
  $('sk').value = s.sk || '';
  $('bucket').value = s.bucket || '';
  $('domain').value = s.domain || '';
  $('region').value = s.region || 'z2';
  refreshSnapshots();
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
