import {
  listNotes, getNote, getNotes, upsertNote, getSettings, onNotesChanged,
} from '../lib/storage.js';
import { Editor, sanitizeContent, NOTE_IMG_STYLE } from '../lib/editor.js';
import { scheduleSync, pullSync, pushAll, recordChange, fetchChangelog, maybeBackup, listSnapshots, rollbackTo, addPendingSnapshot } from '../lib/sync.js';
import { fetchVideoNoteList, loadVideoNoteTitles, fetchVideoNote, renderArticleContent } from '../lib/articles.js';
import { jsonBlockHtml, codeBlockHtml } from '../lib/codeblock.js';

const $ = (id) => document.getElementById(id);

// 绑定点击：元素缺失时打警告而不是抛异常。
// 历史事故：旧版 main.js 仍绑定已删除的 #menuMax，配新版 main.html 时
// null.onclick 直接抛异常，整个模块中断、UI 完全不初始化且无有效报错线索
function onClick(id, fn) {
  const el = $(id);
  if (el) el.onclick = fn;
  else console.warn('[browser-note] 绑定点击失败，元素不存在:', id);
}

const editor = new Editor($('editor'));

// popup 小窗 vs 独立大窗（?mode=window）
const isStandalone = new URLSearchParams(location.search).get('mode') === 'window';
if (isStandalone) document.body.classList.add('standalone');

let currentId = null;
let currentNote = null;   // 当前笔记的内存副本，避免保存前再发一次异步 get（减少关闭竞态）
let settings = null;
let notesCache = {};       // 全部笔记的内存副本，作为渲染与保存的权威来源
let articlesOpen = false;  // 文章面板是否打开（Esc 返回链用）

function uid() {
  return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function loadSettings() {
  settings = await getSettings();
}

function setStatus(s, msg) {
  const map = { local: '仅本地', syncing: '同步中…', synced: '已同步', error: '同步失败' };
  const el = $('status');
  el.textContent = map[s] || s;
  el.className = 'status ' + s;
  el.title = s === 'error' && msg ? msg : '';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

// 绝对时间 / 相对时间（回退快照列表用，与设置页「数据回退」卡片同款文案）
function absTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderList(filter = '') {
  // 按创建时间升序编号（由远到近）：最久创建的笔记排第一（编号 1），最新创建的排在末尾。
  // 每条笔记的编号只按创建时间固定——编辑/保存内容不得引起列表重排。
  // 历史事故：此前按 updatedAt 排序 + 每次按键重渲染，正在编辑的笔记会瞬间跳到 1 号位，
  // 用户感知"在 3 号输入的内容跑到 1 号，序号和内容对不上"
  // （因此 persist() 里特意不做重排，见其注释；本比较器只认 createdAt，
  //  updatedAt 仅在 createdAt 缺失时兜底，绝不参与主动排序）
  // 列表角标内容：默认显示创建序号 1,2,3…；笔记有标题（去空白后非空）时，
  // 用标题的第一个字替换序号——目录一眼可辨，无标题才回落数字
  const notes = Object.values(notesCache).filter((n) => !n.deleted)
    .sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0)
      || (a.updatedAt || 0) - (b.updatedAt || 0));
  const f = filter.trim().toLowerCase();
  const items = notes.filter((n) => !f || (n.title || '').toLowerCase().includes(f));
  const list = $('noteList');
  list.innerHTML = '';
  items.forEach((n, i) => {
    const div = document.createElement('div');
    div.className = 'note-item' + (n.id === currentId ? ' active' : '');
    // Array.from 取首个码点：emoji 等代理对字符不会被切成半个；纯空白标题按无标题处理
    const head = (n.title || '').trim();
    div.textContent = head ? Array.from(head)[0] : String(i + 1);
    div.title = (n.title || '(无标题)') + ' · ' + fmtTime(n.updatedAt);
    div.onclick = () => selectNote(n.id);
    list.appendChild(div);
  });
}

async function selectNote(id) {
  // 切换前先把旧笔记的未保存修改落盘（防抖定时器可能还没到时间），
  // 否则旧笔记的最近输入会丢——用户感知"刚输入的内容不见了"
  if (currentId && currentNote && currentId !== id) await persist();
  currentId = id;
  currentNote = notesCache[id] || (await getNote(id));
  if (currentNote) {
    $('title').value = currentNote.title || '';
    const raw = currentNote.content || '';
    const clean = sanitizeContent(raw, { thumbImg: true });
    editor.load(clean);
    // 内容被清洗过（含浮层/破图）→ 立刻把干净版本写回本地+云端
    if (clean !== raw) {
      currentNote.content = clean;
      currentNote.updatedAt = Date.now();
      notesCache[currentId] = currentNote;
      await chrome.storage.local.set({ notes: { ...notesCache } });
      if (settings && settings.ak) scheduleSync(currentId, settings, setStatus);
    }
    setStatus(settings && settings.ak ? 'synced' : 'local');
  }
  renderList($('search').value);
}

