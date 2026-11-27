// GitHub 私有仓库全量备份兜底（v0.5.23）：本地之外的第三副本。
// 笔记文件为 Markdown（notes/<id>.md），元数据放 YAML front matter；
// index.json / meta.json 仍是 JSON，原图仍是 assets/<imgId>。
//
// 设计约束（评审 8 冲突逐条规避，改动前务必读完）：
//  1) 本期没有删除入口：deleteNote() 在现有代码里零调用。仓库是「当前全量」镜像，
//     历史靠 git 提交；不做墓碑物理删、不做删除同步。
//  2) 令牌/配置/状态一律放独立 storage key（githubBackup / githubBackupStatus /
//     githubBackupLastFullDate / githubBackupPullOkAt），绝不并入 settings——
//     设置页 saveSettings 构造固定五字段整体覆盖，并入会被擦掉；SW 的
//     getSnapshotSettings() 对 ak 空有 disabled 语义，也不能被牵连。
//  3) 去重比对排除 meta.json：设备标识/备份时刻天然不同，纳入比对会让两台设备
//     同日互刷空提交。只比对 notes/*.md + index.json + assets/* 的内容 SHA。
//     日期戳用独立 UTC 自然日键，不复用 lastBackup（那是 24h 滚动且失败也标戳）。
//  4) 绝不实现「保存即推」：只有手动按钮 + 每日首开一条路径。
//  5) MV3 生命周期：页面只发消息，真正的 Git Data 流程在 SW 内执行；用
//     sendResponse 异步通道让 SW 保持存活。失败不标日期，下次打开自动重试。
//  6) host_permissions 新增 https://api.github.com/*（见 manifest.json）。
//  7) 原图存 img:<id>（data URL 字符串），提交为 assets/<id>，恢复时直接映射回
//     同名键。storage.local 只有 10MB 配额且已发生过 QUOTA_EXCEEDED，单文件/
//     总量超限就跳过并在状态里注明篇名与原因，绝不让整体备份崩掉。
//  8) 配置独立表单 + 独立保存按钮 + 独立校验：type=password 不回显已存令牌，
//     保存时 GET /repos/{owner}/{repo} 校验 private===true（见 validateRepo）。
//
// 令牌安全：fine-grained PAT 只授权该仓库 Contents 读写；只存 chrome.storage.local
// 的独立键，禁止写进 config.js 或任何入库文件；日志/提交信息/状态里都没有令牌。
import { getNotes } from './storage.js';
import { fetchWithTimeout } from './qiniu.js';

const API_ROOT = 'https://api.github.com';
const CONFIG_KEY = 'githubBackup';
const STATUS_KEY = 'githubBackupStatus';
const DATE_KEY = 'githubBackupLastFullDate';
const PULL_OK_KEY = 'githubBackupPullOkAt';

// 单张原图 2MB、总量 8MB 上限：GitHub blob 上限 100MB，真正的瓶颈是本地
// storage.local 10MB 配额；留余量防 Git Data 载荷过大拖死 MV3 service worker。
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 8 * 1024 * 1024;
const BLOB_CONCURRENCY = 4;
const enc = new TextEncoder();

let backupInFlight = null;

// ===== storage 读写（全部独立键，与七牛 settings 完全隔离）=====

export async function getGithubBackupConfig() {
  const r = await chrome.storage.local.get(CONFIG_KEY);
  const c = r[CONFIG_KEY] || {};
  return {
    token: typeof c.token === 'string' ? c.token : '',
    owner: typeof c.owner === 'string' ? c.owner : '',
    repo: typeof c.repo === 'string' ? c.repo : '',
    branch: typeof c.branch === 'string' && c.branch ? c.branch : 'main',
    deviceId: typeof c.deviceId === 'string' ? c.deviceId : '',
    deviceName: typeof c.deviceName === 'string' ? c.deviceName : '',
  };
}

