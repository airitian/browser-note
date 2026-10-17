// 内容清洗（白名单制）：只保留安全元素与属性，外来浮层/样式/脚本/外链图片一律拦掉
// 重点拦 <style>——粘贴进来的样式标签会给整个页面注入背景色/隐藏规则，导致整窗变黑且点不动
const KEEP_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
  'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'BLOCKQUOTE', 'HR', 'IMG', 'FONT']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
  'SOURCE', 'SVG', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'META', 'NOSCRIPT',
  'TEMPLATE', 'APPLET', 'MARQUEE', 'DIALOG']);

// 代码块内 JSON 高亮 span 的类名白名单：仅这些类名会在 pre/code 内被保留，其余一律剥掉
const CODE_TOKEN_CLASSES = new Set(['j-key', 'j-str', 'j-num', 'j-bool', 'j-null', 'j-punc']);

// 笔记内图片的展示样式：小缩略图（点击灯箱看原图）。文章图片不缩小，仍走 max-width:100%
export const NOTE_IMG_STYLE = 'max-width:200px;max-height:160px;width:auto;height:auto;cursor:zoom-in;border-radius:4px;vertical-align:bottom;';

// opts.allowRemoteImg：放行 http(s) 远程图片。
// 笔记编辑默认 false（粘贴防护：只认我们自己生成的 data: 图片）；
// 文章阅读传 true——文章由用户自己发布到七牛，远程图片应正常渲染
// opts.thumbImg：笔记场景传 true——图片以小缩略图展示，点击灯箱放大看原图；文章场景不缩小
export function sanitizeContent(html = '', opts = {}) {
  const allowRemoteImg = !!opts.allowRemoteImg;
  const thumbImg = !!opts.thumbImg;
  const box = document.createElement('div');
  box.innerHTML = html || '';
  box.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName;
    // 危险元素整体移除
    if (DROP_TAGS.has(tag)) {
      el.remove();
      return;
    }
    // 白名单外容器：解包保留文字内容
    if (!KEEP_TAGS.has(tag)) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
      return;
    }
    // 先取出需要放行的属性，再剥掉全部属性
    const src = el.getAttribute('src') || '';
    const href = el.getAttribute('href') || '';
    // data-orig-id 也必须在剥属性之前取出（指向独立原图；缩略图 + 懒加载机制）
    const origId = el.getAttribute('data-orig-id') || '';
    // class 也需在剥属性前取出（代码块内 JSON 高亮 span 的 j-* 类名要保留）
    const cls = el.getAttribute('class') || '';
    [...el.attributes].forEach((a) => el.removeAttribute(a.name));
    if (tag === 'IMG') {
      // 默认只保留 data: 图片；文章场景额外放行 http(s) 远程图片
      if (!src.startsWith('data:image/') && !(allowRemoteImg && /^https?:\/\//i.test(src))) {
        el.remove();
        return;
      }
      el.setAttribute('src', src);
      // 保留指向独立原图的指针（缩略图 + 懒加载原图机制）
      if (origId) el.setAttribute('data-orig-id', origId);
      // 笔记图片：小缩略图展示；文章图片：常规自适应宽度
      el.setAttribute('style', thumbImg ? NOTE_IMG_STYLE : 'max-width:100%;height:auto;');
      el.setAttribute('alt', '');
    } else if (tag === 'A') {
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'SPAN' && CODE_TOKEN_CLASSES.has(cls) && el.closest('pre, code')) {
      // 代码块内的 JSON 高亮 token：仅保留白名单类名（其余 span 类一律剥掉）
      el.setAttribute('class', cls);
    }
  });
  return box.innerHTML;
}

// 编辑器封装：contenteditable + 粗体 + 密钥芯片（chip）
export class Editor {
  constructor(el) {
    this.el = el;
  }

  load(html = '') {
    this.el.innerHTML = sanitizeContent(html, { thumbImg: true });
  }

  getContent() {
    return this.el.innerHTML;
  }

  exec(command) {
    this.el.focus();
    document.execCommand(command, false, null);
  }

  bold() {
    this.exec('bold');
  }

  // 将当前选中文本包裹为密钥芯片 span
  wrapChip() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    range.deleteContents();
    range.insertNode(chip);
    sel.removeAllRanges();
  }

  onChange(cb) {
    this.el.addEventListener('input', cb);
  }
}