async function newNote() {
  // 同上：新建前先保存旧笔记，防止防抖窗口内的输入丢失
  if (currentId && currentNote) await persist();
  const id = uid();
  const now = Date.now();
  const note = { id, title: '', content: '', createdAt: now, updatedAt: now, deleted: false };
  notesCache[id] = note;
  currentId = id;
  currentNote = note;
  $('title').value = '';
  editor.load('');
  renderList($('search').value);
  $('title').focus();
  // 立即落盘（不再先 get 再 set）
  await chrome.storage.local.set({ notes: { ...notesCache } });
  if (settings && settings.ak) {
    try {
      await recordChange(settings, { t: now, id, title: '(新建)', action: '创建' });
    } catch (_) { /* 变更记录失败不影响新建 */ }
  }
}

// 防抖保存：停输 500ms 才落盘（此前每次按键都整表写存储 + 重排列表，既卡又乱）
let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; void persist(); }, 500);
}

async function persist() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!currentId || !currentNote) return;
  currentNote.title = $('title').value;
  currentNote.content = editor.getContent();
  currentNote.updatedAt = Date.now();
  notesCache[currentId] = currentNote;
  // 直接整表写入，去掉"先 get 后 set"的竞态窗口；弹窗关闭前也能尽快落盘
  await chrome.storage.local.set({ notes: { ...notesCache } });
  if (settings && settings.ak) scheduleSync(currentId, settings, setStatus);
  // 不在这里重排列表：编号按创建时间固定，输入过程中重渲染只会让编号无谓跳动
}

