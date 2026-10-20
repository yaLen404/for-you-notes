/** Markdown → HTML（画板卡片和右栏预览共用同一套渲染）。
 *
 * 支持：标题、粗体、斜体、删除线、行内代码、代码块、引用、有序/无序列表、
 * 任务清单、表格、分隔线，以及本程序特有的 `[[双向链接]]` 与 `#标签`。
 */

const INLINE_SRC = [
  '(?<esc>\\\\(?<escch>[\\\\`*_{}\\[\\]()#+\\-.!~>|$]))',        // \* 之类的转义
  '|(?<!\\$)\\$(?<tex>[^$\\n]{1,400})\\$(?!\\$)',            // $行内公式$
  '|!\\[\\[(?<embed>[^\\[\\]\\n]{1,200})\\]\\]',             // ![[图片]]（Obsidian 式嵌入）
  '|!\\[(?<alt>[^\\]\\n]{0,200})\\]\\((?<imgsrc>[^)\\n]{1,400})\\)', // ![](图片)
  '|\\[\\[(?<wiki>[^\\[\\]\\n]{1,80})\\]\\]',                // [[双链]]
  '|`(?<code>[^`\\n]+)`',                                  // `代码`
  '|\\*\\*(?<bold>[^\\n]+?)\\*\\*',                          // **粗**
  '|(?<![0-9A-Za-z])__(?<bold2>[^_\\n]+)__(?![0-9A-Za-z])',  // __粗__
  '|~~(?<strike>[^~\\n]+)~~',                              // ~~删~~
  '|\\*(?<em>[^*\\n]+)\\*',                                 // *斜*
  '|(?<![0-9A-Za-z])_(?<em2>[^_\\n]+)_(?![0-9A-Za-z])',      // _斜_
  '|(?<tagpre>^|\\s)#(?<tag>[0-9A-Za-z_\\u4e00-\\u9fa5-]{1,30})', // #标签
].join('');

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** LaTeX 公式：用本地 KaTeX 渲染。没有 KaTeX 时返回 null，调用方按原文显示 */
export function mathHtml(tex, display = false) {
  const katex = typeof globalThis !== 'undefined' ? globalThis.katex : null;
  if (!katex || typeof katex.renderToString !== 'function') return null;
  try {
    return katex.renderToString(String(tex), {
      displayMode: Boolean(display),
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
  } catch (_e) {
    return null;
  }
}

export function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 是不是一张图片（按扩展名判断） */
export function isImageName(text) {
  return IMAGE_EXT.test(String(text == null ? '' : text).trim());
}

/** 图片文件名 → 私有协议地址。只取文件名，路径不进界面 */
export function imageSrc(name) {
  const base = String(name == null ? '' : name).trim().split(/[\\/]/).pop();
  return `fyn-img://local/${encodeURIComponent(base)}`;
}

function imageHtml(name, alt) {
  const base = String(name).trim().split(/[\\/]/).pop();
  const label = escapeHtml(alt && alt.trim() ? alt.trim() : base);
  return `<img class="note-img" src="${imageSrc(base)}" alt="${label}" ` +
    `data-img="${escapeHtml(base)}" loading="lazy" draggable="false">`;
}

/** 行内：返回 HTML 片段。exists(title) 用来区分"链接目标是否存在"。
 *  递归调用必须用**独立的**正则实例，否则共享的 lastIndex 会把循环搞死。 */
export function inline(text, exists = () => true) {
  const src = String(text == null ? '' : text);
  const re = new RegExp(INLINE_SRC, 'g');
  let out = '';
  let pos = 0;
  let m = re.exec(src);
  while (m) {
    if (m.index > pos) out += escapeHtml(src.slice(pos, m.index));
    const g = m.groups || {};
    if (g.esc !== undefined) {
      out += escapeHtml(g.escch);                  // \* → *
    } else if (g.tex !== undefined) {
      const html = mathHtml(g.tex, false);
      // 渲染不了就原样显示；data-tex 让富文本编辑能还原回 $...$
      out += html
        ? `<span class="math-inline" data-tex="${escapeHtml(g.tex)}">${html}</span>`
        : escapeHtml(m[0]);
    } else if (g.embed !== undefined) {
      // ![[...]]：图片就渲染成图，否则当作普通双链
      if (isImageName(g.embed)) out += imageHtml(g.embed, '');
      else {
        const title = escapeHtml(g.embed.trim());
        const cls = exists(g.embed.trim()) ? 'wl' : 'wl missing';
        out += `<a class="${cls}" data-title="${title}">${title}</a>`;
      }
    } else if (g.alt !== undefined) {
      // ![alt](src)：只渲染本库里的图片（文件名或相对路径），外链/data: 一律当普通文字
      const raw = String(g.imgsrc || '').trim();
      const remote = /^[a-z][a-z0-9+.\-]*:/i.test(raw) && !/^fyn-img:/i.test(raw);
      if (!remote && isImageName(raw)) out += imageHtml(raw, g.alt);
      else out += escapeHtml(m[0]);
    } else if (g.wiki !== undefined) {
      const title = escapeHtml(g.wiki.trim());
      const cls = exists(g.wiki.trim()) ? 'wl' : 'wl missing';
      out += `<a class="${cls}" data-title="${title}">${title}</a>`;
    } else if (g.code !== undefined) {
      out += `<code>${escapeHtml(g.code)}</code>`;
    } else if (g.bold !== undefined || g.bold2 !== undefined) {
      out += `<strong>${inline(g.bold !== undefined ? g.bold : g.bold2, exists)}</strong>`;
    } else if (g.strike !== undefined) {
      out += `<del>${inline(g.strike, exists)}</del>`;
    } else if (g.em !== undefined || g.em2 !== undefined) {
      out += `<em>${inline(g.em !== undefined ? g.em : g.em2, exists)}</em>`;
    } else if (g.tag !== undefined) {
      const tag = escapeHtml(g.tag);
      out += `${g.tagpre || ''}<span class="tag" data-tag="${tag}">#${tag}</span>`;
    }
    pos = m.index + m[0].length;
    m = re.exec(src);
  }
  if (pos < src.length) out += escapeHtml(src.slice(pos));
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Markdown → HTML */
/** 按块切分：返回 [{ start, end, html }]，start/end 是源码行区间（左闭右开）。
 *  右栏"点哪块编哪块"就靠这个区间把 HTML 和源文本对上。 */
export function renderBlocks(md, exists = () => true) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const start = i;
    const line = lines[i];
    if (!line.trim()) {
      // 连续空行里，除了块之间那一行分隔，其余每两行代表**一个空块**。
      // 于是"一直按回车"能堆出任意多个空块，序列化再解析也不会被压掉。
      let j = i;
      while (j < n && !String(lines[j]).trim()) j += 1;
      const blanks = j - i;
      if (blanks >= 2) {
        const atEdge = i === 0 || j === n;               // 文档开头 / 结尾没有"分隔行"
        const count = atEdge
          ? Math.floor(blanks / 2)
          : (blanks === 2 ? 1 : Math.floor((blanks - 1) / 2));
        for (let k = 0; k < count; k += 1) {
          out.push({ start: i + k, end: i + k, type: 'empty', inline: '' });
        }
      }
      i = j;
      continue;
    }

    // $$ ... $$ 独立公式块（可以跨行）
    if (line.trim().startsWith('$$')) {
      const oneLine = line.trim();
      let body;
      if (oneLine.length > 2 && oneLine.endsWith('$$')) {
        body = oneLine.slice(2, -2);
        i += 1;
      } else {
        i += 1;
        const buf = [];
        while (i < n && !lines[i].trim().endsWith('$$')) { buf.push(lines[i]); i += 1; }
        if (i < n) { buf.push(lines[i].trim().slice(0, -2)); i += 1; }
        body = buf.join('\n');
      }
      const html = mathHtml(body, true);
      out.push({ start, end: i, html: html
        ? `<div class="math-block">${html}</div>`
        : `<pre class="math-fallback">${escapeHtml('$$' + body + '$$')}</pre>` });
      continue;
    }

    if (line.trim().startsWith('```')) {
      i += 1;
      const body = [];
      while (i < n && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push({ start, end: i, html: `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>` });
      continue;
    }
    let m = HEADING.exec(line);
    if (m) {
      const level = Math.min(3, m[1].length);
      out.push({ start, end: i + 1, html: `<h${level}>${inline(m[2].trim(), exists)}</h${level}>` });
      i += 1;
      continue;
    }
    if (HR.test(line)) { out.push({ start, end: i + 1, html: '<hr>' }); i += 1; continue; }

    if (line.includes('|') && i + 1 < n && TABLE_SEP.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      const aligns = splitRow(lines[i + 1]).map((s) => {
        const left = s.startsWith(':');
        const right = s.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      i += 2;
      while (i < n && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i += 1; }
      let html = '<table>';
      rows.forEach((row, ri) => {
        const cell = ri === 0 ? 'th' : 'td';
        html += '<tr>' + row.map((c, ci) => {
          const al = aligns[ci] ? ` style="text-align:${aligns[ci]}"` : '';
          return `<${cell}${al}>${inline(c, exists)}</${cell}>`;
        }).join('') + '</tr>';
      });
      out.push({ start, end: i, html: html + '</table>' });
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < n && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])[1]); i += 1; }
      // 逐行渲染再拼 <br>：整段丢进 inline() 的话 <br> 会被转义成文字
      out.push({ start, end: i, html: `<blockquote>${body.map((l) => (l.trim()
        ? inline(l, exists) : '')).join('<br>')}</blockquote>` });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line) || TASK.test(line)) {
      const firstOrdered = ORDERED.test(line) && !TASK.test(line);
      const items = [];
      while (i < n) {
        const cur = lines[i];
        if (!cur.trim()) {
          const next = lines[i + 1];
          const nextIsItem = next && (BULLET.test(next) || ORDERED.test(next) || TASK.test(next));
          if (nextIsItem) {
            const nextOrdered = ORDERED.test(next) && !TASK.test(next);
            if (nextOrdered === firstOrdered) { i += 1; continue; }
          }
          break;
        }
        const t = TASK.exec(cur);
        const o = t ? null : ORDERED.exec(cur);
        const isOrderedItem = Boolean(o);
        // 列表类型变了（- 变 1. 或反过来）就另起一个列表
        if (items.length && isOrderedItem !== firstOrdered) break;
        const depthOf = (spaces) => Math.min(6, Math.floor(String(spaces || '').length / 2));
        if (t) { items.push({ kind: 'task', depth: depthOf(t[1]), done: t[2].toLowerCase() === 'x', text: t[3] }); i += 1; continue; }
        if (o) { items.push({ kind: 'num', depth: depthOf(o[1]), text: o[3] }); i += 1; continue; }
        const b = BULLET.exec(cur);
        if (b) { items.push({ kind: 'bullet', depth: depthOf(b[1]), text: b[2] }); i += 1; continue; }
        if (items.length && /^\s+/.test(cur)) { items[items.length - 1].text += ' ' + cur.trim(); i += 1; continue; }
        break;
      }
      if (!items.length) break;
      const tag = firstOrdered ? 'ol' : 'ul';
      let html = `<${tag}>`;
      for (const it of items) {
        // 缩进的条目往右挪，嵌套才看得出来
        const pad = it.depth ? ` style="margin-left:${it.depth * 20}px"` : '';
        if (it.kind === 'task') {
          html += `<li class="task"${pad}><input type="checkbox" disabled ${it.done ? 'checked' : ''}> ${inline(it.text, exists)}</li>`;
        } else {
          html += `<li${pad}>${inline(it.text, exists)}</li>`;
        }
      }
      out.push({ start, end: i, html: html + `</${tag}>` });
      continue;
    }

    const para = [line.trim()];
    i += 1;
    while (i < n && lines[i].trim() &&
           !HEADING.test(lines[i]) && !HR.test(lines[i]) && !QUOTE.test(lines[i]) &&
           !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !TASK.test(lines[i]) &&
           !lines[i].trim().startsWith('```')) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push({ start, end: i, html: `<p>${inline(para.join(' '), exists)}</p>` });
  }
  return out;
}

