// 七牛云 KODO 原生协议访问层：表单上传 + 私有下载 URL + rsf 管理 API（零构建、零依赖）
//
// 历史背景（务必保留这段说明，避免后人再走回头路）：
//   1) 项目最初就用七牛原生协议（表单上传 + 私有下载 URL + rsf 列举）。
//   2) 2026-11 旧 *.hn-bkt.clouddn.com 测试域名被官方回收（CNAME 到
//      127.0.0.1），私有下载全挂；当时无自定义域名，57ca46c/6620d21/
//      0583c9c 改走 S3 兼容接口（AWS SigV4，不依赖 CDN 域名）。
//   3) 随后 S3 下载开始计费 → v0.5.20 回退原生链接协议；数据从
//      z2/browser-note 迁到 na0/video2notehaiwai 并准备自定义域名
//      video.ainitian.cyou，但该域名 DNS 始终是 NXDOMAIN。
//   4) 2026-11-26 用户改用 z2 新空间 video2note-20261123 自带的测试域名
//      towwe5yxn.hn-bkt.clouddn.com：先全量复制 229 个对象（含 141 个
//      video2note/ 文章）再切协议。测试域名证书与域名不匹配（实测
//      ERR_TLS_CERT_ALTNAME_INVALID），故此类域名下载必须走 http；
//      自定义域名仍走 https。这个 scheme 判断不能删，否则下载全挂。
//
// 对外契约（不可破坏）：
//   - uploadJson 返回 {hash, key}（hash 从响应 .hash 取，无则空串）
//   - downloadJson / downloadText 的 404 文案以「下载失败 404」开头；
//     lib/sync.js 的 pullSync 靠它区分「全新用户」与「远端不可达」
//   - listKeys 返回 [{key, fsize, putTime}] 数组（putTime 为 100ns），
//     并挂不可枚举的 .items 自引用，兼容 {items:[...]} 两种读法
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

// ===== 上传（表单直传）=====
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

// 上传任意 JSON 对象到 bucket 的指定 key（七牛表单上传）。
// scope 用 '<bucket>:<key>' 而非整个 bucket：只允许覆盖这一个 key，
// 泄露凭证时把损害面压到最小；sync.js 各处的覆盖写需求也完全满足。
export async function uploadJson(key, obj, settings) {
  const scope = settings.bucket + ':' + key;
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const token = await makeUploadToken(settings.ak, settings.sk, scope, deadline);
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const form = new FormData();
  form.append('token', token);
  form.append('key', key);
  form.append('file', blob);
  const res = await fetchWithTimeout(uploadHost(settings.region), {
    method: 'POST', body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('上传失败 ' + res.status + ' ' + text);
  }
  // 返回契约 {hash, key}：原生响应体自带 hash；缺失时回退空串
  // （部分 QA mock 只给空响应体，不能让它们把调用方打挂）
  const data = await res.json().catch(() => ({}));
  return { hash: (data && data.hash) || '', key };
}

// ===== 下载（私有 URL 签名）=====
// 构造七牛私有下载链接并 GET。签名串是【带 ?e= 的完整 URL】，
// hmacSha1(SK, urlWithE) → base64url（保留 '=' 填充），
// 拼成 &token=<AK>:<encSign>。
// scheme 选择：七牛内置测试域名（*.clouddn.com）证书与域名不匹配，只能 http；
// 绑定的自定义域名有证书，走 https。两者签名串都要包含 scheme:// 前缀。
// 404 文案必须以「下载失败 404」开头——sync.js 的 pullSync 依赖它区分
// 「云端无索引（全新用户）」与「远端不可达」，这个契约不能改。
export function downloadScheme(domain) {
  return /\.clouddn\.com$/i.test(String(domain || '')) ? 'http' : 'https';
}

async function privateGet(key, settings) {
  const base = downloadScheme(settings.domain) + '://' + settings.domain + '/' + key;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const urlWithE = base + '?e=' + deadline;
  const sign = await hmacSha1(settings.sk, urlWithE);
  const encSign = bytesToB64url(sign);
  const url = urlWithE + '&token=' + settings.ak + ':' + encSign;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('下载失败 ' + res.status + (text ? ' ' + text : ''));
  }
  return res;
}

// 下载 JSON 对象（私有 URL + JSON.parse）
export async function downloadJson(key, settings) {
  const res = await privateGet(key, settings);
  try {
    return await res.json();
  } catch (_) {
    // 兼容只实现 text() 的 mock：S3 时代 QA mock 两种读法并存，
    // 这里优先 json()、失败回退 text()+JSON.parse，两种都成立。
    try {
      return JSON.parse(await res.text());
    } catch (e) {
      throw new Error('下载内容不是合法 JSON：' + ((e && e.message) || e));
    }
  }
}

// 下载纯文本（Markdown 文章，私有 URL + res.text()）
export async function downloadText(key, settings) {
  const res = await privateGet(key, settings);
  return res.text();
}

// ===== 管理 API（QBox 签名）=====
// 管理 API 的签名串为「path + query + '\n'」（以换行结尾），与下载/上传的签名格式不同。
// 返回 <AK>:<encSign>，"QBox " 前缀由调用方在请求头添加
export async function makeQBoxToken(ak, sk, signStr) {
  const sign = await hmacSha1(sk, signStr);
  return ak + ':' + bytesToB64url(sign);
}

// region → rsf 管理 API 域名。当前空间在 z2（华南），走 rsf.qiniuapi.com；
// na0 北美空间（历史迁移源）仍保留映射，便于临时探针跨区读取。
const RSF_HOSTS = {
  z0: 'rsf.qiniuapi.com',
  z1: 'rsf-z1.qiniuapi.com',
  z2: 'rsf.qiniuapi.com',
  na0: 'rsf-na0.qiniuapi.com',
  as0: 'rsf-as0.qiniuapi.com',
};

export function rsfHost(region) {
  return RSF_HOSTS[region] || RSF_HOSTS.z2;
}

// 列举空间文件（rsf 管理 API）。返回兼容双形状的结果：
//   - 数组本体为 [{key, fsize, putTime}]（putTime 保持 100ns 原始单位）
//   - 同时挂不可枚举的 .items 自引用，兼容 {items:[...]} 的读法
// CORS：rsf.qiniuapi.com / rsf-na0.qiniuapi.com 实测带 Access-Control-Allow-Origin: *
// 默认 region 用 z2：articles.js 列举文章时未显式传 region，必须指向当前空间。
export async function listKeys(ak, sk, { bucket, prefix = '', limit = 1000, region = 'z2' } = {}) {
  let signStr = '/list?bucket=' + bucket + '&limit=' + limit;
  if (prefix) signStr += '&prefix=' + encodeURIComponent(prefix);
  const token = await makeQBoxToken(ak, sk, signStr + '\n');
  const res = await fetchWithTimeout('https://' + rsfHost(region) + signStr, {
    headers: { Authorization: 'QBox ' + token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('列举失败 ' + res.status + ' ' + text);
  }
  const data = await res.json();
  const result = data.items || [];
  // 不可枚举自引用：JSON.stringify / deepEqual / Object.keys 仍按数组语义，
  // 但 result.items 也能读到同一数组（articles.js 用裸数组，QA mock 两种读法都有）
  Object.defineProperty(result, 'items', { value: result, enumerable: false, configurable: true });
  return result;
}