// 自动保存：停输 500ms 落本地 + 触发异步同步（最终态）
editor.onChange(schedulePersist);
$('title').addEventListener('input', schedulePersist);
$('editor').addEventListener('blur', () => persist());
// 通知后台 SW 立即补推（安全封装）。
// 历史事故：扩展重载/更新后，残留旧页面的 chrome.runtime 已失效（Extension
// context invalidated），此时 sendMessage 是【同步】抛异常——链上的 .catch(())
// 根本来不及挂上，变成 Uncaught Error（chrome://extensions 错误页可见）。
// 双保险：先探 chrome.runtime.id（失效后为 undefined），再整体 try/catch 兜底
function flushSyncSafe() {
  try {
    if (settings && settings.ak && chrome.runtime && chrome.runtime.id) {
      const p = chrome.runtime.sendMessage({ type: 'flush-sync' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_) { /* 上下文已失效：旧页面正在关闭，静默忽略 */ }
}

// 弹窗关闭/隐藏时补一次保存，并通知后台 SW 立即补推（防抖定时器随弹窗关闭会死掉）。
// persist 的存储写入同样可能因上下文失效被拒，卸载路径上静默吞掉，不产生未处理 rejection
window.addEventListener('pagehide', () => { persist().catch(() => {}); flushSyncSafe(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { persist().catch(() => {}); flushSyncSafe(); }
});

// 粘贴图片：行内只存"缩略图"（最长边 PASTE_THUMB_EDGE），原图（最长边 PASTE_MAX_EDGE）
// 单独存入 chrome.storage.local 的 img:<id> 键，点击图片时再懒加载显示。
// 好处：笔记正文（含同步载荷/内存渲染）保持轻量；原图按需加载，点开即清晰。
const PASTE_THUMB_EDGE = 640;
const PASTE_MAX_EDGE = 1600;

// 粘贴：一律由我们接管。外来 HTML 必经 sanitizeContent 白名单清洗
// （浮层/脚本/外链卡片拦掉），但保留字体样式（加粗/斜体/颜色/字号等）
$('editor').addEventListener('paste', async (e) => {
  e.preventDefault();
  const cd = e.clipboardData;
  const items = cd && cd.items;
  if (items) {
    for (const it of items) {
      if (it.type.indexOf('image') === 0) {
        const file = it.getAsFile();
        if (!file) break;
        // 行内只放缩略图；原图存独立键 img:<id>，点击时懒加载
        const thumb = await downscaleImage(file, PASTE_THUMB_EDGE);
        const orig = await downscaleImage(file, PASTE_MAX_EDGE);
        const imgId = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        editor.el.focus();
        try {
          await chrome.storage.local.set({ ['img:' + imgId]: orig });
          const img = document.createElement('img');
          img.src = thumb;                          // 行内：缩略图
          img.setAttribute('data-orig-id', imgId);  // 指向原图存储键
          img.setAttribute('style', NOTE_IMG_STYLE);
          img.alt = '';
          document.execCommand('insertHTML', false, img.outerHTML);
        } catch (_) {
          // 配额超限：回退为行内原图（牺牲体积换可用，绝不丢数据）
          const img = document.createElement('img');
          img.src = orig;
          img.setAttribute('data-orig-id', imgId);
          img.setAttribute('style', NOTE_IMG_STYLE);
          img.alt = '';
          document.execCommand('insertHTML', false, img.outerHTML);
        }
        persist();
        return;
      }
    }
  }
  // 非图片内容：优先级链 —— 代码块原样文本 > HTML 保留字体样式 > JSON 美化 > 纯文本
  const text = (cd && cd.getData('text/plain')) || '';
  if (text && isInCodeBlock()) {
    // 光标已在代码块内 → 原样插入（保留换行/缩进），按代码处理；HTML 样式路径不适用
    insertTextIntoCodeBlock(text);
  } else if (!isInCodeBlock() && insertPastedHtml(cd)) {
    // HTML 路径：保留字体样式，已在 insertPastedHtml 内完成插入
  } else if (text) {
    // JSON → 自动美化 + 语法高亮，插为代码块；纯文本含 URL → 链接化后插入（粘贴的链接立即可点击）；
    // 其余按纯文本插入。注意：链接化走 sanitizeContent（先转义再白名单清洗 + linkify），
    // 与笔记存储/启动清洗同款逻辑，保证"粘贴即链接、重载后一致"。
    const jb = jsonBlockHtml(text);
    if (jb) {
      editor.el.focus();
      document.execCommand('insertHTML', false, jb);
    } else if (/https?:\/\//i.test(text)) {
      editor.el.focus();
      document.execCommand('insertHTML', false, sanitizeContent(escapeText(text), { thumbImg: true }));
    } else {
      document.execCommand('insertText', false, text);
    }
  }
  persist();
});

// 粘贴 HTML 路径：sanitizeContent 清洗后保留字体样式插入。
// 返回 true 表示已插入；false 表示无 HTML 或清洗后无可用内容，调用方回落纯文本路径。
// 历史事故：旧版一律 insertText 纯文本，从别处复制的加粗/颜色等字体样式全部丢失，
// 用户感知"粘过来样式没了"；但也不能因此放行未清洗的 HTML（浮层/脚本风险）
function insertPastedHtml(cd) {
  const html = (cd && cd.getData('text/html')) || '';
  if (!html) return false;
  const clean = sanitizeContent(html, { thumbImg: true });
  // 清洗结果含非空白文本才插入：整页全是脚本/广告/外链卡片时结果为空，
  // 回落纯文本路径——避免插入一个空 shell 把用户实际复制的内容吞掉
  const probe = document.createElement('div');
  probe.innerHTML = clean;
  if (!probe.textContent.trim()) return false;
  editor.el.focus();
  document.execCommand('insertHTML', false, clean);
  return true;
}

function downscaleImage(file, maxEdge) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 按最长边约束（截图常是细高图，旧版只限宽会漏掉高边导致体积爆炸）
        const longest = Math.max(img.width, img.height) || 1;
        const scale = Math.min(1, maxEdge / longest);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ===== 代码 / JSON 块 =====
// 光标是否落在代码块（<pre>）内
function isInCodeBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentNode;
  return !!(node && node.closest && node.closest('pre'));
}
// 在代码块内插入原始文本（保留换行/缩进）；空占位 <br> 先清掉
function insertTextIntoCodeBlock(text) {
  const sel = window.getSelection();
  let codeEl = null;
  if (sel && sel.rangeCount) {
    let node = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentNode;
    codeEl = node && node.closest ? node.closest('code') : null;
  }
  if (!codeEl) { document.execCommand('insertText', false, text); return; }
  const tn = document.createTextNode(text);
  if (codeEl.innerHTML === '<br>' || codeEl.textContent === '') {
    codeEl.innerHTML = '';
    codeEl.appendChild(tn);
    placeCaretAtEnd(codeEl);
  } else {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
// 工具栏「代码」按钮：选中文字 → 包成代码块；无选中 → 插空代码块并把光标放进去（可直接粘贴代码）
onClick('codeBtn', () => {
  const sel = window.getSelection();
  let selected = '';
  if (sel && sel.rangeCount && !sel.isCollapsed && editor.el.contains(sel.anchorNode)) {
    selected = sel.toString();
  }
  editor.el.focus();
  document.execCommand('insertHTML', false, codeBlockHtml(selected));
  const pres = editor.el.querySelectorAll('pre');
  const last = pres[pres.length - 1];
  if (last) {
    const codeEl = last.querySelector('code') || last;
    if (!codeEl.textContent) codeEl.innerHTML = '<br>';
    placeCaretAtEnd(codeEl);
  }
  persist();
});

onClick('newBtn', newNote);
$('search').addEventListener('input', (e) => renderList(e.target.value));

// 紧急恢复快捷键：界面被异常内容（如外来浮层）卡住点不动时，
// Ctrl+Shift+Backspace 直接清空当前笔记内容，让窗口立刻恢复可操作
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'Backspace') {
    e.preventDefault();
    if (!currentId || !currentNote) return;
    currentNote.content = '';
    notesCache[currentId] = currentNote;
    editor.load('');
    persist();
    setStatus('local');
  }
});

// 窗口标题带版本号（独立大窗的标题栏可直接看到，用于确认是否重新加载）
document.title = '浏览器笔记 v0.5.18';

// ===== 图片查看器：点击图片 → 放大查看（Esc / 点击关闭）=====
// 注意：用 style.display 控制显隐，不可用 hidden 属性——行内 display:flex 会压过 hidden
const lightbox = document.createElement('div');
lightbox.id = 'lightbox';
lightbox.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:2147483647;'
  + 'display:none;align-items:center;justify-content:center;cursor:zoom-out';
document.body.appendChild(lightbox);

// 把图片缩放到"接近铺满窗口"：小图（如按窗口 20% 存入的截图）自动放大，
// 大图自动缩小适应。CSS 的 width:auto + max-* 只会缩小不会放大，必须用 JS 算显式尺寸。
// 放大上限 4 倍——存入的图已被压缩，超倍放大只会更模糊，不会带来细节
function fitIntoView(el) {
  const availW = Math.max(60, (window.innerWidth || 600) - 28);
  const availH = Math.max(60, (window.innerHeight || 400) - 28);
  const natW = el.naturalWidth || 0;
  const natH = el.naturalHeight || 0;
  if (!natW || !natH) return;
  const scale = Math.min(availW / natW, availH / natH, 4);
  el.style.width = Math.max(1, Math.round(natW * scale)) + 'px';
  el.style.height = Math.max(1, Math.round(natH * scale)) + 'px';
}
function openLightbox(el) {
  lightbox.innerHTML = '';
  lightbox.appendChild(el);
  lightbox.style.display = 'flex';
  if (el.tagName === 'IMG') {
    if (el.complete && el.naturalWidth) fitIntoView(el);
    el.onload = () => fitIntoView(el);
  }
}
function closeLightbox() {
  lightbox.style.display = 'none';
  lightbox.innerHTML = '';
}
lightbox.addEventListener('click', closeLightbox);
// 窗口可拖拽缩放：缩放时重算大图尺寸，始终铺满当前窗口
window.addEventListener('resize', () => {
  if (lightbox.style.display !== 'flex') return;
  const img = lightbox.querySelector('img');
  if (img) fitIntoView(img);
});
// Esc 返回链：阅读中 → 文章列表 → 关闭文章面板 → 关灯箱
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const reader = $('articleReader');
  if (reader && !reader.hidden) { reader.hidden = true; return; }
  if (articlesOpen) { closeArticles(); return; }
  closeLightbox();
});