/** 整篇渲染（画板卡片与旧调用点用）。等价于把所有块的 html 拼起来。 */
export function render(md, exists = () => true) {
  return renderBlocks(md, exists).map((b) => b.html).join('\n');
}

/** 纯文本行（画板卡片的高度估算、摘要用） */
export function plainLines(md, limit = 12) {
  const out = [];
  for (const raw of String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^(>\s*)+/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s*/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/!\[\[([^\[\]\n]{1,200})\]\]/g, '[图片 $1]')
      .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '[图片 $1]')
      .replace(/\[\[([^\[\]\n]{1,80})\]\]/g, '$1')
      .replace(/(^|\s)#[0-9A-Za-z_\u4e00-\u9fa5-]{1,30}/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1').replace(/`([^`]+)`/g, '$1')
      .replace(/\s{2,}/g, ' ').trim();
    if (line) out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** 摘要（卡片默认高度估算用） */
export function summary(md, limit = 60) {
  const lines = plainLines(md, 1);
  const text = lines[0] || '';
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** 行内 markdown → HTML；换行当软换行（<br>） */
export function renderInlineLines(mdInline, exists = () => true) {
  return String(mdInline == null ? '' : mdInline)
    .split('\n')
    .map((line) => inline(line, exists))
    .join('<br>');
}

/** 富文本编辑框里的 HTML → 行内 markdown。
 *  只认我们自己渲染出来的那几种标签，其它一律取纯文本。 */
export function htmlToInline(html) {
  if (typeof document === 'undefined') return String(html == null ? '' : html);
  const host = document.createElement('div');
  host.innerHTML = String(html == null ? '' : html);
  return nodesToInline(host.childNodes);
}

function nodesToInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.nodeType === 3) { out += node.nodeValue; continue; }
    if (node.nodeType !== 1) continue;
    const tag = String(node.nodeName || '').toLowerCase();
    const inner = nodesToInline(node.childNodes);
    if (tag === 'br') { out += '\n'; continue; }
    if (tag === 'strong' || tag === 'b') { out += '**' + inner + '**'; continue; }
    if (tag === 'em' || tag === 'i') { out += '*' + inner + '*'; continue; }
    if (tag === 'del' || tag === 's') { out += '~~' + inner + '~~'; continue; }
    if (tag === 'code') { out += '`' + inner + '`'; continue; }
    if (tag === 'a') { out += '[[' + ((node.dataset && node.dataset.title) || inner) + ']]'; continue; }
    if (tag === 'img') { out += node.dataset && node.dataset.img ? '![[' + node.dataset.img + ']]' : ''; continue; }
    if (tag === 'span') {
      if (node.dataset && node.dataset.tex !== undefined) { out += '$' + node.dataset.tex + '$'; continue; }
      if (node.classList && node.classList.contains('tag')) {
        out += '#' + ((node.dataset && node.dataset.tag) || inner);
        continue;
      }
      out += inner;
      continue;
    }
    out += inner;
  }
  return out;
}

