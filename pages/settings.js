import { getSettings, saveSettings } from '../lib/storage.js';
import { pullSync } from '../lib/sync.js';

const $ = (id) => document.getElementById(id);

(async () => {
  const s = await getSettings();
  $('ak').value = s.ak || '';
  $('sk').value = s.sk || '';
  $('bucket').value = s.bucket || '';
  $('domain').value = s.domain || '';
  $('region').value = s.region || 'z2';
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
};