// 图片查看 + 破图友好占位：笔记编辑区与文章阅读区共用（事件委托，innerHTML 替换不影响）
function bindImageLightbox(container, onFallbackRemove) {
  if (!container) { console.warn('[browser-note] 图片灯箱绑定失败：容器不存在'); return; }
  container.addEventListener('click', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.getAttribute('src')) return;
    e.preventDefault();
    const origId = img.getAttribute('data-orig-id');
    const big = document.createElement('img');
    big.alt = '';
    big.style.cssText = 'max-width:calc(100vw - 28px);max-height:calc(100vh - 28px);width:auto;height:auto;'
      + 'background:#fff;border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,.45)';
    // 先看缩略图（即时），若指向独立存储的原图则异步替换为原图
    big.src = img.src;
    big.onerror = () => {
      lightbox.innerHTML = '';
      const tip = document.createElement('div');
      tip.textContent = origId ? '原图加载失败：可能已被清理或不可访问' : '图片加载失败：请检查图片链接是否可访问';
      tip.style.cssText = 'color:#fff;font-size:14px;padding:20px 28px;background:#3A3A38;border-radius:8px';
      lightbox.appendChild(tip);
    };
    if (origId) {
      chrome.storage.local.get('img:' + origId, (res) => {
        const orig = res && res['img:' + origId];
        if (orig) { big.onload = () => fitIntoView(big); big.src = orig; }
      });
    }
    openLightbox(big);
  });
  // 图片加载失败 → 替换为友好占位（替代浏览器默认的破图图标）
  container.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const ph = document.createElement('div');
    ph.className = 'img-fallback';
    ph.textContent = '⚠ 图片加载失败 — 点此删除';
    ph.onclick = () => { ph.remove(); if (onFallbackRemove) onFallbackRemove(); };
    img.replaceWith(ph);
  }, true);
}
bindImageLightbox($('editor'), () => persist());
bindImageLightbox($('articleContent'));