/** 把 markdown 切成"块"，给富文本块编辑器用。
 *  列表每一项单独成块（Notion 那样），代码/公式/表格/分隔线留给源码块。 */
export function parseBlocks(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const n = lines.length;
  const depthOf = (spaces) => Math.min(6, Math.floor(String(spaces || '').length / 2));

  while (i < n) {
    const start = i;
    const line = lines[i];
    if (!line.trim()) {
      // 连续空行里，除了块之间那一行分隔，其余每两行代表一个空块
      // → 一直按回车可以堆出任意多个空块，存回去再解析也不会被压掉
      let j = i;
      while (j < n && !String(lines[j]).trim()) j += 1;
      const blanks = j - i;
      if (blanks >= 2) {
        const atEdge = i === 0 || j === n;              // 文档开头 / 结尾没有"分隔行"
        const count = atEdge
          ? Math.floor(blanks / 2)
          : (blanks === 2 ? 1 : Math.floor((blanks - 1) / 2));
        for (let k = 0; k < count; k += 1) {
          out.push({ start: i + k, end: i + k, type: 'empty', inline: '' });
        }
      }
      i = j;
      continue;
    }

    if (line.trim().startsWith('$$')) {
      const oneLine = line.trim();
      let body;
      if (oneLine.length > 2 && oneLine.endsWith('$$')) {
        body = oneLine.slice(2, -2);
        i += 1;
      } else {
        i += 1;
        const buf = [];
        while (i < n && !lines[i].trim().endsWith('$$')) { buf.push(lines[i]); i += 1; }
        if (i < n) { buf.push(lines[i].trim().slice(0, -2)); i += 1; }
        body = buf.join('\n');
      }
      out.push({ start, end: i, type: 'math', src: body });
      continue;
    }

    if (line.trim().startsWith('```')) {
      const fence = line.trim().slice(3).trim();
      i += 1;
      const body = [];
      while (i < n && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push({ start, end: i, type: 'code', src: body.join('\n'), lang: fence });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({ start, end: i + 1, type: `h${Math.min(3, h[1].length)}`, inline: h[2].trim() });
      i += 1;
      continue;
    }
    if (HR.test(line)) { out.push({ start, end: i + 1, type: 'hr' }); i += 1; continue; }

    if (line.includes('|') && i + 1 < n && TABLE_SEP.test(lines[i + 1])) {
      i += 2;
      while (i < n && lines[i].trim() && lines[i].includes('|')) i += 1;
      out.push({ start, end: i, type: 'table', src: lines.slice(start, i).join('\n') });
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < n && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])[1]); i += 1; }
      out.push({ start, end: i, type: 'quote', inline: body.join('\n') });
      continue;
    }

    const t = TASK.exec(line);
    if (t) {
      out.push({ start, end: i + 1, type: 'task', inline: t[3], depth: depthOf(t[1]), done: t[2].toLowerCase() === 'x' });
      i += 1;
      continue;
    }
    const o = ORDERED.exec(line);
    if (o) {
      out.push({ start, end: i + 1, type: 'num', inline: o[3], depth: depthOf(o[1]), num: Number(o[2]) || 1 });
      i += 1;
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      out.push({ start, end: i + 1, type: 'bullet', inline: b[2], depth: depthOf(b[1]) });
      i += 1;
      continue;
    }

    const para = [line.trim()];
    i += 1;
    while (i < n && lines[i].trim()
           && !HEADING.test(lines[i]) && !HR.test(lines[i]) && !QUOTE.test(lines[i])
           && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !TASK.test(lines[i])
           && !lines[i].trim().startsWith('```') && !lines[i].trim().startsWith('$$')
           && !(lines[i].includes('|') && i + 1 < n && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push({ start, end: i, type: 'p', inline: para.join('\n') });
  }
  return out;
}

