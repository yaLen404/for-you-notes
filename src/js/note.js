/** 右栏：标题 / 富文本块编辑 / 预览 / 连接区。
 *
 * 编辑模型（Notion 式）：
 *   - 正文按 markdown 块切分，每段一块，**单击就能在那一块里落光标**；
 *   - 块里显示的是排版后的样子（粗体就是粗体），一边打一边生效；
 *   - 代码 / 公式 / 表格 / 分割线是"源码块"，点开才用输入框改它的原文；
 *   - 源码仍然是同一个 markdown 字符串（note.content），块只是它的视图，
 *     所以画板卡片、双链、自动保存都不受影响。
 */

import {
  parseBlocks, blockToLines, blockToHtml, htmlToInline, escapeHtml,
} from './markdown.js';

/** 这些块没有富文本编辑，点开是改源码 */
const SOURCE_BLOCKS = ['code', 'math', 'table', 'hr'];

export class NotePane {
  constructor(dom, ws, hooks = {}) {
    this.ws = ws;
    this.hooks = hooks;
    this.dom = dom;
    this.note = null;
    this.scale = 1;
    this._titleTimer = null;

    this._blocks = [];        // parseBlocks() 的结果
    this._focus = null;       // 光标所在的富文本块下标
    this._sel = new Set();    // 多选的块下标（Shift / Ctrl 点出来）
    this._sourceIndex = null; // 正在改源码的块下标（代码/公式/表格）
    this._lastEdit = 0;       // 上次编辑过的块下标

    dom.title.addEventListener('input', () => this.onTitleInput());
    dom.title.addEventListener('blur', () => this.commitTitle());
    dom.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // 回车是"我改完了"：标题空着就把原标题找回来
        this.commitTitle({ force: true });
        this.focusBlock(this._lastEdit || 0, 'end');
      }
    });

    // 块区：编辑相关的输入事件都委托到 #preview（块元素会被反复重建）
    this._closeMenuOnOutside = (ev) => {
      // 子菜单是独立的 DOM，点在它里面也算"菜单内"，否则按下就被关掉、click 永远到不了
      const inMenu = this._menuEl && this._menuEl.contains(ev.target);
      const inSub = this._subEl && this._subEl.contains(ev.target);
      if (!inMenu && !inSub) this.closeBlockMenu();
    };
    dom.preview.addEventListener('click', (e) => this.onBlockClick(e));
    dom.preview.addEventListener('focusin', (e) => this.onPreviewFocusIn(e));
    dom.preview.addEventListener('focusout', (e) => this.onPreviewFocusOut(e));
    dom.preview.addEventListener('input', (e) => this.onPreviewInput(e));
    dom.preview.addEventListener('keydown', (e) => this.onPreviewKey(e));
    dom.preview.addEventListener('contextmenu', (e) => this.onPreviewContextMenu(e));
    dom.preview.addEventListener('paste', (e) => this.onPreviewPaste(e));
    dom.preview.addEventListener('dragover', (e) => this.onPreviewDragOver(e));
    dom.preview.addEventListener('drop', (e) => this.onPreviewDrop(e));
    // 源码块（代码/公式/表格）的输入框：blur 不冒泡，只能在捕获阶段听
    dom.preview.addEventListener('blur', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('blk-editor')) this.commitSource();
    }, true);

    if (dom.chips) dom.chips.addEventListener('click', (e) => this.onChipClick(e));

    // 光标离开笔记（点画布、点别的笔记、切窗口）→ 把正在改的源码块提交掉
    document.addEventListener('pointerdown', () => this.scheduleLeave(), true);
    document.addEventListener('selectionchange', () => this.paintCurrentBlock());
    document.addEventListener('focusin', (e) => {
      if (e.target && this.dom.root && !this.dom.root.contains(e.target)) this.scheduleLeave();
    });
    window.addEventListener('blur', () => this.scheduleLeave());
  }

  /** 焦点离开笔记区 → 提交源码块（笔记一直是可编辑的，没有"退出编辑"这回事） */
  scheduleLeave() {
    clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => {
      if (!this.note) return;
      const active = document.activeElement;
      if (active && this.dom.root && this.dom.root.contains(active)) return;
      this.commitSource();
    }, 0);
  }

  // ---------------------------------------------------------------- 显示
  show(note, mode) {
    this.commitSource();                      // 先把上一篇里正在编辑的源码块提交掉
    this.writeBack();
    this.note = note || null;
    this._focus = null;
    this._lastEdit = 0;
    // 换笔记就换一套撤销历史
    this._history = [];
    this._future = [];
    this._lastPush = 0;

    this.dom.empty.hidden = Boolean(note);
    this.dom.preview.hidden = !note;
    if (!note) {
      this.dom.title.value = '';
      this.dom.preview.innerHTML = '';
      this._blocks = [];
      this.dom.accent.style.background = 'var(--line)';
      this.renderMeta();
      return;
    }
    this.dom.title.value = note.title || '';
    this.dom.accent.style.background = note.color || 'var(--line)';
    this.renderBlocks();
    this.renderMeta();
  }

  /** 兼容旧调用：现在没有"编辑 / 预览"两种状态了，笔记一直是可编辑的 */
  setMode() {}
  toggleMode() {}

  // ---------------------------------------------------------------- 块渲染
  /** 把 note.content 切成块并渲染。每块都是可直接打字的富文本块。 */
  renderBlocks() {
    const note = this.note;
    this._sourceIndex = null;
    if (!note) {
      this._blocks = [];
      this.dom.preview.innerHTML = '';
      return;
    }
    const exists = (t) => Boolean(this.ws.findTitle(t, note.graph));
    let blocks = parseBlocks(note.content || '');
    if (!blocks.length) blocks = [{ type: 'empty', start: 0, end: 0, inline: '' }];
    this._blocks = blocks;
    this.renumber();
    const editable = true;
    const body = blocks.map((b, i) => this.blockHtml(b, i, editable, exists)).join('');
    this.dom.preview.innerHTML = body;
    this.syncScale();
  }

  /** 连续的有序列表块自己编号，插一块删一块都会自动重排 */
  renumber() {
    let run = 0;
    for (const b of this._blocks) {
      if (b.type === 'num') { run += 1; b._num = run; } else { run = 0; }
    }
  }

  blockHtml(block, i, editable, exists) {
    const cls = ['blk', 'blk-' + block.type];
    // 空笔记（只有一块空的）才给占位提示，正文里的空块保持干净
    if (block.type === 'empty' && this._blocks.length === 1) cls.push('is-only');
    if (this._sel && this._sel.has(i)) cls.push('sel');
    const pad = block.depth ? ` style="margin-left:${block.depth * 20}px"` : '';
    if (SOURCE_BLOCKS.includes(block.type)) {
      return `<div class="${cls.join(' ')}" data-i="${i}" data-kind="source"${pad}>`
        + blockToHtml(block, exists) + '</div>';
    }
    let marker = '';
    if (block.type === 'task') {
      marker = `<button class="blk-check${block.done ? ' done' : ''}" type="button" data-i="${i}"`
        + ` contenteditable="false" title="勾选">${block.done ? '✓' : ''}</button>`;
    } else if (block.type === 'bullet') {
      marker = '<span class="blk-dot" contenteditable="false">•</span>';
    } else if (block.type === 'num') {
      marker = `<span class="blk-mark-num" contenteditable="false">${block._num || 1}.</span>`;
    }
    const ce = '';   // 单宿主：可编辑性在 #preview 上，块内不再嵌套 contenteditable
    return `<div class="${cls.join(' ')}" data-i="${i}" data-kind="inline"${pad}>`
      + marker
      + `<div class="blk-txt"${ce}>${blockToHtml(block, exists)}</div></div>`;
  }

  blkEl(index) {
    return this.dom.preview.querySelector(`.blk[data-i="${index}"]`);
  }

  editableEl(index) {
    const el = this.blkEl(index);
    return el ? el.querySelector('.blk-txt') : null;
  }

  /** 当前选区落在哪一块（单宿主模型下 e.target 永远是 #preview） */
  currentBlockEl() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const blk = node && node.closest ? node.closest('.blk') : null;
    if (!blk) return null;
    return blk.querySelector('.blk-txt') || blk;
  }

  currentIndex() {
    const el = this.currentBlockEl();
    const blk = el && el.closest ? el.closest('.blk') : null;
    if (blk) return Number(blk.dataset.i);
    return this._focus == null ? 0 : this._focus;
  }

  /** 把光标放到第 index 块的 start/end */
  _blockOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && el.closest ? el.closest('.blk') : null;
  }

  /** 某个 (node, offset) 在块文本里的字符偏移 */
  _offIn(el, node, offset) {
    if (!el) return 0;
    const r = document.createRange();
    r.selectNodeContents(el);
    try { r.setEnd(node, offset); } catch { return 0; }
    return r.toString().length;
  }

  /** 把光标放到第 index 块的第 offset 个字符 */
  caretAtOffset(index, offset) {
    const txt = this.editableEl(index);
    if (!txt) return false;
    const walker = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let node = walker.nextNode();
    let target = null;
    let off = 0;
    while (node) {
      const len = node.nodeValue.length;
      if (offset <= pos + len) { target = node; off = Math.max(0, offset - pos); break; }
      pos += len;
      node = walker.nextNode();
    }
    const range = document.createRange();
    if (target) range.setStart(target, off);
    else range.selectNodeContents(txt);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.activeElement !== this.dom.preview) this.dom.preview.focus();
    this._focus = index;
    this._lastEdit = index;
    return true;
  }

  /** 删除"跨块的文字选区"覆盖的全部内容；返回 true 表示已经处理 */
  deleteSelectedContent(opts = {}) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    // 选区端点可能直接落在宿主 #preview 上（例如 Ctrl+A 全选），要兜底到首/末块
    const host = this.dom.preview;
    const resolve = (node, offset, isStart) => {
      if (node === host) {
        const idx = isStart ? 0 : this._blocks.length - 1;
        const blk = this._blocks[idx];
        return { index: idx, offset: isStart ? 0 : (blk ? blockLen(blk) : 0) };
      }
      const b = this._blockOf(node);
      if (!b) return { index: isStart ? 0 : this._blocks.length - 1, offset: 0 };
      const i = Number(b.dataset.i);
      const txt = b.querySelector('.blk-txt');
      return { index: i, offset: txt ? this._offIn(txt, node, offset) : 0 };
    };
    const a = resolve(r.startContainer, r.startOffset, true);
    const b = resolve(r.endContainer, r.endOffset, false);
    const si = a.index;
    const ei = b.index;
    if (!Number.isFinite(si) || !Number.isFinite(ei)) return false;
    if (si === ei && !(r.startContainer === host)) return false;   // 单块内交给浏览器
    if (opts.copy) {
      const clip = window.foryou && window.foryou.clipboard;
      if (clip) clip.write(String(sel.toString() || ''));
    }
    const target = this._blocks[si];
    if (!target) return false;
    const headText = blockLen(target, a.offset);
    const tailBlk = this._blocks[ei];
    const tailText = tailBlk ? blockLen(tailBlk, b.offset, true) : '';
    target.inline = headText + tailText;
    if (target.type === 'empty' && target.inline) target.type = 'p';
    this._blocks.splice(si + 1, Math.max(0, ei - si));
    this.writeBack();
    this.renderBlocks();
    this.caretAtOffset(si, headText.length);
    return true;
  }

  caretAt(index, where = 'end') {
    const txt = this.editableEl(index);
    if (!txt) return false;
    const range = document.createRange();
    range.selectNodeContents(txt);
    range.collapse(where === 'start');
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.activeElement !== this.dom.preview) this.dom.preview.focus();
    this._focus = index;
    this._lastEdit = index;
    return true;
  }

  /** 所有块 → note.content。改一个字就同步一次，自动保存拿到的永远是最新文本。 */
  writeBack() {
    if (!this.note) return;
    const sources = this._blocks.map((b) => blockToLines(b));
    const content = sources.map((lines) => lines.join('\n')).join('\n\n');
    let line = 0;
    this._blocks.forEach((b, i) => {
      b.start = line;
      b.end = line + sources[i].length;
      line = b.end + 1;
    });
    if (content === this.note.content) return;
    this.pushHistory(this.note.content);
    this.note.content = content;
    this.note.updated = Date.now();
    this.renderMeta();
    if (this.hooks.onEdit) this.hooks.onEdit(this.note.id);
  }

  /** 笔记内容的撤销栈：每次真正改动前记一份，打字按 600ms 合并成一步 */
  pushHistory(prev) {
    if (prev == null) return;
    this._history = this._history || [];
    const now = Date.now();
    const last = this._history[this._history.length - 1];
    if (last === prev) return;
    if (this._lastPush && now - this._lastPush < 600 && this._history.length) {
      // 连续打字：保留这一串开始前的那一版，不逐步记录
      this._lastPush = now;
      this._future = [];
      return;
    }
    this._history.push(prev);
    if (this._history.length > 100) this._history.shift();
    this._lastPush = now;
    this._future = [];
  }

  /** Ctrl+Z：撤销笔记内容（没有历史就返回 false，让浏览器自己来） */
  undoNote() {
    if (!this.note || !this._history || !this._history.length) return false;
    const prev = this._history.pop();
    this._future = this._future || [];
    this._future.push(this.note.content);
    this.note.content = prev;
    this._lastPush = 0;
    this.renderBlocks();
    this.focusBlock(Math.min(this._lastEdit || 0, this._blocks.length - 1), 'end');
    if (this.hooks.onEdit) this.hooks.onEdit(this.note.id);
    return true;
  }

  /** Ctrl+Y / Ctrl+Shift+Z：重做 */
  redoNote() {
    if (!this.note || !this._future || !this._future.length) return false;
    const next = this._future.pop();
    this._history = this._history || [];
    this._history.push(this.note.content);
    this.note.content = next;
    this._lastPush = 0;
    this.renderBlocks();
    this.focusBlock(Math.min(this._lastEdit || 0, this._blocks.length - 1), 'end');
    if (this.hooks.onEdit) this.hooks.onEdit(this.note.id);
    return true;
  }

  /** 把某一块的富文本内容读回 markdown（不重排 DOM，光标不会跳） */
  syncInline(index) {
    const txt = this.editableEl(index);
    const blk = this._blocks[index];
    if (!txt || !blk) return;
    blk.inline = htmlToInline(txt.innerHTML);
    // 往空块里打字 → 它就变成普通段落
    if (blk.type === 'empty' && blk.inline) blk.type = 'p';
    this.writeBack();
  }

  // ---------------------------------------------------------------- 编辑交互
  /** 光标落在哪一块，就给那一块加 .cur（替代原来的 :focus-within） */
  paintCurrentBlock() {
    const el = this.currentBlockEl();
    const blk = el && el.closest ? el.closest('.blk') : null;
    if (blk === this._curEl) return;
    if (this._curEl) this._curEl.classList.remove('cur');
    this._curEl = blk;
    if (blk) {
      blk.classList.add('cur');
      this._focus = Number(blk.dataset.i);
      this._lastEdit = this._focus;
    }
  }

  onPreviewFocusIn(e) {
    const txt = (e.target.closest && e.target.closest('.blk-txt')) || this.currentBlockEl();
    if (!txt) return;
    const blk = txt.closest('.blk');
    if (!blk) return;
    this._focus = Number(blk.dataset.i);
    this._lastEdit = this._focus;
  }

  onPreviewFocusOut(e) {
    const txt = e.target.closest && e.target.closest('.blk-txt');
    if (!txt) return;
    const blk = txt.closest('.blk');
    if (!blk) return;
    const index = Number(blk.dataset.i);
    this.syncInline(index);
    // 失焦后把这一块重新排版一次（`**粗**` 这种打进去的字就会变成真粗体）
    this.scheduleNormalize(index);
  }

  scheduleNormalize(index) {
    clearTimeout(this._normalizeTimer);
    this._normalizeTimer = setTimeout(() => {
      if (this._focus === index) return;          // 又点回来了，别动
      if (!this.note) return;
      const active = document.activeElement;
      if (active && active.closest && active.closest('.blk-txt')) return;
      // 正在选一段字：重排 DOM 会把选区弄没，先跳过
      const selNow = window.getSelection();
      if (selNow && !selNow.isCollapsed && selNow.toString()) return;
      this.renderBlocks();
    }, 120);
  }

  onPreviewInput(e) {
    const txt = e.target.closest && e.target.closest('.blk-txt');
    if (!txt) return;
    const blk = txt.closest('.blk');
    if (!blk) return;
    const index = Number(blk.dataset.i);
    this.syncInline(index);
    // 输入即转换：块首打 "# "、"- "、"1. "、"[] "、"> "、"```" 直接变块类型
    this.autoFormat(index);
  }

  /** Notion 那种"打前缀自动变块" */
  autoFormat(index) {
    const blk = this._blocks[index];
    if (!blk || blk.type !== 'p') return;
    const text = String(blk.inline || '');
    const m = /^(#{1,3}|[-*+]|\d{1,2}[.)]|\[[ xX]?\]|>|```)(\s+)([\s\S]*)$/.exec(text);
    if (!m) return;
    const [, mark, , rest] = m;
    let type = 'p';
    if (mark[0] === '#') type = `h${mark.length}`;
    else if (mark === '>' ) type = 'quote';
    else if (mark === '```') type = 'code';
    else if (/^\[[ xX]?\]$/.test(mark)) type = 'task';
    else if (/^\d/.test(mark)) type = 'num';
    else type = 'bullet';
    blk.type = type;
    blk.inline = rest;
    if (type === 'task') blk.done = /x/i.test(mark);
    if (type === 'code') { blk.src = rest; blk.inline = ''; }
    this.writeBack();
    this.renderBlocks();
    if (type === 'code') this.openSource(index);
    else this.focusBlock(index, 'end');
  }

  /** 富文本块里插纯文本（粘贴、图片引用） */
  insertIntoEditable(text) {
    const el = this.activeEditor();
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') {
      const start = el.selectionStart == null ? el.value.length : el.selectionStart;
      el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd == null ? start : el.selectionEnd);
      el.selectionStart = el.selectionEnd = start + text.length;
      this.onSourceInput({ target: el });
      return true;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    const blk = el.closest('.blk');
    if (blk) this.syncInline(Number(blk.dataset.i));
    return true;
  }

  /** 光标在块首吗 */
  caretAtBlockStart(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    const pre = r.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length === 0 && !pre.querySelector || pre.innerHTML === '';
  }

  /** 按回车：在光标处拆块 */
  splitAtCaret() {
    const index = this.currentIndex();
    if (index == null) return;
    const txt = this.editableEl(index);
    const sel = window.getSelection();
    if (!txt) return;
    const cur0 = this._blocks[index];
    if (!cur0) return;
    // 光标不在这块文本里（比如刚点击过宿主）：当成"在块尾回车"
    const r0 = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r0 || !txt.contains(r0.startContainer)) {
      const t0 = ['h1', 'h2', 'h3'].includes(cur0.type) ? 'p' : cur0.type;
      this._blocks.splice(index + 1, 0, { type: t0, inline: '', depth: cur0.depth || 0, done: false });
      this.writeBack();
      this.renderBlocks();
      this.focusBlock(index + 1, 'start');
      return;
    }
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(txt);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(txt);
    after.setStart(range.endContainer, range.endOffset);
    const grab = (r) => {
      const box = document.createElement('div');
      box.appendChild(r.cloneContents());
      return htmlToInline(box.innerHTML);
    };
    const cur = this._blocks[index];
    if (!cur) return;
    cur.inline = grab(before);
    const nextType = ['h1', 'h2', 'h3'].includes(cur.type) ? 'p' : cur.type;
    const created = { type: nextType, inline: grab(after), depth: cur.depth || 0, done: false };
    if (nextType === 'num' && cur._num) created.num = cur._num + 1;
    this._blocks.splice(index + 1, 0, created);
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(index + 1, 'start');
  }

  /** 块首退格：空块删掉，非空块并进上一块 */
  mergeUp() {
    const index = this.currentIndex();
    if (index == null || index <= 0) return;
    const txt = this.editableEl(index);
    if (!txt) return;
    const empty = !htmlToInline(txt.innerHTML).trim();
    const cur = this._blocks[index];
    const prev = this._blocks[index - 1];
    if (!cur || !prev) return;
    if (empty) {
      this._blocks.splice(index, 1);
    } else {
      const text = htmlToInline(txt.innerHTML);
      prev.inline = (prev.inline || '') + (prev.inline ? '\n' : '') + text;
      this._blocks.splice(index, 1);
    }
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(Math.max(0, index - 1), 'end');
  }

  focusBlock(index, where = 'end') {
    const blk = this._blocks[index];
    if (!blk) return;
    if (SOURCE_BLOCKS.includes(blk.type)) {
      this.openSource(index);
      return;
    }
    // 单宿主：光标用 Range 落，焦点给 #preview
    if (document.activeElement !== this.dom.preview) this.dom.preview.focus();
    if (!this.caretAt(index, where)) return;
  }

  // ---------------------------------------------------------------- 块结构操作
  removeBlock(index) {
    if (!this.note) return;
    const blk = this._blocks[index];
    if (!blk) return;
    this._blocks.splice(index, 1);
    if (!this._blocks.length) this._blocks.push({ type: 'empty', inline: '' });
    this.writeBack();
    this.renderBlocks();
    const target = Math.max(0, Math.min(index, this._blocks.length - 1));
    this.focusBlock(target, 'end');
  }

  appendBlock() {
    if (!this.note) return;
    this._blocks.push({ type: 'p', inline: '' });
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(this._blocks.length - 1, 'end');
  }

  appendAfter(index) {
    const at = Math.min((index == null ? this._blocks.length : index) + 1, this._blocks.length);
    this._blocks.splice(at, 0, { type: 'p', inline: '' });
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(at, 'end');
  }

  moveBlock(index, delta) {
    const j = index + delta;
    if (j < 0 || j >= this._blocks.length) return;
    const [blk] = this._blocks.splice(index, 1);
    this._blocks.splice(j, 0, blk);
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(j, 'end');
  }

  duplicateBlock(index) {
    const blk = this._blocks[index];
    if (!blk) return;
    this._blocks.splice(index + 1, 0, Object.assign({}, blk));
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(index + 1, 'end');
  }

  toggleTask(index) {
    const blk = this._blocks[index];
    if (!blk || blk.type !== 'task') return;
    blk.done = !blk.done;
    this.writeBack();
    this.renderBlocks();
  }

  /** 换块类型（/ 菜单用），保留文字 */
  convertBlock(index, type) {
    const blk = this._blocks[index];
    if (!blk || !this.note) return;
    blk.type = type;
    if (type === 'num') blk.num = 1;
    if (type !== 'task') blk.done = false;
    if (type === 'code') blk.src = blk.inline || '';
    if (type === 'table') blk.src = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';
    if (type === 'math') blk.src = blk.inline || '';
    this.writeBack();
    this.renderBlocks();
    if (SOURCE_BLOCKS.includes(type)) this.openSource(index);
    else this.focusBlock(index, 'end');
  }

  // ---------------------------------------------------------------- 源码块（代码/公式/表格）
  openSource(index) {
    const blk = this._blocks[index];
    const el = this.blkEl(index);
    if (!blk || !el) return;
    if (this._sourceIndex === index) return;
    this.commitSource();
    this._sourceIndex = index;
    this._sourceEl = el;
    this._sourceValue = blk.src || '';
    el.classList.add('is-editing');
    el.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'blk-editor';
    ta.spellcheck = false;
    ta.value = this._sourceValue;
    el.appendChild(ta);
    this.autosize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  onSourceInput(e) {
    const ta = e.target;
    if (!ta.classList || !ta.classList.contains('blk-editor')) return;
    this.autosize(ta);
    const index = this._sourceIndex;
    const blk = index == null ? null : this._blocks[index];
    if (!blk) return;
    blk.src = ta.value;
    this.writeBack();
  }

  commitSource() {
    const index = this._sourceIndex;
    if (index == null) return;
    const ta = this.dom.preview.querySelector(`.blk[data-i="${index}"] .blk-editor`);
    const blk = this._blocks[index];
    if (ta && blk) blk.src = ta.value;
    this._sourceIndex = null;
    this._sourceEl = null;
    this.writeBack();
    this.renderBlocks();
  }

  autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  // ---------------------------------------------------------------- 点击 / 键盘
  onBlockClick(e) {
    if (this._justDragged) { this._justDragged = false; return; }
    // Shift / Ctrl + 点击：块级多选（不进编辑）
    const hitBlk = e.target.closest && e.target.closest('.blk');
    if (hitBlk && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      const idx = Number(hitBlk.dataset.i);
      if (e.shiftKey && this._lastEdit != null && this._lastEdit !== idx) {
        const a = Math.min(this._lastEdit, idx);
        const b = Math.max(this._lastEdit, idx);
        this._sel = new Set();
        for (let k = a; k <= b; k += 1) this._sel.add(k);
      } else if (e.ctrlKey || e.metaKey) {
        if (this._sel.has(idx)) this._sel.delete(idx);
        else this._sel.add(idx);
        this._lastEdit = idx;
      } else {
        this._sel = new Set([idx]);
        this._lastEdit = idx;
      }
      e.preventDefault();
      this.repaintSelection();
      return;
    }
    if (this._sel.size && !document.querySelector('.blk-menu')) {
      this._sel.clear();
      this.repaintSelection();
    }
    const check = e.target.closest('.blk-check');
    if (check) { this.toggleTask(Number(check.dataset.i)); return; }
    if (e.target.closest('textarea')) return;
    const link = e.target.closest('.wl');
    const blk = e.target.closest('.blk');
    const editingThis = blk && Number(blk.dataset.i) === this._focus;
    if (link && !editingThis) { if (this.hooks.onLink) this.hooks.onLink(link.dataset.title); return; }
    const tag = e.target.closest('.tag');
    if (tag && !editingThis) { if (this.hooks.onTag) this.hooks.onTag(tag.dataset.tag); return; }
    if (!blk) {
      // 刚拖选完、松手后的 click 落在空白处 → 不要动选区
      const selNow = window.getSelection();
      if (selNow && !selNow.isCollapsed && selNow.toString()) return;
      // 点到正文里的空白（比如最后一块下面）→ 光标落到最后一块
      if (this._blocks.length) this.focusBlock(this._blocks.length - 1, 'end');
      return;
    }
    const index = Number(blk.dataset.i);
    if (blk.dataset.kind === 'source') { this.openSource(index); return; }
    // 富文本块：把光标放进去（真实点击时浏览器已经放过，这里兜底）
    const txt = blk.querySelector('.blk-txt');
    if (txt) {
      // 已经有"选了一段字"的选区（刚拖选完）→ 别动它，
      // 否则拖选松手后浏览器补发的 click 会把选区收成一点
      const selNow = window.getSelection();
      const keepSelection = selNow && !selNow.isCollapsed && selNow.rangeCount
        && txt.contains(selNow.anchorNode);
      if (!keepSelection) {
        const range = document.caretRangeFromPoint
          ? document.caretRangeFromPoint(e.clientX || 0, e.clientY || 0)
          : null;
        const sel = window.getSelection();
        if (range && txt.contains(range.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(range);
        } else if (!sel || !sel.rangeCount || !txt.contains(sel.anchorNode)) {
          this.caretAt(index, 'end');
        }
      }
      this._focus = index;
      this._lastEdit = index;
    }
  }

  onBlockDblClick() { /* 单击已经能进编辑，双击不再需要 */ }

  repaintSelection() {
    for (const el of this.dom.preview.querySelectorAll('.blk')) {
      el.classList.toggle('sel', this._sel.has(Number(el.dataset.i)));
    }
  }

  /** 块内 [from, to) 字符区间对应的 Range */
  _rangeInBlock(index, from, to) {
    const txt = this.editableEl(index);
    if (!txt) return null;
    const walker = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let startNode = null;
    let startOff = 0;
    let endNode = null;
    let endOff = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.nodeValue.length;
      if (!startNode && from <= pos + len) { startNode = node; startOff = Math.max(0, from - pos); }
      if (to <= pos + len && startNode) { endNode = node; endOff = Math.max(0, to - pos); break; }
      pos += len;
      node = walker.nextNode();
    }
    if (!startNode) return null;
    if (!endNode) { endNode = startNode; endOff = startNode.nodeValue.length; }
    try {
      const r = document.createRange();
      r.setStart(startNode, startOff);
      r.setEnd(endNode, endOff);
      return r;
    } catch { return null; }
  }

  clearPartialHighlight() {
    if (this._hlLayer) { this._hlLayer.remove(); this._hlLayer = null; }
  }

  paintPartialHighlight() {
    const p = this._partial;
    if (!p) return;
    const layer = document.createElement('div');
    layer.className = 'drag-layer';
    this.dom.preview.appendChild(layer);
    this._hlLayer = layer;
    const box = this.dom.preview.getBoundingClientRect();
    const put = (range) => {
      if (!range) return;
      for (const rc of range.getClientRects()) {
        if (rc.width < 1 || rc.height < 1) continue;
        const d = document.createElement('div');
        d.className = 'drag-hl';
        d.style.left = (rc.left - box.left) + 'px';
        d.style.top = (rc.top - box.top + this.dom.preview.scrollTop) + 'px';
        d.style.width = rc.width + 'px';
        d.style.height = rc.height + 'px';
        layer.appendChild(d);
      }
    };
    const down = p.toIndex >= p.fromIndex;
    const lo = down ? p.fromIndex : p.toIndex;
    const hi = down ? p.toIndex : p.fromIndex;
    const lenOf = (i) => (blockTextOf(this._blocks[i]) || '').length;
    // 逐块画：起点块从那个字、终点块到那个字、中间整块 —— 连起来就是"完整的选中内容"
    for (let i = lo; i <= hi; i += 1) {
      let from = 0;
      let to = lenOf(i);
      if (down) {
        if (i === p.fromIndex) from = p.fromOffset;
        if (i === p.toIndex) to = p.toOffset;
      } else {
        if (i === p.toIndex) from = p.toOffset;
        if (i === p.fromIndex) to = p.fromOffset;
      }
      put(this._rangeInBlock(i, from, to));
    }
  }

  /** 某个 Range 的起点落在第 index 块的"第几个字符" */
  _offsetInBlock(range, index) {
    const txt = this.editableEl(index);
    if (!txt || !range) return 0;
    try {
      const r = document.createRange();
      r.selectNodeContents(txt);
      r.setEnd(range.startContainer, range.startOffset);
      return r.toString().length;
    } catch { return 0; }
  }

  /** 按 `_partial` 拼出精确到字的文本（向下 / 向上都支持） */
  _partialText() {
    const p = this._partial;
    if (!p) return '';
    const text = (i) => (this._blocks[i] ? blockTextOf(this._blocks[i]) : '');
    const down = p.toIndex >= p.fromIndex;
    const lo = down ? p.fromIndex : p.toIndex;
    const hi = down ? p.toIndex : p.fromIndex;
    const out = [];
    for (let i = lo; i <= hi; i += 1) {
      let t = text(i);
      if (i === lo && down && i === p.fromIndex) t = t.slice(p.fromOffset);
      if (i === lo && !down && i === p.toIndex) t = t.slice(p.toOffset);
      if (i === hi && down && i === p.toIndex) t = t.slice(0, p.toOffset);
      if (i === hi && !down && i === p.fromIndex) t = t.slice(0, p.fromOffset);
      out.push(t);
    }
    return out.filter(Boolean).join('\n\n');
  }

  /** 选中块（>1 时才算多选）：返回下标数组（从大到小，方便删） */
  selectedIndexes() {
    return [...this._sel].sort((a, b) => a - b);
  }

  /** 删掉选中的多块 */
  deleteSelectedBlocks() {
    if (this._sel.size < 2) return false;
    const idxs = this.selectedIndexes().reverse();
    for (const i of idxs) this._blocks.splice(i, 1);
    if (!this._blocks.length) this._blocks.push({ type: 'empty', inline: '' });
    this._sel.clear();
    this.writeBack();
    this.renderBlocks();
    return true;
  }

  /** 选中块的文本（按顺序拼） */
  selectedText() {
    const precise = this._partialText();
    if (precise) return precise;
    const picked = window.getSelection ? String(window.getSelection() || '') : '';
    if (picked) return picked;
    return this.selectedIndexes()
      .map((i) => this._blocks[i] && blockTextOf(this._blocks[i]))
      .filter(Boolean)
      .join('\n\n');
  }

  /** 右键正文里的某一段 → 文本编辑菜单（里面再嵌「转为」块类型子菜单） */
  onPreviewContextMenu(e) {
    const blk = e.target.closest && e.target.closest('.blk');
    if (!blk) return;
    e.preventDefault();
    const index = Number(blk.dataset.i);
    this._focus = index;
    this._lastEdit = index;
    this.openBlockContextMenu(index, e.clientX, e.clientY);
  }

  /** 右键菜单：剪切 / 复制 / 粘贴 / 全选 + 转为 ▸ */
  openBlockContextMenu(index, x, y) {
    this.closeBlockMenu();
    // 只要有选中就按"选中"处理：不管右键落在哪一块，都不会把选中弄丢
    const multi = this._sel.size >= 1;
    if (multi) {
      const m2 = document.createElement('div');
      m2.className = 'blk-menu';
      m2.innerHTML = [
        '<button data-act="copy">' + (this._sel.size > 1 ? '复制选中 ' + this._sel.size + ' 块' : '复制这一块') + '</button>',
        '<button data-act="cut">剪切选中</button>',
        '<button data-act="del" class="danger">删除选中</button>',
      ].join('');
      m2.style.left = Math.max(6, Math.min(window.innerWidth - 180, x)) + 'px';
      m2.style.top = Math.max(6, Math.min(window.innerHeight - 140, y)) + 'px';
      document.body.appendChild(m2);
      this._menuEl = m2;
      m2.addEventListener('mousedown', (ev) => ev.preventDefault());
      m2.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        this.closeBlockMenu();
        if (act === 'copy' || act === 'cut') {
          const clip = window.foryou && window.foryou.clipboard;
          if (clip) clip.write(this.selectedText());
        }
        if (act === 'del' || act === 'cut') this.deleteSelectedBlocks();
      });
      setTimeout(() => window.addEventListener('pointerdown', this._closeMenuOnOutside, true), 0);
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'blk-menu';
    menu.innerHTML = [
      '<button data-act="cut">剪切</button>',
      '<button data-act="copy">复制</button>',
      '<button data-act="paste">粘贴</button>',
      '<button data-act="select">全选</button>',
      '<div class="sep"></div>',
      '<button data-act="type" class="has-sub">转为<span class="sub-arrow">▸</span></button>',
    ].join('');
    menu.style.left = Math.max(6, Math.min(window.innerWidth - 160, x)) + 'px';
    menu.style.top = Math.max(6, Math.min(window.innerHeight - 190, y)) + 'px';
    document.body.appendChild(menu);
    this._menuEl = menu;

    menu.addEventListener('mousedown', (ev) => ev.preventDefault());
    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'type') { this.openTypeSubMenu(index, btn); return; }
      this.closeBlockMenu();
      if (act === 'cut') this.cutBlock(index);
      else if (act === 'copy') this.copyBlock(index);
      else if (act === 'paste') this.pasteBlock(index);
      else if (act === 'select') this.selectBlock(index);
    });
    const typeBtn = menu.querySelector('[data-act="type"]');
    typeBtn.addEventListener('mouseenter', () => this.openTypeSubMenu(index, typeBtn));

    setTimeout(() => {
      window.addEventListener('pointerdown', this._closeMenuOnOutside, true);
    }, 0);
  }

  /** 「转为」子菜单：跟在右键菜单右边 */
  openTypeSubMenu(index, anchor) {
    if (this._subEl) { this._subEl.remove(); this._subEl = null; }
    const items = [
      ['p', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'],
      ['bullet', '无序列表'], ['num', '有序列表'], ['task', '待办'],
      ['quote', '引用'], ['code', '代码块'], ['math', '公式'], ['hr', '分割线'],
    ];
    const sub = document.createElement('div');
    sub.className = 'blk-menu slash sub';
    sub.innerHTML = items.map(([t, label]) => '<button data-type="' + t + '">' + label + '</button>').join('');
    const r = anchor.getBoundingClientRect();
    sub.style.left = Math.max(6, Math.min(window.innerWidth - 170, r.right + 2)) + 'px';
    sub.style.top = Math.max(6, Math.min(window.innerHeight - 300, r.top - 4)) + 'px';
    document.body.appendChild(sub);
    this._subEl = sub;
    sub.addEventListener('mousedown', (ev) => ev.preventDefault());
    sub.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const type = btn.dataset.type;
      this.closeBlockMenu();
      this.convertBlock(index, type);
    });
  }

  /** 这一块的纯文本（没选区时当作"整块"） */
  blockText(index) {
    const txt = this.editableEl(index);
    return txt ? txt.textContent : '';
  }

  selectBlock(index) {
    const txt = this.editableEl(index);
    if (!txt) return;
    txt.focus();
    const range = document.createRange();
    range.selectNodeContents(txt);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this._focus = index;
  }

  async copyBlock(index) {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed ? sel.toString() : '';
    const clip = window.foryou && window.foryou.clipboard;
    if (clip) await clip.write(picked || this.blockText(index));
  }

  async cutBlock(index) {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed ? sel.toString() : '';
    const clip = window.foryou && window.foryou.clipboard;
    if (clip) await clip.write(picked || this.blockText(index));
    const txt = this.editableEl(index);
    if (!txt) return;
    if (picked) {
      document.execCommand('delete');
    } else {
      txt.textContent = '';
      this.writeBack();
      this.renderBlocks();
    }
    this.syncInline(index);
  }

  async pasteBlock(index) {
    const clip = window.foryou && window.foryou.clipboard;
    if (!clip) return;
    const text = await clip.read();
    if (!text) return;
    this.focusBlock(index, 'end');
    this.insertIntoEditable(text);
    this.syncInline(index);
  }

  onPreviewKey(e) {
    const txt = (e.target.closest && e.target.closest('.blk-txt')) || this.currentBlockEl();
    const ta = e.target;
    if (ta.classList && ta.classList.contains('blk-editor')) {
      // 源码块（代码/公式/表格）里回车是换行；Ctrl+回车才在下面另起一块
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const at = this._sourceIndex;
        this.commitSource();
        this.appendAfter(at);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); this.commitSource(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = start + 2;
        this.onSourceInput({ target: ta });
      }
      return;
    }
    if (!txt) {
      // 选区端点直接落在宿主上（Ctrl+A 全选 / 从块外拖进来）：这种也要能删、能剪
      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X') && this.deleteSelectedContent({ copy: true })) {
        e.preventDefault();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.deleteSelectedContent()) {
        e.preventDefault();
        return;
      }
      return;
    }
    const index = Number(txt.closest('.blk').dataset.i);
    // 回车 = 拆块；Shift+回车 = 同一块内软换行
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.splitAtCaret();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      if (this.deleteSelectedContent({ copy: true })) { e.preventDefault(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.shiftKey && this.deleteSelectedContent()) {
      e.preventDefault();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this._sel.size > 1) {
      e.preventDefault();
      this.deleteSelectedBlocks();
      return;
    }
    if (e.key === 'Backspace' && this.caretAtBlockStart(txt)) {
      e.preventDefault();
      this.mergeUp();
      return;
    }
    // Tab / Shift+Tab：列表缩进、反缩进（Notion 的子项）
    if (e.key === 'Tab') {
      e.preventDefault();
      this.indentBlock(index, e.shiftKey ? -1 : 1);
      return;
    }
    // ↑ / ↓ 在块边界上跨块移动光标
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const before = r.cloneRange();
        before.selectNodeContents(txt);
        before.setEnd(r.startContainer, r.startOffset);
        const atStart = before.toString().length === 0;
        const after = r.cloneRange();
        after.selectNodeContents(txt);
        after.setStart(r.endContainer, r.endOffset);
        const atEnd = after.toString().length === 0;
        if (e.key === 'ArrowUp' && atStart && index > 0) {
          e.preventDefault();
          this.focusBlock(index - 1, 'end');
          return;
        }
        if (e.key === 'ArrowDown' && atEnd && index < this._blocks.length - 1) {
          e.preventDefault();
          this.focusBlock(index + 1, 'start');
          return;
        }
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.flush();
      if (this.hooks.onEscape) this.hooks.onEscape();
    }
  }

  onPreviewPaste(e) {
    if (!this.note) return;
    const file = this.imageFileOf(e.clipboardData);
    if (file) { e.preventDefault(); this.attachImage(file); return; }
    // 富文本块里只接受纯文本，别把外部的花样式带进来
    const txt = e.target.closest && e.target.closest('.blk-txt');
    if (!txt) return;
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // 多行粘贴 → 自动拆成多个块（和 Notion 一样）
    if (lines.length > 1) {
      const index = Number(txt.closest('.blk').dataset.i);
      const blk = this._blocks[index];
      if (!blk) return;
      const rest = lines.filter((l) => l.trim() !== '');
      if (rest.length) {
        blk.inline = [blk.inline, rest[0]].filter(Boolean).join(' ');
        const created = rest.slice(1).map((l) => ({ type: 'p', inline: l, depth: 0 }));
        this._blocks.splice(index + 1, 0, ...created);
        this.writeBack();
        this.renderBlocks();
        this.focusBlock(index + created.length, 'end');
        return;
      }
    }
    this.insertIntoEditable(text);
  }

  /** Tab / Shift+Tab：列表块缩进 / 反缩进 */
  indentBlock(index, delta) {
    const blk = this._blocks[index];
    if (!blk) return;
    const listLike = ['bullet', 'num', 'task'].includes(blk.type);
    if (!listLike) return;                 // 普通段落不缩进（保持行为可预期）
    const next = Math.max(0, Math.min(6, (blk.depth || 0) + delta));
    if (next === (blk.depth || 0)) return;
    blk.depth = next;
    this.writeBack();
    this.renderBlocks();
    this.focusBlock(index, 'end');
  }

  onPreviewDragOver(e) {
    if (this.imageFileOf(e.dataTransfer)) e.preventDefault();
  }

  onPreviewDrop(e) {
    if (!this.note) return;
    const file = this.imageFileOf(e.dataTransfer);
    if (!file) return;
    e.preventDefault();
    this.attachImage(file);
  }

  // ---------------------------------------------------------------- 手柄 / 菜单
  openBlockMenu(index, anchor) {
    this.closeBlockMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'blk-menu';
    menu.innerHTML = [
      '<button data-act="up">上移一块</button>',
      '<button data-act="down">下移一块</button>',
      '<button data-act="dup">复制一块</button>',
      '<button data-act="del" class="danger">删除这一块</button>',
    ].join('');
    menu.style.left = `${Math.max(6, rect.left - 120)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 150, rect.top)}px`;
    document.body.appendChild(menu);
    this._menuEl = menu;
    menu.addEventListener('mousedown', (ev) => ev.preventDefault());
    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      this.closeBlockMenu();
      if (act === 'up') this.moveBlock(index, -1);
      else if (act === 'down') this.moveBlock(index, 1);
      else if (act === 'dup') this.duplicateBlock(index);
      else if (act === 'del') this.removeBlock(index);
    });
    setTimeout(() => {
      window.addEventListener('pointerdown', this._closeMenuOnOutside, true);
    }, 0);
  }

  closeBlockMenu() {
    if (this._subEl) { this._subEl.remove(); this._subEl = null; }
    if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
    if (this._closeMenuOnOutside) {
      window.removeEventListener('pointerdown', this._closeMenuOnOutside, true);
    }
  }

  openSlashMenu(index, anchorRect) {
    this.closeBlockMenu();
    const items = [
      ['p', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'],
      ['bullet', '无序列表'], ['num', '有序列表'], ['task', '待办'],
      ['quote', '引用'], ['code', '代码块'], ['math', '公式'], ['hr', '分割线'],
    ];
    const menu = document.createElement('div');
    menu.className = 'blk-menu slash';
    menu.innerHTML = items.map(([t, label]) => `<button data-type="${t}">${label}</button>`).join('');
    menu.style.left = `${Math.max(6, anchorRect.left)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 280, anchorRect.bottom + 4)}px`;
    document.body.appendChild(menu);
    this._menuEl = menu;
    menu.addEventListener('mousedown', (ev) => ev.preventDefault());
    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      this.closeBlockMenu();
      this.convertBlock(index, btn.dataset.type);
    });
    setTimeout(() => {
      window.addEventListener('pointerdown', this._closeMenuOnOutside, true);
    }, 0);
  }

  // ---------------------------------------------------------------- 编辑
  onTitleInput() {
    if (!this.note) return;
    clearTimeout(this._titleTimer);
    // 空着就什么都别做：既不改笔记，也别把旧标题写回输入框。
    // （以前这里 500ms 后跑 commitTitle，见空就恢复旧标题，删字删到空就"弹回来"）
    if (!this.dom.title.value.trim()) return;
    this._titleTimer = setTimeout(() => this.commitTitle(), 500);
  }

  commitTitle({ force = false } = {}) {
    clearTimeout(this._titleTimer);
    if (!this.note) return;
    const next = this.dom.title.value.trim();
    if (!next) {
      // 只在离开输入框（或按回车）时才把原标题找回来；正在输入时绝不动输入框
      const editing = document.activeElement === this.dom.title;
      if (force || !editing) this.dom.title.value = this.note.title;
      return;
    }
    if (next === this.note.title) return;
    if (this.hooks.onRename) this.hooks.onRename(this.note.id, next);
  }

  /** 切换 / 保存前调用：提交源码块，把块内容写回笔记 */
  flush() {
    this.commitSource();
    this.writeBack();
  }

  /** 当前正在打字的元素（富文本块或源码块输入框） */
  activeEditor() {
    if (this._sourceIndex != null) {
      return this.dom.preview.querySelector(`.blk[data-i="${this._sourceIndex}"] .blk-editor`);
    }
    // 单宿主：输入焦点在 #preview 上，具体块由选区决定
    return this.currentBlockEl() || (this._focus == null ? null : this.editableEl(this._focus));
  }

  // ---------------------------------------------------------------- 图片
  /** 从剪贴板/拖放里挑出第一张图片文件 */
  imageFileOf(data) {
    if (!data) return null;
    const files = [...(data.files || [])].filter((f) => f.type && f.type.startsWith('image/'));
    if (files.length) return files[0];
    const items = [...(data.items || [])];
    const hit = items.find((i) => i.kind === 'file' && i.type && i.type.startsWith('image/'));
    return hit ? hit.getAsFile() : null;
  }

  onPaste(e) {
    if (!this.note) return;
    const file = this.imageFileOf(e.clipboardData);
    if (!file) return;          // 普通文字粘贴走浏览器默认行为
    e.preventDefault();
    this.attachImage(file);
  }

  onDrop(e) {
    if (!this.note) return;
    const file = this.imageFileOf(e.dataTransfer);
    if (!file) return;
    e.preventDefault();
    this.attachImage(file);
  }

  /** 存进库里的 image 目录，正文里只写文件名（界面上不出现任何路径） */
  async attachImage(file) {
    const api = window.foryou && window.foryou.images;
    if (!api) return;
    // 没有正在编辑的块时，先落到最后编辑过的那一块
    if (this._focus == null && this._sourceIndex == null) {
      this.focusBlock(this._lastEdit || 0, 'end');
    }
    const ext = (String(file.type || 'image/png').split('/')[1] || 'png')
      .replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const buffer = new Uint8Array(await file.arrayBuffer());
    const res = await api.save(buffer, ext);
    const name = res && res.name;
    if (!name) return;
    this.insertText(`![[${name}]]`);
    if (this.hooks.onImage) this.hooks.onImage(name);
  }

  /** 在当前光标处插入一段文本（图片引用等）。富文本块里插的是 markdown 片段。 */
  insertText(text) {
    const el = this.activeEditor();
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      const start = el.selectionStart == null ? el.value.length : el.selectionStart;
      const end = el.selectionEnd == null ? start : el.selectionEnd;
      const before = el.value.slice(0, start);
      const lead = before && !before.endsWith('\n') ? '\n' : '';
      el.value = before + lead + text + '\n' + el.value.slice(end);
      const pos = (before + lead + text + '\n').length;
      el.selectionStart = pos;
      el.selectionEnd = pos;
      this.onSourceInput({ target: el });
      return;
    }
    this.insertIntoEditable(text);
    const blk = el.closest('.blk');
    const index = blk ? Number(blk.dataset.i) : null;
    if (index != null) {
      this.syncInline(index);
      // 图片要真正渲染出来：写回后重排这一块
      this.writeBack();
      this.renderBlocks();
      this.focusBlock(index, 'end');
    }
  }

  // ---------------------------------------------------------------- 缩放
  syncScale() {
    const px = (base) => Math.round(base * this.scale);
    this.dom.preview.style.fontSize = px(15) + 'px';
    this.dom.title.style.fontSize = px(20) + 'px';
    this.dom.accent.style.height = Math.round(26 * this.scale) + 'px';
  }

  setScale(scale) {
    this.scale = Math.max(0.7, Math.min(2.4, scale));
    this.syncScale();
    const ta = this.activeEditor();
    if (ta) this.autosize(ta);
    if (this.hooks.onScale) this.hooks.onScale(this.scale);
  }

  // ---------------------------------------------------------------- 预览
  onChipClick(e) {
    const el = e.target.closest('.chip');
    if (!el) return;
    if (e.target.closest('.x')) {
      if (el.dataset.unlink) {
        if (this.hooks.onUnlink) this.hooks.onUnlink(this.note.id, el.dataset.unlink);
      } else if (el.dataset.unlinktext) {
        if (this.hooks.onUnlinkText) this.hooks.onUnlinkText(this.note.id, el.dataset.unlinktext);
      }
      return;
    }
    if (el.dataset.open && this.hooks.onOpenNote) this.hooks.onOpenNote(el.dataset.open);
    else if (el.dataset.create && this.hooks.onCreateMissing) this.hooks.onCreateMissing(el.dataset.create);
    else if (el.dataset.tag && this.hooks.onTag) this.hooks.onTag(el.dataset.tag);
  }

  // ---------------------------------------------------------------- 连接区
  renderMeta() {
    // 字数交给窗口底部状态栏显示（和「字号」合并在一起）
    const n = this.note ? Number(this.wordCount(this.note).replace(/,/g, '')) : 0;
    if (this.hooks.onWordCount) this.hooks.onWordCount(n);
  }

  /** 字数：去掉 markdown 符号、围栏和空白之后剩下的字符（中文按字、英文按词） */
  wordCount(note) {
    const raw = String((note && note.content) || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[\[[^\]]*\]\]/g, ' ')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/[#*`>~|]/g, ' ');
    const cjk = (raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const words = (raw.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return (cjk + words).toLocaleString('en-US');
  }

  /** 双击卡片时调用：直接进编辑态，光标落在块末 */
  focusEditor() {
    if (!this.note) return;
    // 走 setMode（内部会重画），否则预览态下的块没有 contenteditable，focus 不进去
    this.setMode('edit');
    const index = Math.min(this._lastEdit, this._blocks.length - 1);
    this.focusBlock(index < 0 ? 0 : index, 'end');
  }

  /** 兼容旧调用：进入第 index 块的编辑 */
  enterBlock(index) { this.focusBlock(index || 0, 'end'); }

  focusTitle() {
    this.dom.title.focus();
    this.dom.title.select();
  }
}

function blockTextOf(block) {
  if (!block) return '';
  if (block.type === 'empty') return '';
  if (block.type === 'code' || block.type === 'math' || block.type === 'table') return block.src || '';
  return block.inline || '';
}

/** 块纯文本：head=前 N 个字符，tail=true 时取第 N 个之后 */
function blockLen(block, n, tail = false) {
  const text = block ? blockTextOf(block) : '';
  if (n == null) return tail ? text : text;
  return tail ? text.slice(n) : text.slice(0, n);
}

function chip(text, open, unlink, title, extraClass = '', extraAttr = '') {
  const cls = ['chip', extraClass].filter(Boolean).join(' ');
  const openAttr = open ? ` ${open}` : '';
  const x = unlink ? `<span class="x" data-x="1">✕</span>` : '';
  return `<span class="${cls}"${openAttr} ${extraAttr} ${title || ''}>` +
    `<span class="text">${escapeHtml(text)}</span>${x}</span>`;
}