// 链接点击 → 在浏览器新标签页打开（扩展弹窗/独立窗自身不会导航，必须显式走 chrome.tabs.create）
// 与图片灯箱共用事件委托：图片由灯箱接管（本分支对 IMG target 直接跳过），链接由本分支打开。
// 仅放行 http(s)（javascript: 等危险协议已在 sanitizeContent 上游被剥，这里双保险再校验一次）。
// 编辑态下点击链接直接打开——链接主要用于跳转；要编辑链接文字可用方向键移入或点链接外侧落光标
function bindLinkOpen(container) {
  if (!container) { console.warn('[browser-note] 链接点击绑定失败：容器不存在'); return; }
  container.addEventListener('click', (e) => {
    if (e.target && e.target.tagName === 'IMG') return; // 让图片灯箱处理
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    try {
      if (chrome && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: href, active: true });
      } else {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    } catch (_) { /* 上下文已失效等异常：静默忽略，不抛未处理 rejection */ }
  });
}
bindLinkOpen($('editor'));
bindLinkOpen($('articleContent'));

// 实时守护：每 1s 清掉任何混进文档的危险元素（外来 style/script/fixed 浮层）。
// 即使异常内容绕过清洗，也能在 1 秒内自愈，保证窗口始终可操作
setInterval(() => {
  document.querySelectorAll('.editor style, .editor script, .editor link, .editor iframe').forEach((el) => el.remove());
  document.querySelectorAll('.editor *').forEach((el) => {
    const s = el.getAttribute('style') || '';
    if (/position\s*:\s*(fixed|absolute|sticky)/i.test(s)) el.remove();
  });
}, 1000);

onClick('saveBtn', async () => {
  await persist();
  if (settings && settings.ak) {
    try {
      await recordChange(settings, {
        t: Date.now(),
        id: currentId,
        title: $('title').value || '(无标题)',
        action: '编辑',
      });
      await pushAll(settings, setStatus);
    } catch (e) {
      setStatus('error', e.message);
    }
  }
});

onClick('menuBtn', async () => {
  const m = $('menu');
  m.hidden = !m.hidden;
  if (!m.hidden && currentNote) {
    $('menuInfo').textContent = '最近更新时间：' + fmtTime(currentNote.updatedAt);
  }
});
// 点菜单/变更记录面板外任意处收回（标准下拉行为）：
//   - #menu：点击落在 #menu 或 #menuBtn 内则不收
//   - #menuLogPanel：点击落在面板内部（含回退按钮）或 #menu 内（含「变更记录」按钮，用于 toggle）则不收；
//     点击编辑器/搜索框/笔记列表等外部区域 → 关闭面板（此前只关菜单、不关变更记录面板，
//     导致点编辑器时面板仍挂在页面上）
// 事件顺序：menuBtn/menuLog 的 onclick 先切换 hidden，再冒泡到此处——用 target 归属判断，
// 开/关两种点击都正确，且互不误伤（点「变更记录」不会触发此处把它秒关）
document.addEventListener('click', (e) => {
  const m = $('menu');
  if (m && !m.hidden) {
    const btn = $('menuBtn');
    if (!(m.contains(e.target) || (btn && btn.contains(e.target)))) m.hidden = true;
  }
  const panel = $('menuLogPanel');
  if (panel && !panel.hidden) {
    if (!panel.contains(e.target) && !m.contains(e.target)) panel.hidden = true;
  }
});
onClick('menuReset', async () => {
  // 默认入口即独立窗口：清掉记忆的尺寸/位置，当前窗口重置为默认 600×400
  await chrome.storage.local.remove('windowBounds');
  const w = await chrome.windows.getCurrent();
  await chrome.windows.update(w.id, { width: 600, height: 400 });
  $('menu').hidden = true;
});
onClick('menuRefresh', async () => {
  await persist();
  if (settings && settings.ak) {
    try {
      await pullSync(settings, () => renderList($('search').value));
    } catch (e) {
      setStatus('error', e.message);
    }
  }
  $('menu').hidden = true;
});