function newDeviceId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 老浏览器兜底：随机 128bit，设备 ID 只是可追溯标签，不参与合并
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function saveGithubBackupConfig(patch = {}) {
  const old = await getGithubBackupConfig();
  const next = { ...old, ...patch };
  if (!next.deviceId) next.deviceId = newDeviceId();
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

export async function getGithubBackupStatus() {
  const r = await chrome.storage.local.get([STATUS_KEY, DATE_KEY]);
  return { status: r[STATUS_KEY] || null, lastDate: r[DATE_KEY] || '' };
}

// 成功拉取七牛后落戳，供页面与 SW 共读（跨上下文的「数据视图完整」信号）。
// 历史事故：pulledOk 曾只是 main.js 启动 IIFE 的局部变量，SW 完全看不到，
// 导致后台路径可能在未拉取的浏览器上写云。这里补一个持久化信号。
export async function markGithubPullOk() {
  await chrome.storage.local.set({ [PULL_OK_KEY]: Date.now() });
}

async function writeStatus(status) {
  try {
    await chrome.storage.local.set({ [STATUS_KEY]: status });
  } catch (e) {
    // 留痕本身是保险，绝不反过来阻断备份主流程（与 autoSnapshotStatus 同口径）
    console.warn('[browser-note] GitHub 备份状态写入失败：' + ((e && e.message) || e));
  }
}

// ===== GitHub API 最小封装 =====

function apiError(message, kind, status = 0) {
  const e = new Error(message);
  e.kind = kind || '';
  e.status = status;
  return e;
}

async function ghFetch(path, cfg, options = {}) {
  const method = options.method || 'GET';
  const body = options.body == null ? null : JSON.stringify(options.body);
  let res;
  try {
    res = await fetchWithTimeout(API_ROOT + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + cfg.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      ...(body ? { body } : {}),
    }, 30000);
  } catch (e) {
    // AbortError / 断网统一归为网络失败，状态页给明确分类
    throw apiError('网络失败：' + ((e && e.message) || e), 'network', 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 404 ? 'notfound'
        : res.status === 409 || res.status === 422 ? 'conflict' : 'api';
    throw apiError('GitHub API ' + res.status + ' ' + String(text).slice(0, 200), kind, res.status);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// 配置保存前的独立校验：必须存在、必须私有。
// 非私有直接拒绝保存——明文笔记推进公开仓库是不可逆的外泄，不能只"警告一下"。
// 401/403 明确提示重新配置 fine-grained PAT（只勾该仓库 Contents 读写）。
export async function validateRepo(token, owner, repo) {
  const cfg = { token, owner, repo };
  const data = await ghFetch(
    '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), cfg,
  );
  if (!data || typeof data !== 'object' || !data.full_name) {
    throw apiError('仓库不存在或令牌无权访问', 'notfound', 404);
  }
  if (data.private !== true) {
    throw apiError('仓库不是私有仓库，拒绝保存（明文笔记不可推到公开仓库）', 'private', 0);
  }
  return {
    private: true,
    fullName: data.full_name,
    defaultBranch: typeof data.default_branch === 'string' && data.default_branch
      ? data.default_branch : 'main',
  };
}

// ===== Git 对象哈希（零依赖 SHA-1，WebCrypto 不支持 digest('SHA-1')）=====
// 本地算 blob SHA 只为「免上传未变文件」的快速路径；真正写进 tree 的 sha
// 一律取 GitHub POST /git/blobs 的返回值，避免自己算错导致 422。

function sha1Hex(bytes) {
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0, k = 0;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, h0, false); odv.setInt32(4, h1, false); odv.setInt32(8, h2, false);
  odv.setInt32(12, h3, false); odv.setInt32(16, h4, false);
  return Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function gitBlobSha(content) {
  const bytes = enc.encode(content);
  const header = enc.encode('blob ' + bytes.length + '\0');
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  return sha1Hex(all);
}

// 稳定序列化：对象键排序，跨设备 / 跨写入顺序得到同一份内容，
// 否则 tree 比对会把"键顺序不同"误判成内容变更，两台设备同日互刷空提交。
function stableJson(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',') + ']';
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

async function contentHash(files) {
  const parts = files.map((f) => f.path + ':' + f.sha).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(parts));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ===== 全量内容组装 =====

// meta.json 不参与 tree 比对：设备名/备份时刻天然不同，纳入比对会让两台设备
// 同日互刷空提交。meta 里只写「内容版本时间」（最新 note 的 updatedAt），
// 墙上时钟时间放进提交信息。
function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ===== HTML → Markdown（v0.5.23 格式变更：笔记文件从 .json 改为 .md）=====
// 编辑器 getContent() 返回 innerHTML（lib/editor.js:187-189），备份仓库要的是人
// 可读的 Markdown。转换器零依赖、纯字符串处理（SW 里没有 DOMParser），且必须
// 确定性——Git tree 去重靠内容 SHA，同一段 HTML 必须永远得到同一段 MD。
// 覆盖：h1-h6 / 粗斜体 / 行内 code / fenced 代码块 / 链接 / 图片 /
// ul/ol / blockquote / hr / 段落与 br 换行 / 特殊字符转义 / 实体解码。
// 与 lib/articles.js 的 mdToHtml（MD→HTML）方向相反，但覆盖同一套语法子集。

function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (m, code) => {
      const hex = code[0].toLowerCase() === 'x';
      const cp = parseInt(hex ? code.slice(1) : code, hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    })
    .replace(/&amp;/gi, '&'); // amp 放最后，避免 &amp;lt; 被二次解码成标签
}

function stripTags(text) {
  return String(text == null ? '' : text).replace(/<[^>]*>/g, '');
}

// 只转义行内特殊字符，不碰行首 #/-/> ——块级标记由 hold() 占位保护，
// 若在这里转义行首会把我们刚生成的标题/列表/引用变成 \#、\-、\>。
function escapeMdChars(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]|])/g, '\\$1');
}

