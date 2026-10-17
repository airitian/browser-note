// 代码 / JSON 块支持：JSON 美化 + 语法高亮 + HTML 转义。
// 纯函数、零外部依赖；产出的 HTML 只含 <pre><code><span class="j-*">，
// 交由 sanitizeContent 白名单清洗（span 的 j-* 类名在 pre/code 内会被保留）。

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 尝试把文本解析为 JSON 并美化（2 空格缩进）；非 JSON 返回 null。
// 只接受对象/数组开头，避免把 "42" / "true" / "hello" 这类误判成 JSON。
export function prettyJson(text) {
  const s = String(text || '').trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch (_) {
    return null;
  }
}

// JSON 语法高亮：把美化后的 JSON 字符串转成带 <span class="j-*"> 的 HTML（文本已转义）。
// 缩进/换行原样保留（外层 <pre> 的 white-space:pre 生效）。
export function highlightJson(s) {
  const src = String(s || '');
  // 字符串 / 数字 / 布尔 / null / 结构符号
  const re = /("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],:])/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      // 字符串：后面跟冒号 → key，否则 → value
      const colon = /^\s*:/.exec(src.slice(re.lastIndex));
      if (colon) {
        out += '<span class="j-key">' + escapeHtml(m[1]) + '</span>';
        // 必须同时推进 re.lastIndex，否则冒号会被下一轮 punc 分支二次匹配 → 渲染成 "::"
        re.lastIndex += colon[0].length;
        last = re.lastIndex;
        out += '<span class="j-punc">:</span>';
      } else {
        out += '<span class="j-str">' + escapeHtml(m[1]) + '</span>';
      }
    } else if (m[2] !== undefined) {
      out += '<span class="j-num">' + escapeHtml(m[2]) + '</span>';
    } else if (m[3] !== undefined) {
      out += '<span class="j-bool">' + escapeHtml(m[3]) + '</span>';
    } else if (m[4] !== undefined) {
      out += '<span class="j-null">' + escapeHtml(m[4]) + '</span>';
    } else if (m[5] !== undefined) {
      out += '<span class="j-punc">' + escapeHtml(m[5]) + '</span>';
    }
  }
  out += escapeHtml(src.slice(last));
  return out;
}

// 生成 JSON 代码块 HTML（美化 + 高亮）；非 JSON 返回 null。
export function jsonBlockHtml(text) {
  const pretty = prettyJson(text);
  if (pretty == null) return null;
  return '<pre><code>' + highlightJson(pretty) + '</code></pre>';
}

// 生成普通代码块 HTML（原文转义，等宽展示，不做高亮）。
export function codeBlockHtml(code) {
  return '<pre><code>' + escapeHtml(code == null ? '' : code) + '</code></pre>';
}

export { escapeHtml };