// ===== 文章阅读（文章来源：七牛 video2note 空间的视频笔记 Markdown）=====
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

onClick('articleBtn', () => openArticles());
onClick('articlesBack', () => closeArticles());
onClick('articlesRefresh', () => loadArticleList());
onClick('readerBack', () => { $('articleReader').hidden = true; });

async function openArticles() {
  articlesOpen = true;
  $('menu').hidden = true;
  $('articlesPane').hidden = false;
  await loadArticleList();
}

function closeArticles() {
  articlesOpen = false;
  $('articlesPane').hidden = true;
  $('articleReader').hidden = true;
}

async function loadArticleList() {
  $('articleReader').hidden = true;
  const list = $('articleList');
  list.innerHTML = '<div class="article-empty">加载中…</div>';
  const r = await fetchVideoNoteList(settings);
  if (!articlesOpen) return; // 加载期间已返回笔记
  if (!r.ok) {
    list.innerHTML = '<div class="article-empty">加载失败：' + escapeText(r.error)
      + '<br><span class="article-tip">检查网络后点右上角「⟳ 刷新」重试</span></div>';
    return;
  }
  if (!r.items.length) {
    list.innerHTML = '<div class="article-empty">暂无文章<br><span class="article-tip">'
      + '文章来源为七牛 video2note 空间的视频笔记，生成后即可在这里阅读</span></div>';
    return;
  }
  const titles = await loadVideoNoteTitles(settings, r.items);
  if (!articlesOpen) return; // 标题加载期间已返回笔记
  list.innerHTML = '';
  r.items.forEach((a) => {
    const title = titles.get(a.key) || a.filename;
    const item = document.createElement('div');
    item.className = 'article-item';
    const t = document.createElement('div');
    t.className = 'article-item-title';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'article-item-time';
    d.textContent = a.updatedAt ? fmtTime(a.updatedAt) : '';
    item.appendChild(t);
    item.appendChild(d);
    item.onclick = () => openArticle(a.key, title);
    list.appendChild(item);
  });
}

async function openArticle(key, fallbackTitle) {
  const content = $('articleContent');
  $('articleTitle').textContent = fallbackTitle || '加载中…';
  $('articleMeta').textContent = '';
  content.innerHTML = '<div class="article-empty">加载中…</div>';
  $('articleReader').hidden = false;
  try {
    const text = await fetchVideoNote(settings, key);
    if (!articlesOpen) return; // 加载期间已返回笔记
    $('articleTitle').textContent = fallbackTitle || '(无标题)';
    content.innerHTML = renderArticleContent(text || '');
  } catch (e) {
    if (!articlesOpen) return;
    $('articleTitle').textContent = fallbackTitle || '文章';
    content.innerHTML = '<div class="article-empty">打开失败：' + escapeText(e.message || '未知错误') + '</div>';
  }
}

onClick('menuLog', async () => {
  $('menu').hidden = true;
  const panel = $('menuLogPanel');
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  panel.innerHTML = '<div class="log-loading">加载中…</div>';
  // 未配置密钥：变更记录与数据回退都依赖七牛，统一给出明确空态（此前的
  // "未配置七牛同步" 只覆盖变更记录，现在回退区也一并不可用）
  if (!settings || !settings.ak) {
    panel.innerHTML = '<div class="log-empty">未配置七牛同步：变更记录与数据回退均不可用</div>';
    return;
  }
  // 两路并行：拉变更记录 + 拉可回退快照列表（含本地 pending 顶上的 CDN 延迟期条目）
  const [log, snapList] = await Promise.all([
    fetchChangelog(settings),
    (async () => { try { return await listSnapshots(settings); } catch (_) { return []; } })(),
  ]);
  // —— 变更记录区（结构映射，文本走 textContent 防 XSS）——
  let html = '';
  if (log === null) html += '<div class="log-empty">变更记录加载失败</div>';
  else if (!log.length) html += '<div class="log-empty">暂无变更记录</div>';
  else html += log
    .map(() => '<div class="log-item"><span class="log-action"></span><span class="log-title"></span><div class="log-time"></div></div>')
    .join('');
  // —— 回退区标题 + 结果提示 + 快照列表容器 ——
  html += '<div class="log-sep">近期可回退快照</div>';
  html += '<div class="log-tip" id="menuLogTip" hidden></div>';
  html += '<div id="menuSnapList"></div>';
  panel.innerHTML = html;
  const acts = panel.querySelectorAll('.log-action');
  const titles = panel.querySelectorAll('.log-title');
  const times = panel.querySelectorAll('.log-time');
  if (Array.isArray(log)) {
    log.forEach((e, i) => {
      acts[i].textContent = e.action;
      titles[i].textContent = e.title || '(无标题)';
      times[i].textContent = fmtTime(e.t);
    });
  }
  // —— 回退快照列表（含「回退」按钮，与设置页「数据回退」卡片同套逻辑）——
  await renderSnapList(settings, snapList);
});