/** 一个块存回 markdown 时的源码行 */
export function blockToLines(block) {
  const pad = '  '.repeat(block.depth || 0);
  switch (block.type) {
    // 空块加了字就变成普通段落（空块本身不占源码行）
    case 'empty': return block.inline ? String(block.inline).split('\n') : [];
    case 'hr': return ['---'];
    case 'code': return ['```' + (block.lang || ''), block.src || '', '```'];
    case 'math': return ['$$', block.src || '', '$$'];
    case 'table': return String(block.src || '').split('\n');
    case 'h1': case 'h2': case 'h3': {
      const marks = { h1: '#', h2: '##', h3: '###' }[block.type];
      return [marks + ' ' + (block.inline || '')];
    }
    case 'bullet': return [pad + '- ' + (block.inline || '')];
    case 'num': return [pad + (block.num || 1) + '. ' + (block.inline || '')];
    case 'task': return [pad + '- [' + (block.done ? 'x' : ' ') + '] ' + (block.inline || '')];
    case 'quote': return String(block.inline || '').split('\n').map((l) => '> ' + l);
    default: return String(block.inline || '').split('\n');
  }
}

/** 块 → 渲染好的 HTML（富文本块用内部行内 HTML，源码块用整段 HTML） */
export function blockToHtml(block, exists = () => true) {
  switch (block.type) {
    case 'empty': return '';
    case 'hr': return '<hr>';
    case 'code': return '<pre><code>' + escapeHtml(block.src || '') + '</code></pre>';
    case 'math': {
      const html = mathHtml(block.src || '', true);
      return html
        ? '<div class="math-block">' + html + '</div>'
        : '<pre class="math-fallback">' + escapeHtml('$$' + (block.src || '') + '$$') + '</pre>';
    }
    case 'table': {
      const rows = String(block.src || '').split('\n').map(splitRow);
      if (!rows.length) return '';
      const aligns = (rows[1] || []).map((s) => {
        const left = String(s).startsWith(':');
        const right = String(s).endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      const body = rows.filter((_, idx) => idx !== 1);
      let html = '<table>';
      body.forEach((row, ri) => {
        const cell = ri === 0 ? 'th' : 'td';
        html += '<tr>' + row.map((c, ci) => {
          const al = aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '';
          return '<' + cell + al + '>' + inline(c, exists) + '</' + cell + '>';
        }).join('') + '</tr>';
      });
      return html + '</table>';
    }
    default:
      return renderInlineLines(block.inline || '', exists);
  }
}

/** 画板卡片上不画图片：只把"图片嵌入"整段去掉，文字原样保留。
 *  ![[笔记标题]] 这种不是图片，保持不动。 */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
export function stripImageEmbeds(md) {
  return String(md == null ? '' : md)
    .replace(/!\[\[([^\[\]\n]{1,200})\]\]/g, (all, name) => (IMAGE_NAME.test(String(name).trim()) ? '' : all))
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '');
}
