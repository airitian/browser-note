import { getSettings, saveSettings } from '../lib/storage.js';

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
  const tip = $('saved');
  tip.hidden = false;
  setTimeout(() => (tip.hidden = true), 1500);
};