// 在「变更记录」面板内渲染近期可回退快照列表 + 回退按钮。
// 功能与设置页「数据回退」卡片一致（同一套 listSnapshots/rollbackTo），
// 让用户在弹窗里也能直接回退，不必再打开设置页。回退成功后会刷新本地
// 笔记视图（rollbackTo 已替换本地 notes 并推送），编辑区立即反映新状态。
async function renderSnapList(s, list) {
  const box = $('menuSnapList');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="log-empty">暂无可回退快照（每小时自动创建一份）</div>';
    return;
  }
  // 标记「生效中」：刚从 CDN 延迟期顶上的本地 pending 条目（文件已进源站，
  // 但 CDN 边缘还没刷出，列表先由本地条目顶上）——告知用户不是坏了
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
      meta.textContent += ' · 生效中';
      btn.title = '快照已存入云端，CDN 正在传播（通常几分钟）。若回退失败请稍后重试';
    }
    btn.onclick = async () => {
      // 回退是破坏性操作：confirm 讲清三条——安全网、传播范围、不可撤销性
      const ok = confirm(`确定把笔记回退到 ${absTime(e.at)} 的状态吗？\n\n`
        + '· 当前数据会先自动存为一份快照，可随时再回退回来\n'
        + '· 其他浏览器下次同步时会采用这个状态\n'
        + '· 回退后新建的笔记会被删除（以墓碑形式同步）');
      if (!ok) return;
      btn.disabled = true;
      try {
        const r = await rollbackTo(s, e.at);
        if (r.safety) await addPendingSnapshot(r.safety); // 安全网快照同样顶着延迟立即显示
        showLogTip(`已回退：恢复 ${r.restored} 条`
          + (r.tombstoned ? `，删除回退后新建的 ${r.tombstoned} 条` : ''));
        // 回退已替换本地 notes：刷新内存缓存与列表，让编辑区立即反映新状态
        notesCache = await getNotes();
        renderList($('search').value);
        if (currentId && notesCache[currentId]) await selectNote(currentId);
        else {
          const notes = Object.values(notesCache).sort((a, b) => b.updatedAt - a.updatedAt);
          if (notes.length) await selectNote(notes[0].id);
        }
      } catch (err) {
        showLogTip('回退失败：' + (err && err.message ? err.message : err), true);
      }
      btn.disabled = false;
      // 重新拉取快照列表，刷新面板（含刚建的安全网快照、pending 交棒）
      try {
        const newList = await listSnapshots(s);
        await renderSnapList(s, newList);
      } catch (_) { /* 拉取失败：保留现有列表 */ }
    };
    row.append(time, meta, btn);
    box.appendChild(row);
  }
}

// 面板内回退结果提示（复用 .log-tip，4s 后自动隐藏；err=true 切换红色错误样式）
function showLogTip(text, err) {
  const tip = $('menuLogTip');
  if (!tip) return;
  tip.textContent = text;
  tip.className = 'log-tip' + (err ? ' err' : '');
  tip.hidden = false;
  clearTimeout(showLogTip._t);
  showLogTip._t = setTimeout(() => { tip.hidden = true; }, 4000);
}

// 多窗口：本地 notes 变化则刷新列表（同步内存缓存，不重载荷当前正在编辑的内容）
onNotesChanged((newVal) => {
  notesCache = newVal || {};
  renderList($('search').value);
});

