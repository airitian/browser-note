// 七牛云 KODO 直传：Web Crypto 签上传凭证 + fetch 上传/下载（零依赖）
const enc = new TextEncoder();

// 超时保护：网络挂起时快速失败并抛出，防止调用方（尤其启动流程）被无限期阻塞
export function fetchWithTimeout(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function bytesToB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // 七牛要求保留 base64 的 '=' 填充（与官方 SDK 一致），只替换 +/ 为 -_
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}

async function hmacSha1(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

// 生成上传凭证：<AccessKey>:<encodedSign>:<encodedPutPolicy>
// 注意：上传凭证没有 "QBox " 前缀（那是管理 API 的签名格式）
export async function makeUploadToken(ak, sk, scope, deadline) {
  const policy = JSON.stringify({ scope, deadline });
  const encPolicy = bytesToB64url(enc.encode(policy));
  const sign = await hmacSha1(sk, encPolicy);
  const encSign = bytesToB64url(sign);
  return ak + ':' + encSign + ':' + encPolicy;
}

const UPLOAD_HOSTS = {
  z0: 'https://upload.qiniup.com',
  z1: 'https://upload-z1.qiniup.com',
  z2: 'https://upload-z2.qiniup.com',
  na0: 'https://upload-na0.qiniup.com',
  as0: 'https://upload-as0.qiniup.com',
};

export function uploadHost(region) {
  return UPLOAD_HOSTS[region] || 'https://upload.qiniup.com';
}

// 上传任意 JSON 对象到 bucket 的指定 key
export async function uploadJson(key, obj, settings) {
  const scope = settings.bucket + ':' + key;
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const token = await makeUploadToken(settings.ak, settings.sk, scope, deadline);
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const form = new FormData();
  form.append('token', token);
  form.append('key', key);
  form.append('file', blob);
  const res = await fetchWithTimeout(uploadHost(settings.region), { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('上传失败 ' + res.status + ' ' + text);
  }
  return res.json();
}

// 从空间域名下载对象。
// 1) browser-note 是私有空间：必须带下载凭证 token=<AK>:<encSign>（保留 '=' 填充）
// 2) 七牛测试域名（clouddn.com）HTTPS 证书与域名不匹配，只能走 http；
//    以后绑定自定义域名且有有效证书时，可改回 https。
export async function downloadJson(key, settings) {
  const base = 'http://' + settings.domain + '/' + key;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const urlWithE = base + '?e=' + deadline;
  const sign = await hmacSha1(settings.sk, urlWithE);
  const encSign = bytesToB64url(sign);
  const res = await fetchWithTimeout(urlWithE + '&token=' + settings.ak + ':' + encSign);
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  return res.json();
}

// ===== 管理 API（QBox 签名）=====
// 管理 API 的签名串为「path + query + '\n'」（以换行结尾），与下载/上传的签名格式不同。
// 返回 <AK>:<encSign>，"QBox " 前缀由调用方在请求头添加
export async function makeQBoxToken(ak, sk, signStr) {
  const sign = await hmacSha1(sk, signStr);
  return ak + ':' + bytesToB64url(sign);
}

// 列举空间文件（rsf 管理 API）。返回 items 数组：
// [{key, fsize, mimeType, putTime}]，其中 putTime 单位为 100ns（转毫秒需 /10000）。
// CORS：rsf.qiniuapi.com 实测带 Access-Control-Allow-Origin: *，扩展页可直接 fetch
export async function listKeys(ak, sk, { bucket, prefix = '', limit = 1000 }) {
  let signStr = '/list?bucket=' + bucket + '&limit=' + limit;
  if (prefix) signStr += '&prefix=' + encodeURIComponent(prefix);
  const token = await makeQBoxToken(ak, sk, signStr + '\n');
  const res = await fetchWithTimeout('https://rsf.qiniuapi.com' + signStr, {
    headers: { Authorization: 'QBox ' + token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('列举失败 ' + res.status + ' ' + text);
  }
  const data = await res.json();
  return data.items || [];
}

// 与 downloadJson 同一套签名逻辑（完整 URL + ?e= + &token=），但按纯文本返回
// （用于下载 Markdown 文章）。settings 只需 {ak, sk, domain}
export async function downloadText(key, settings) {
  const base = 'http://' + settings.domain + '/' + key;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const urlWithE = base + '?e=' + deadline;
  const sign = await hmacSha1(settings.sk, urlWithE);
  const encSign = bytesToB64url(sign);
  const res = await fetchWithTimeout(urlWithE + '&token=' + settings.ak + ':' + encSign);
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  return res.text();
}
