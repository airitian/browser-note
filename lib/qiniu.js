// 七牛云存储访问层：AWS Signature V4 over S3 兼容接口（零构建、零依赖）
//
// 背景（2026-11）：七牛两个 *.hn-bkt.clouddn.com 测试域名被官方回收
// （CNAME 到 testdomain-offline.qiniu.in → 127.0.0.1），私有空间下载全部失效；
// 上传与 rsf 列举仍正常，但用户没有自定义域名可绑。改用 Kodo 的 S3 兼容 API
// （path-style: https://s3.<region>.qiniucs.com/<bucket>/<key>），签名走 SigV4，
// 完全不依赖任何绑定 CDN 域名——这是本次改造的全部理由。
//
// 实现要点：Web Crypto（crypto.subtle）做 SHA-256 / HMAC-SHA256，SignedHeaders
// 固定 host;x-amz-content-sha256;x-amz-date；GET payload hash 为空串 sha256，
// PUT 用真实 body 的 sha256。签名里的 host 来自参数，但浏览器禁止 fetch 手动
// 设置 Host 头——故返回的 headers 不含 Host，浏览器按 URL 自动填，签名一致。
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

// ===== 以下旧协议工具保留兼容（新 S3 路径不再使用）=====
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

// 管理 API 的签名串为「path + query + '\n'」（以换行结尾），与下载/上传的签名格式不同。
// 返回 <AK>:<encSign>，"QBox " 前缀由调用方在请求头添加
export async function makeQBoxToken(ak, sk, signStr) {
  const sign = await hmacSha1(sk, signStr);
  return ak + ':' + bytesToB64url(sign);
}

// ===== AWS Signature V4（Web Crypto 版）=====
// 空 body 的 sha256，GET / ListObjectsV2 用它作 payload hash
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// 七牛 region → S3 region（endpoint: s3.<region>.qiniucs.com）
const S3_REGIONS = {
  z0: 'cn-east-1',
  z1: 'cn-north-1',
  z2: 'cn-south-1',
  na0: 'us-north-1',
  as0: 'ap-southeast-1',
};

function s3Context(settings = {}) {
  // s3Region 显式指定优先；否则按旧 region 映射；兜底 cn-south-1
  const region = settings.s3Region || S3_REGIONS[settings.region] || 'cn-south-1';
  return { region, host: 's3.' + region + '.qiniucs.com' };
}

// RFC3986 编码：encodeURIComponent 漏掉 !'()* 这几个非保留字符，SigV4 要求一并编码
function awsEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => (
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  ));
}

// CanonicalQueryString：按编码后的 key 排序，name/value 均 RFC3986 编码
function canonicalQuery(params) {
  return Object.keys(params).sort()
    .map((k) => awsEncode(k) + '=' + awsEncode(params[k]))
    .join('&');
}