function attrOf(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i').exec(attrs || '');
  return m ? m[2] : '';
}

// 行内 HTML → MD。hold() 把已生成的 Markdown 用控制字符占位，
// 避免后续 escapeMdChars 把 **、`、[] 再转义一遍。
function inlineToMd(text, hold) {
  let t = String(text == null ? '' : text);
  // 行内代码先占位：里面的 * _ [ ] 不能当 Markdown 解释
  t = t.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) =>
    hold('`' + decodeEntities(stripTags(inner)).replace(/`/g, '\\`') + '`'));
  // 图片：正文里的缩略图 data URL 一律不内嵌，改写为指向仓库原图 assets/<id>。
  // 历史原因：内嵌缩略图让 MD 文件巨大且每次粘贴微变都触发提交，破坏 tree 去重。
  t = t.replace(/<img\b([^>]*)>/gi, (_m, attrs) => {
    const orig = attrOf(attrs, 'data-orig-id');
    const src = attrOf(attrs, 'src');
    const alt = escapeMdChars(decodeEntities(attrOf(attrs, 'alt')));
    const target = orig ? 'assets/' + orig : src;
    return hold('![' + alt + '](' + target + ')');
  });
  // 链接：只保留安全协议或相对路径，避免把 javascript: 写进备份仓库
  t = t.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, inner) => {
    const href = attrOf(attrs, 'href');
    const label = escapeMdChars(decodeEntities(stripTags(inner)));
    const safe = /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) ? href : '';
    return hold('[' + label + '](' + safe + ')');
  });
  t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) =>
    hold('**' + escapeMdChars(decodeEntities(stripTags(inner))) + '**'));
  t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) =>
    hold('*' + escapeMdChars(decodeEntities(stripTags(inner))) + '*'));
  // 剩余标签（span.j-* 高亮、u、s 等）只去壳，内容保留
  t = t.replace(/<\/?[A-Za-z][^>]*>/g, '');
  return escapeMdChars(decodeEntities(t));
}

export function htmlToMarkdown(html) {
  const tokens = [];
  const hold = (md) => {
    const key = '\u0001' + tokens.length + '\u0001';
    tokens.push(md);
    return key;
  };
  // br 必须最先转成真实换行：若等 <p>/<blockquote> 处理后的最后一遍才转，
  // 残留标签已被 inlineToMd 的「去壳」正则吃掉，换行就永久丢了。
  let s = String(html == null ? '' : html)
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // fenced 代码块：先抠出来占位，内部内容不再参与任何 Markdown 转换。
  // 代码高亮产生的 <span class="j-*"> 只去壳，源码原样保留。
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const lm = /<code\b[^>]*\bclass\s*=\s*["'][^"']*language-([A-Za-z0-9_+#.-]+)[^"']*["'][^>]*>/i.exec(inner);
    const lang = lm ? lm[1] : '';
    const code = decodeEntities(stripTags(
      inner.replace(/^\s*<code\b[^>]*>/i, '').replace(/<\/code>\s*$/i, ''),
    )).replace(/\n+$/, '');
    return '\n\n' + hold('```' + lang + '\n' + code + '\n```') + '\n\n';
  });
  // 标题 / 列表 / 引用 / 分割线：块级标记也走 hold 占位
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) =>
    '\n\n' + hold('#'.repeat(Number(n)) + ' ' + inlineToMd(inner, hold)) + '\n\n');
  s = s.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, inner) => {
    const ordered = tag.toLowerCase() === 'ol';
    let i = 0;
    const body = inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m2, li) => {
      i++;
      return (ordered ? i + '. ' : '- ') + inlineToMd(li, hold).trim() + '\n';
    });
    return '\n\n' + hold(body.replace(/\n+$/, '')) + '\n\n';
  });
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) =>
    '\n\n' + hold(inlineToMd(inner, hold).split('\n').map((l) => '> ' + l).join('\n')) + '\n\n');
  s = s.replace(/<hr\b[^>]*\/?>/gi, () => '\n\n' + hold('---') + '\n\n');
  // 段落里的行内转换结果必须 hold 占位：否则最后一遍 inlineToMd 会再次
  // 转义同一段文本，把 \* 变成 \\\*（双重转义），破坏确定性与可读性。
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner) =>
    '\n\n' + hold(inlineToMd(inner, hold)) + '\n\n');
  s = s.replace(/<\/?(?:div|section|article)\b[^>]*>/gi, '\n');
  s = inlineToMd(s, hold);

  // 折叠多余空行；每段之间恰好一个空行，确保重复运行输出逐字节一致
  s = s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  // 从后往前还原：内层 token 先创建，倒序替换可正确处理嵌套（粗体里含代码）
  for (let i = tokens.length - 1; i >= 0; i--) {
    s = s.split('\u0001' + i + '\u0001').join(tokens[i]);
  }
  return s;
}

async function buildFileMap(cfg) {
  const notes = await getNotes();
  const ids = Object.keys(notes).sort();
  const files = [];
  const skippedAssets = [];
  const versions = [];
  let noteCount = 0;

  for (const id of ids) {
    const n = notes[id];
    if (!n || typeof n !== 'object') continue;
    noteCount++;
    // YAML front matter 保留 JSON 时代的完整字段（id/标题/创建与更新时间/墓碑），
    // 正文才是人可读 Markdown——灾难恢复时元数据不丢。JSON.stringify 的双引号串
    // 是合法 YAML，且确定性；正文里的缩略图 data URL 由 htmlToMarkdown 改写成
    // assets/<id> 引用，原图本体走下方 assets/ 分支。
    const front = [
      '---',
      'id: ' + JSON.stringify(n.id || id),
      'title: ' + JSON.stringify(n.title || ''),
      'createdAt: ' + JSON.stringify(typeof n.createdAt === 'number' ? n.createdAt : 0),
      'updatedAt: ' + JSON.stringify(typeof n.updatedAt === 'number' ? n.updatedAt : 0),
      'deleted: ' + (!!n.deleted),
      '---',
      '',
    ].join('\n');
    files.push({
      path: 'notes/' + id + '.md',
      content: front + htmlToMarkdown(n.content || ''),
    });
    if (typeof n.updatedAt === 'number') versions.push(n.updatedAt);
  }

  const index = ids.filter((id) => notes[id] && typeof notes[id] === 'object').map((id) => ({
    id,
    title: notes[id].title || '',
    updatedAt: notes[id].updatedAt || 0,
  }));
  files.push({ path: 'index.json', content: stableJson(index) });

  // 原图键名 img:<id>；从笔记正文里的 data-orig-id 反查篇名，
  // 超限时状态区要写「哪篇笔记的图被跳过」，而不是一个无意义的 img id。
  const titleByImg = new Map();
  for (const n of Object.values(notes)) {
    if (!n || typeof n !== 'object') continue;
    const re = /data-orig-id="([^"]+)"/g;
    const html = n.content || '';
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!titleByImg.has(m[1])) titleByImg.set(m[1], n.title || '(无标题)');
    }
  }

  const all = await chrome.storage.local.get(null);
  const imgKeys = Object.keys(all).filter((k) => k.startsWith('img:')).sort();
  let assetCount = 0;
  let totalBytes = 0;
  for (const key of imgKeys) {
    const imgId = key.slice(4);
    const label = titleByImg.get(imgId) || imgId;
    const data = all[key];
    const content = typeof data === 'string' ? data : '';
    if (!content) {
      skippedAssets.push({ name: label, reason: '原图内容为空' });
      continue;
    }
    const bytes = enc.encode(content).length;
    if (bytes > MAX_ASSET_BYTES) {
      skippedAssets.push({ name: label, reason: '原图 ' + Math.round(bytes / 1024) + 'KB 超过单图 2MB 上限' });
      continue;
    }
    if (totalBytes + bytes > MAX_ASSET_TOTAL_BYTES) {
      skippedAssets.push({ name: label, reason: '原图总量超过 8MB 上限' });
      continue;
    }
    totalBytes += bytes;
    assetCount++;
    // 存的是完整 data URL（data:image/jpeg;base64,...）：恢复时原样写回 img:<id>
    files.push({ path: 'assets/' + imgId, content });
  }

  for (const f of files) f.sha = gitBlobSha(f.content);
  const hash = await contentHash(files);
  files.push({
    path: 'meta.json',
    content: stableJson({
      contentVersionAt: versions.length ? Math.max(...versions) : 0,
      noteCount,
      assetCount,
      contentHash: hash,
      device: { id: cfg.deviceId, name: cfg.deviceName },
      skippedAssets: skippedAssets.slice(0, 20),
    }),
  });
  files[files.length - 1].sha = gitBlobSha(files[files.length - 1].content);
  return { files, noteCount, assetCount, skippedAssets };
}

const isCompared = (path) => path !== 'meta.json'
  && (path === 'index.json' || path.startsWith('notes/') || path.startsWith('assets/'));
const isManaged = (path) => isCompared(path) || path === 'meta.json';

// ===== Git Data API 一次原子提交 =====

async function createBlobs(cfg, changed) {
  const shas = new Map();
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= changed.length) return;
      const f = changed[i];
      const data = await ghFetch('/repos/' + encodeURIComponent(cfg.owner) + '/'
        + encodeURIComponent(cfg.repo) + '/git/blobs', cfg, {
        method: 'POST',
        body: { content: f.content, encoding: 'utf-8' },
      });
      if (!data || !data.sha) throw apiError('创建 blob 未返回 sha', 'api', 0);
      shas.set(f.path, data.sha);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, changed.length) }, worker));
  return shas;
}

function humanError(e) {
  if (!e) return '未知失败';
  if (e.kind === 'not-configured') return e.message;
  if (e.kind === 'not-pulled') return e.message;
  if (e.kind === 'private') return e.message;
  if (e.kind === 'auth') return '令牌失效或权限不足（401/403），请重新配置 fine-grained PAT（仅该仓库 Contents 读写）';
  if (e.kind === 'network') return e.message;
  return 'GitHub 备份失败：' + ((e.message) || e);
}

async function doRunFullBackup(trigger) {
  const at = Date.now();
  const cfg = await getGithubBackupConfig();
  const base = { at, ok: false, reason: '', trigger, noteCount: 0, assetCount: 0, committed: false };

  if (trigger === 'daily') {
    const d = await chrome.storage.local.get(DATE_KEY);
    if (d[DATE_KEY] && d[DATE_KEY] >= utcDateKey(new Date(at))) {
      // 今日已成功（同日两设备也靠这里少一次 API 往返）；不改状态、不重复标戳
      return { ok: true, skipped: true, reason: '今日已备份', at };
    }
  }
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    const err = apiError('未配置 GitHub 备份：请在设置页保存令牌与仓库', 'not-configured');
    await writeStatus({ ...base, reason: humanError(err) });
    return { ok: false, reason: humanError(err) };
  }
  // 拉取闸门跨上下文：pulledOk 曾只是页面局部变量，SW 看不见。这里读持久化戳；
  // 清空后（resetStampAt 更新）旧戳作废，必须重新拉取，防止给即将清空/刚清空的
  // 数据做全量镜像。
  const g = await chrome.storage.local.get([PULL_OK_KEY, 'resetStampAt']);
  if (!g[PULL_OK_KEY] || (g.resetStampAt && g[PULL_OK_KEY] < g.resetStampAt)) {
    const err = apiError('未拉取：请先完成七牛启动拉取再备份', 'not-pulled');
    await writeStatus({ ...base, reason: humanError(err) });
    return { ok: false, reason: humanError(err) };
  }
  // 本地为空不写：与 backupRecent / createSnapshot 同款闸门。清空（wipe）后
  // lastPullAt 仍在，页面 pulledOk 可能为真，若不拦住会往灾难恢复仓库提交一份
  // "0 篇笔记"的空镜像——备份仓库反而成了清空现场。宁可跳过，等有数据再备。
  const localNotes = await getNotes();
  if (Object.keys(localNotes).length === 0) {
    const err = apiError('本地笔记为空，跳过全量备份（清空后请先拉取恢复数据）', 'empty-local');
    await writeStatus({ ...base, reason: err.message });
    return { ok: false, reason: err.message, at };
  }
  // 过程留痕：Git Data 流程跨大量 await，先写一条 running 状态让设置页通过
  // onChanged 实时看到进度。万一 SW 中途被回收，状态停在 running，UI 会明确
  // 提示"可能已中断"，而不是假装成功；日期不标，下次打开自动重试。
  await writeStatus({ ...base, running: true, reason: '全量备份进行中…' });

  try {
    const built = await buildFileMap(cfg);
    base.noteCount = built.noteCount;
    base.assetCount = built.assetCount;
    base.skippedAssetCount = built.skippedAssets.length;
    base.skippedAssets = built.skippedAssets.slice(0, 20);
    const repoPath = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);

    // ref 更新被拒（另一设备刚提交）→ 基于最新 HEAD 重组重试一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = await ghFetch(repoPath + '/git/ref/heads/' + encodeURIComponent(cfg.branch), cfg);
      if (!ref || !ref.object || !ref.object.sha) throw apiError('读取仓库 HEAD 失败', 'api', 0);
      const headSha = ref.object.sha;
      const commitInfo = await ghFetch(repoPath + '/git/commits/' + headSha, cfg);
      if (!commitInfo || !commitInfo.tree || !commitInfo.tree.sha) throw apiError('读取 HEAD tree 失败', 'api', 0);
      const treeSha = commitInfo.tree.sha;
      const treeData = await ghFetch(repoPath + '/git/trees/' + treeSha + '?recursive=1', cfg);
      const entries = (treeData && Array.isArray(treeData.tree)) ? treeData.tree : [];
      const remote = new Map();
      for (const e of entries) {
        if (e && e.type === 'blob' && typeof e.path === 'string' && isManaged(e.path)) {
          remote.set(e.path, e.sha);
        }
      }

      const ours = new Map();
      for (const f of built.files) if (isCompared(f.path)) ours.set(f.path, f.sha);
      const remoteCmp = new Map();
      for (const [p, sha] of remote) if (isCompared(p)) remoteCmp.set(p, sha);

      // 只比对「本地当前要写的文件」：仓库里多出来的历史文件不参与比对，
      // 也不发 sha:null 删除。评审硬约束 1：本期无删除入口，不做删除同步，
      // 不做 GitHub 物理删——灾难恢复仓库留住旧文件比删掉更安全。
      // 若不排除远端独有路径，每次全量都会把它们算成差异，产生无穷空提交。
      let diff = 0;
      for (const [p, sha] of ours) if (remoteCmp.get(p) !== sha) diff++;
      if (diff === 0) {
        // 零差异：不产生提交，只更新本地日期记录（成功才标）
        const status = {
          ...base, ok: true, reason: built.skippedAssets.length
            ? '内容无差异，未产生提交；' + built.skippedAssets.length + ' 张原图已跳过（见详情）'
            : '内容无差异，未产生提交',
        };
        await writeStatus(status);
        await chrome.storage.local.set({ [DATE_KEY]: utcDateKey(new Date(at)) });
        return { ok: true, skipped: true, committed: false, reason: status.reason, at, noteCount: built.noteCount };
      }

      // 未变文件靠 base_tree 保留；变更文件重新 POST blob 取 GitHub 侧 sha。
      // base_tree 会原样保留远端多出来的历史文件：没有删除入口就不做物理删，
      // 它们只是不再被 index.json 引用，恢复时以 index.json 为准。
      const changed = built.files.filter((f) => remote.get(f.path) !== f.sha);
      const blobShas = await createBlobs(cfg, changed);
      const treeEntries = [];
      for (const f of built.files) {
        if (remote.get(f.path) === f.sha) continue;
        const sha = blobShas.get(f.path);
        if (!sha) throw apiError('blob 缺失：' + f.path, 'api', 0);
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha });
      }

      const msgDevice = cfg.deviceName || (cfg.deviceId ? cfg.deviceId.slice(0, 8) : '未知设备');
      const message = 'backup: ' + new Date(at).toISOString()
        + ' · 笔记 ' + built.noteCount + ' 篇 · 设备 ' + msgDevice;
      const newTree = await ghFetch(repoPath + '/git/trees', cfg, {
        method: 'POST', body: { base_tree: treeSha, tree: treeEntries },
      });
      if (!newTree || !newTree.sha) throw apiError('创建 tree 失败', 'api', 0);
      const newCommit = await ghFetch(repoPath + '/git/commits', cfg, {
        method: 'POST', body: { message, tree: newTree.sha, parents: [headSha] },
      });
      if (!newCommit || !newCommit.sha) throw apiError('创建 commit 失败', 'api', 0);
      try {
        await ghFetch(repoPath + '/git/refs/heads/' + encodeURIComponent(cfg.branch), cfg, {
          method: 'PATCH', body: { sha: newCommit.sha, force: false },
        });
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt === 0) continue; // 基于新 HEAD 重组重试一次
        throw e;
      }

      const warnings = built.skippedAssets.length
        ? '；跳过 ' + built.skippedAssets.length + ' 张原图：'
          + built.skippedAssets.slice(0, 5).map((s) => s.name + '（' + s.reason + '）').join('、')
        : '';
      const status = {
        ...base, ok: true, committed: true,
        reason: '全量备份成功，提交 ' + newCommit.sha.slice(0, 7) + warnings,
        commitSha: newCommit.sha,
      };
      await writeStatus(status);
      await chrome.storage.local.set({ [DATE_KEY]: utcDateKey(new Date(at)) });
      return { ok: true, skipped: false, committed: true, reason: status.reason, at, noteCount: built.noteCount, commitSha: newCommit.sha };
    }
    throw apiError('仓库引用更新冲突，重试一次后仍失败', 'conflict', 409);
  } catch (e) {
    const reason = humanError(e);
    await writeStatus({ ...base, reason });
    return { ok: false, reason, at };
  }
}

// 单飞守卫：手动按钮与每日触发可能同秒到达，共享一次执行，不给仓库造竞争提交。
export function runFullBackup({ trigger = 'manual' } = {}) {
  if (backupInFlight) return backupInFlight;
  backupInFlight = doRunFullBackup(trigger).finally(() => { backupInFlight = null; });
  return backupInFlight;
}

// 页面 → SW：页面侧只负责触发与展示，真正的 Git Data 流程放 SW。
// 用 Promise 包装并整体兜底，避免扩展重载后的 "Extension context invalidated"
// 同步抛异常变成 Uncaught Error（与 main.js flushSyncSafe 同款防线）。
export async function requestFullBackup(trigger = 'manual') {
  try {
    if (!chrome.runtime || !chrome.runtime.id) return { ok: false, reason: '扩展上下文已失效，请重开窗口' };
    const res = await chrome.runtime.sendMessage({ type: 'github-full-backup', trigger });
    return res || { ok: false, reason: '后台无响应' };
  } catch (e) {
    return { ok: false, reason: '后台无响应：' + ((e && e.message) || e) };
  }
}