(async () => {
  // 一次性彻底清空（v0.3.0 重置）：本地 + 云端全部数据，每个版本只执行一次。
  // 必须放在最前面——在任何同步/备份之前，防止旧数据被重新推上云。
  // 执行权在 SW：页面只发消息、不再本地直跑 oneTimeWipe——
  // 页面与 SW 各持一个 sync.js 模块实例，两边同时跑会并发双清空、
  // 交叉 remove(['notes']) 把刚写入的笔记删掉（2026-10-17 修启动竞态）。
  // P1 修复（2026-10-18）：该消息已改为【只等待、不触发】——清空执行权收敛到
  // onInstalled(update)/onStartup，页面加载不再触发清空（旧语义是漏戳误清的
  // 放大面，QA 实证 1/5）；若在途清空刚好在进行，消息会等待其完成再返回
  // （wipedNow 据此置位）；过期戳数据将存活到下次浏览器启动才清——宁可晚清，
  // 不可误清。本页逻辑无需配合改动：wipedNow 与下方 resetStampAt<10min 的
  // postWipe 判断在新语义下仍正确（等待中的清空完成会回 wiped:true；
  // 更早完成的由 resetStampAt 兜底）。
  // 云端清理失败 / SW 无响应：整体跳过（本地不动），onStartup / 下次打开自动重试
  let wipedNow = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'one-time-wipe' });
    wipedNow = !!(res && res.wiped);
  } catch (_) { /* 断网等情况：保持原样，下次重试 */ }
  await loadSettings();
  notesCache = await getNotes();
  // 启动时清洗全部笔记内容（历史脏内容/外来浮层自动修复），有改动则落盘
  let dirty = false;
  for (const n of Object.values(notesCache)) {
    const raw = n.content || '';
    const clean = sanitizeContent(raw, { thumbImg: true });
    if (clean !== raw) {
      n.content = clean;
      n.updatedAt = Date.now();
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.local.set({ notes: { ...notesCache } });
  // 图片原图 GC：回收已删除/已替换笔记中不再被引用的 img:<id> 存储键，避免无限膨胀
  try {
    const referenced = new Set();
    for (const n of Object.values(notesCache)) {
      const html = n.content || '';
      const re = /data-orig-id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) referenced.add(m[1]);
    }
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith('img:') && !referenced.has(k.slice(4)));
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch (_) { /* GC 失败不阻塞启动 */ }
  // 先尝试从七牛恢复（即使本地被清空也能拉回），再决定是否新建空白笔记。
  // 网络类操作全部容错：同步/备份失败绝不能阻断 UI 初始化（本地优先）
  if (settings && settings.ak) {
    // 拉取先行（跨浏览器数据安全）：「本地权威覆盖」语义下，没拉过就推会把云端
    // 索引覆写成本地子集。启动时先拉取并落 lastPullAt，后续推送才放行
    // （sync.js 的 ensurePulled 同款闸门把关 pushAll/scheduleSync）。
    // 拉取可达（含云端无索引的 404）才落戳；网络失败不落，下次启动重试
    // 刚清空过的首次打开（本次刚清 / 10 分钟内被 SW 或另一入口清过）仍跳过拉取：
    // 源头索引此时已为空，但七牛 CDN 边缘仍可能 Serve 陈旧副本——实测覆写后仍能
    // 把已打成墓碑的笔记按旧内容拉回，导致"清了还有"。但【从未拉取过】的浏览器
    // （新装/换机）不在此列——它本地是空的，拉取只会带入数据、不可能复活旧数据，
    // 这正是"换个浏览器数据拉不到"的修复点
    let pulledOk = false; // 本浏览器是否已确认拉取过（决定能否写云端：备份等）
    try {
      const pulled = await chrome.storage.local.get('lastPullAt');
      const stampAt = (await chrome.storage.local.get('resetStampAt')).resetStampAt || 0;
      const postWipe = wipedNow || Date.now() - stampAt < 10 * 60 * 1000;
      pulledOk = !pulled.lastPullAt || !postWipe ? false : true;
      if (!pulled.lastPullAt || !postWipe) {
        const st = await pullSync(settings, () => renderList($('search').value));
        if (st !== 'error') { await chrome.storage.local.set({ lastPullAt: Date.now() }); pulledOk = true; }
        notesCache = await getNotes();
      }
    } catch (_) { /* 忽略：拉取失败不阻塞启动 */ }
    // 备份放在拉取之后，且仅在本浏览器已成功拉取过（pulledOk）时进行——
    // 没拉取过的浏览器本地视图不完整，其备份会覆写云端更完整的当天备份。
    // backupRecent/recordChange 内部另有同款 ensurePulled 闸门兜底 SW 定时路径
    if (pulledOk) {
      try { await maybeBackup(settings); } catch (_) { /* 忽略：备份失败不阻塞启动 */ }
    }
  }
  // 墓碑回收：清空/删除后可能从云端并入带 deleted 标记的空笔记，本地直接剔除
  const dead = Object.keys(notesCache).filter((id) => notesCache[id] && notesCache[id].deleted);
  if (dead.length) {
    for (const id of dead) delete notesCache[id];
    await chrome.storage.local.set({ notes: { ...notesCache } });
  }
  const notes = Object.values(notesCache).sort((a, b) => b.updatedAt - a.updatedAt);
  if (notes.length === 0) await newNote();
  else await selectNote(notes[0].id);
})();