// path-style 对象路径：每段单独编码，保留 '/' 分隔符
function objectPath(bucket, key) {
  return '/' + awsEncode(bucket) + '/' + String(key).split('/').map(awsEncode).join('/');
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(key, data) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

// 生成 SigV4 请求头（Authorization / X-Amz-Date / X-Amz-Content-Sha256）。
// query 为已编码且已按 key 排序的 CanonicalQueryString；无 query 传 ''。
// 注意：不能把 Host 放进返回对象——浏览器禁止 fetch 设置 Host 头（forbidden header），
// 但签名串里必须含 host:<host>，二者按 URL 保持一致即可
async function awsSigV4Headers({ method, host, path, query = '', payload = '', ak, sk, region }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = payload ? await sha256Hex(payload) : EMPTY_SHA256;
  const canonicalHeaders = 'host:' + host + '\n'
    + 'x-amz-content-sha256:' + payloadHash + '\n'
    + 'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmacSha256('AWS4' + sk, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = bytesToHex(await hmacSha256(kSigning, stringToSign));
  return {
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + ak + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
  };
}

// S3 GET 文本：上传/下载共用（downloadJson 包一层 JSON.parse）。
// 404 错误文案以「下载失败 404」开头——sync.js 的 pullSync 依赖它区分
// 「云端无索引（全新用户）」与「远端不可达」，这个契约不能改
async function s3GetText(key, settings) {
  const { region, host } = s3Context(settings);
  const path = objectPath(settings.bucket, key);
  const headers = await awsSigV4Headers({
    method: 'GET', host, path, ak: settings.ak, sk: settings.sk, region,
  });
  const res = await fetchWithTimeout('https://' + host + path, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('下载失败 ' + res.status + ' ' + text);
  }
  return res.text();
}

// 上传任意 JSON 对象到 bucket 的指定 key（S3 PUT）。
// 老实现返回 res.json()；S3 PUT 成功是空 body，这里返回 {} 保持"可解析对象"
// 的形状——所有现有调用方都忽略返回值，但留兼容余量避免将来误用 .json() 出错
export async function uploadJson(key, obj, settings) {
  const { region, host } = s3Context(settings);
  const payload = JSON.stringify(obj);
  const path = objectPath(settings.bucket, key);
  const headers = await awsSigV4Headers({
    method: 'PUT', host, path, payload, ak: settings.ak, sk: settings.sk, region,
  });
  const res = await fetchWithTimeout('https://' + host + path, {
    method: 'PUT', headers, body: payload,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('上传失败 ' + res.status + ' ' + text);
  }
  const text = await res.text().catch(() => '');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (_) { return {}; }
}

// 下载 JSON 对象（S3 GET + JSON.parse）
export async function downloadJson(key, settings) {
  const text = await s3GetText(key, settings);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('下载内容不是合法 JSON：' + ((e && e.message) || e));
  }
}

// 下载纯文本（Markdown 文章，S3 GET + res.text()）
export async function downloadText(key, settings) {
  return s3GetText(key, settings);
}

// XML 实体解码（S3 ListObjectsV2 的 Key 可能含 &amp; 等；&amp; 最后解避免二次解码）
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// ListObjectsV2 XML → 旧 rsf items 形状：
//   {key, fsize, putTime}，putTime 保持旧代码的 100ns 单位
//   （lib/articles.js 用 Math.floor(putTime / 10000) 还原毫秒；
//    S3 只给 LastModified ISO 时间，先转毫秒再 ×10000）
function parseListObjectsV2(xml) {
  const items = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const t = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return t ? decodeXml(t[1]) : '';
    };
    const key = pick('Key');
    if (!key) continue;
    const fsize = Number(pick('Size') || 0) || 0;
    const ms = Date.parse(pick('LastModified') || '');
    items.push({ key, fsize, putTime: Math.floor((Number.isFinite(ms) ? ms : 0) * 10000) });
  }
  return items;
}

// 列举空间文件（S3 ListObjectsV2，path-style）。返回 items 数组，形状与旧 rsf 版一致：
// [{key, fsize, putTime}]，putTime 为 100ns 单位。
// prefix 走 CanonicalQueryString 参与签名；截断时按 NextContinuationToken 翻页，
// 20 页上限防异常 token 导致无限循环（每页最多 1000 条）
export async function listKeys(ak, sk, { bucket, prefix = '', limit = 1000, region: regionOpt = '' } = {}) {
  const { region, host } = s3Context({ region: regionOpt });
  const path = '/' + awsEncode(bucket);
  const items = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const params = { 'list-type': '2', prefix };
    if (token) params['continuation-token'] = token;
    const query = canonicalQuery(params);
    const headers = await awsSigV4Headers({
      method: 'GET', host, path, query, ak, sk, region,
    });
    const res = await fetchWithTimeout('https://' + host + path + '?' + query, { headers });
    const xml = await res.text().catch(() => '');
    if (!res.ok) throw new Error('列举失败 ' + res.status + ' ' + xml);
    items.push(...parseListObjectsV2(xml));
    const truncated = xml.match(/<IsTruncated>([^<]*)<\/IsTruncated>/);
    if (!truncated || !/^true$/i.test(truncated[1].trim())) break;
    const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    if (!next || !next[1]) break;
    token = decodeXml(next[1]);
  }
  return items.slice(0, limit);
}
