// 文章阅读：文章来源为七牛云 video2note 空间的视频笔记，本地不持久化
//   video2note/<12位hex id>/general.md   Markdown 笔记（首行 '# 标题'）
//   video2note/<12位hex id>/note.md      个别视频使用此文件名
// 列表经 rsf 管理 API 动态列举（只收 .md，排除 source.mp4），正文走 CDN 下载。
// content 为 Markdown，渲染前一律过白名单清洗
import { listKeys, downloadText } from './qiniu.js';
import { VIDEO2NOTE } from './config.js';
import { sanitizeContent } from './editor.js';

// 拉取视频笔记列表。返回 {ok, items}：
//   items: [{key, id, filename, updatedAt}]（按 updatedAt 倒序，updatedAt 为毫秒）
// 网络失败返回 {ok:false, error} 让 UI 展示重试，不把错误吞成空列表；
// 空间为空是合法状态：{ok:true, items:[]}
export async function fetchVideoNoteList(settings) {
  if (!settings || !settings.ak) return { ok: false, error: '未配置七牛同步' };
  try {
    const items = await listKeys(settings.ak, settings.sk, {
      bucket: VIDEO2NOTE.bucket,
      prefix: VIDEO2NOTE.prefix,
      limit: 1000,
    });
    const list = items
      .filter((e) => e && typeof e.key === 'string' && /\.md$/i.test(e.key))
      .map((e) => ({
        key: e.key,
        id: e.key.split('/')[1] || '',
        filename: e.key.split('/').pop() || e.key,
        // rsf 的 putTime 单位是 100ns，转毫秒
        updatedAt: Math.floor((e.putTime || 0) / 10000),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, items: list };
  } catch (e) {
    return { ok: false, error: e.message || '加载失败' };
  }
}

// 并发下载各笔记首行提取标题，返回 Map<key, title>。
// 单个文件失败只跳过该条（try/catch），不让一个坏文件毁掉整个列表；
// 并发上限 40：items 已按时间倒序，只处理前 40 个，其余标题留空由 UI 回退显示
const TITLE_FETCH_LIMIT = 40;

export async function loadVideoNoteTitles(settings, items) {
  const titles = new Map();
  const batch = (items || []).slice(0, TITLE_FETCH_LIMIT);
  await Promise.all(batch.map(async (item) => {
    try {
      const text = await downloadText(item.key, { ...settings, domain: VIDEO2NOTE.domain });
      titles.set(item.key, extractTitle(text, item));
    } catch (_) { /* 单文件失败：跳过，UI 回退显示 filename */ }
  }));
  return titles;
}

// 标题提取：首个 '# 标题' 行 → filename 去掉 .md 后缀 → id
function extractTitle(text, item) {
  const m = String(text || '').match(/^#\s+(.+)$/m);
  if (m && m[1].trim()) return m[1].trim();
  const name = (item.filename || '').replace(/\.md$/i, '');
  if (name) return name;
  return item.id || '(无标题)';
}

// 下载单篇视频笔记，返回 Markdown 文本
export async function fetchVideoNote(settings, key) {
  return downloadText(key, { ...settings, domain: VIDEO2NOTE.domain });
}

// 格式判定（按优先级，避免"按标签存在性猜格式"的误判——Markdown 里含内联
// <img>/<script> 示例行时曾被误判成 HTML，导致整篇原样显示成文本）：
//   1) 含 <!doctype>/<html>/<body>      → 确定是 HTML 文档
//   2) 行首有 Markdown 块级语法          → 按 Markdown（真实 HTML 文章极少以
//      # 标题 / - 列表 / ``` 围栏 开头，Markdown 文章则几乎必有）
//   3) 含结构性 HTML 标签               → 按 HTML
//   4) 其余（纯文本）                    → 按 Markdown（自动分段）
const HTML_DOC = /<(!doctype|html|body|head)[\s>]/i;
const MD_BLOCK = /^(#{1,6}\s|[-*+]\s|\d+[.、]\s|>|\s*```)/m;
const HTML_STRUCT = /<(p|div|br|h[1-6]|ul|ol|li|img|a|pre|blockquote|code|table|tr|td|th|span|strong|em|b|i|u|hr|section|article)[\s/>]/i;

// 把文章/笔记 content 转为可安全渲染的 HTML，最后统一过白名单清洗。
// opts.allowRemoteImg：默认 true（文章由用户自己发布到七牛，远程图片应渲染）；
// 笔记传入 false——笔记只认自己生成的 data: 图片，远程图片一律拦截（与编辑期策略一致）
export function renderArticleContent(content = '', opts = {}) {
  const allowRemoteImg = opts.allowRemoteImg !== false;
  const raw = String(content || '');
  let html;
  if (HTML_DOC.test(raw)) html = raw;
  else if (MD_BLOCK.test(raw)) html = mdToHtml(raw);
  else if (HTML_STRUCT.test(raw)) html = raw;
  else html = mdToHtml(raw);
  return sanitizeContent(html, { allowRemoteImg, thumbImg: !!opts.thumbImg });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 迷你 Markdown → HTML：标题/粗斜体/行内代码/代码块/链接/图片/列表/引用/分割线/段落
// 只覆盖文章常用语法；复杂排版请直接发布 HTML
export function mdToHtml(md = '') {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let listType = null; // 'ul' | 'ol'
  let inCode = false;
  let codeBuf = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
        codeBuf = []; inCode = false;
      } else {
        flushPara(); flushList(); inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }

    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara(); flushList();
      out.push('<hr>');
    } else if ((m = t.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = t.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = t.match(/^\d+[.、]\s*(.*)$/))) {
      flushPara();
      if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      flushList();
      para.push(inline(t));
    }
  }
  if (inCode && codeBuf.length) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  flushPara(); flushList();
  return out.join('\n');
}

// 行内语法：图片 / 链接 / 粗体 / 斜体 / 行内代码（先转义，再放行白名单协议）
function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const u = /^(https?:\/\/|data:image\/)/i.test(url) ? url : '';
    return u ? `<img src="${u}" alt="${alt}">` : alt;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const u = /^https?:\/\//i.test(url) ? url : '';
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${txt}</a>` : txt;
  });
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  return t;
}
