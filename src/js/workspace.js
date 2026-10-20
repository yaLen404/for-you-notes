/** 工作区：笔记 / 图的查询与修改、撤销重做快照。
 *  所有落盘由 app.js 通过 window.foryou 完成，这里只维护内存状态。
 */

import { newId } from './ids.js';

const UNDO_MAX = 50;
const LINK_RE = /\[\[([^\[\]\n]{1,80})\]\]/g;
const TAG_RE = /(^|\s)#([0-9A-Za-z_\u4e00-\u9fa5-]{1,30})/g;
// ![[xxx.png]] 是图片，不是笔记链接
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export class Workspace {
  constructor(state, notes) {
    this.state = state;
    this.notes = notes;       // {id: note}
    this.undoStack = [];
    this.redoStack = [];
    this.onDirty = null;
  }

  // ---------------------------------------------------------------- 查询
  get graphId() { return this.state.graph_id; }

  graphs() { return this.state.graphs; }

  graph(gid) {
    const id = gid || this.graphId;
    return this.state.graphs.find((g) => g.id === id) || this.state.graphs[0];
  }

  note(id) { return id ? this.notes[id] || null : null; }

  notesOf(gid) {
    const id = gid || this.graphId;
    return Object.values(this.notes).filter((n) => n.graph === id);
  }

  findTitle(title, gid) {
    const t = String(title || '').trim();
    if (!t) return null;
    const list = this.notesOf(gid);
    return list.find((n) => n.title === t) ||
           list.find((n) => n.title.toLowerCase() === t.toLowerCase()) || null;
  }

  /** 画布连接 ∪ 正文链接 */
  outgoing(note) {
    const out = new Map();
    if (!note) return out;
    for (const link of note.links || []) {
      if (this.notes[link.id]) out.set(link.id, { ...link });
    }
    for (const title of bodyTitles(note.content)) {
      const target = this.findTitle(title, note.graph);
      if (target && !out.has(target.id)) {
        out.set(target.id, { id: target.id, shape: 'line', arrow: 'solid' });
      }
    }
    return out;
  }

  outgoingAttr(note) {
    const out = new Map();
    for (const link of (note && note.links) || []) {
      if (this.notes[link.id]) out.set(link.id, link);
    }
    return out;
  }

  outgoingText(note) {
    return bodyTitles(note ? note.content : '').map((title) => ({
      title, target: this.findTitle(title, note.graph),
    }));
  }

  missingTitles(note) {
    return this.outgoingText(note).filter((x) => !x.target).map((x) => x.title);
  }

  backlinks(note) {
    if (!note) return [];
    const result = [];
    for (const other of this.notesOf(note.graph)) {
      if (other.id === note.id) continue;
      const attr = (other.links || []).some((l) => l.id === note.id);
      if (attr) { result.push(other); continue; }
      if (note.title && bodyTitles(other.content).includes(note.title)) result.push(other);
    }
    return result;
  }

  tags(note) {
    const out = [];
    const text = note ? note.content : '';
    TAG_RE.lastIndex = 0;
    let m = TAG_RE.exec(text);
    while (m) {
      if (!out.includes(m[2])) out.push(m[2]);
      m = TAG_RE.exec(text);
    }
    return out;
  }

  linkCount(gid) {
    return this.notesOf(gid).reduce((sum, n) => sum + (n.links || []).length, 0);
  }

  islands(gid) {
    const list = this.notesOf(gid);
    const connected = new Set();
    for (const n of list) {
      if ((n.links || []).length) connected.add(n.id);
      for (const l of n.links || []) connected.add(l.id);
      for (const t of this.outgoingText(n)) {
        if (t.target) { connected.add(n.id); connected.add(t.target.id); }
      }
    }
    return list.filter((n) => !connected.has(n.id));
  }

  // ---------------------------------------------------------------- 修改
  uniqueTitle(base = '新笔记', gid) {
    const taken = new Set(this.notesOf(gid).map((n) => n.title));
    let name = base;
    let i = 2;
    while (taken.has(name)) { name = `${base} ${i}`; i += 1; }
    return name;
  }

  createNote({ title, content = '', gid, color } = {}) {
    const graphId = gid || this.graphId;
    const palette = ['#fb464c', '#e9973f', '#e0de71', '#44cf6e', '#53dfdd', '#a882ff'];
    const note = {
      id: newId('n'),
      title: title || this.uniqueTitle('新笔记', graphId),
      content,
      color: color !== undefined ? color : palette[this.notesOf(graphId).length % palette.length],
      created: Date.now(),
      updated: Date.now(),
      graph: graphId,
      links: [],
    };
    this.notes[note.id] = note;
    this.markDirty(note.id);
    return note;
  }

  deleteNote(id) {
    const note = this.notes[id];
    if (!note) return;
    delete this.notes[id];
    for (const other of this.notesOf(note.graph)) {
      other.links = (other.links || []).filter((l) => l.id !== id);
    }
    const g = this.graph(note.graph);
    if (g) {
      delete (g.pos || {})[id];
      delete (g.size || {})[id];
      if (g.selected === id) g.selected = null;
    }
    if (this.state.selected === id) this.state.selected = null;
    // 右栏"上次看的那篇"如果是它，也要清掉
    for (const g of this.state.graphs) {
      if (g.last_note === id) g.last_note = null;
    }
    this.pruneSides();
    this.markDirty(null);
  }

  /** 改标题，并把同图别的笔记里指向旧标题的 [[链接]] 一起改掉 */
  renameNote(id, title) {
    const note = this.notes[id];
    const next = String(title || '').trim();
    if (!note || !next || next === note.title) return false;
    const old = note.title;
    note.title = next;
    note.updated = Date.now();
    if (old) {
      const needle = `[[${old}]]`;
      for (const other of this.notesOf(note.graph)) {
        if (other.id === id) continue;
        if (!other.content.includes(needle)) continue;
        other.content = other.content.split(needle).join(`[[${next}]]`);
        other.updated = Date.now();
      }
    }
    this.markDirty(id);
    return true;
  }

  addLink(srcId, dstId, style = {}) {
    const src = this.notes[srcId];
    const dst = this.notes[dstId];
    if (!src || !dst || srcId === dstId) return;
    const link = (src.links || []).find((l) => l.id === dstId);
    if (link) {
      if (style.shape) link.shape = style.shape;
      if (style.arrow) link.arrow = style.arrow;
    } else {
      src.links = src.links || [];
      src.links.push({
        id: dstId,
        shape: style.shape === 'curve' ? 'curve' : 'line',
        arrow: ['solid', 'hollow', 'none'].includes(style.arrow) ? style.arrow : 'solid',
      });
    }
    src.updated = Date.now();
    this.markDirty(srcId);
  }

  removeLink(srcId, dstId) {
    const src = this.notes[srcId];
    if (!src) return;
    const before = (src.links || []).length;
    src.links = (src.links || []).filter((l) => l.id !== dstId);
    if (src.links.length !== before) {
      src.updated = Date.now();
      this.markDirty(srcId);
    }
  }

  setLinkStyle(srcId, dstId, style) {
    const src = this.notes[srcId];
    if (!src) return;
    const link = (src.links || []).find((l) => l.id === dstId);
    if (!link) return;
    if (style.shape) link.shape = style.shape;
    if (style.arrow) link.arrow = style.arrow;
    src.updated = Date.now();
    this.markDirty(srcId);
  }

  // ---------------------------------------------------------------- 图
  addGraph(name) {
    const base = (name || '新的图').trim() || '新的图';
    let final = base;
    let i = 2;
    while (this.state.graphs.some((g) => g.name === final)) { final = `${base} ${i}`; i += 1; }
    const g = {
      id: newId('g'), name: final, created: Date.now(),
      selected: null, zoom: 1, cam: [0, 0], pos: {}, size: {},
    };
    this.state.graphs.push(g);
    this.state.graph_id = g.id;
    this.state.selected = null;
    this.markDirty(null);
    return g;
  }

  renameGraph(gid, name) {
    const g = this.graph(gid);
    const next = String(name || '').trim();
    if (!g || !next) return;
    g.name = next;
    this.markDirty(null);
  }

  deleteGraph(gid) {
    if (this.state.graphs.length <= 1) return false;
    for (const id of Object.keys(this.notes)) {
      if (this.notes[id].graph === gid) delete this.notes[id];
    }
    this.state.graphs = this.state.graphs.filter((g) => g.id !== gid);
    if (this.state.graph_id === gid) {
      this.state.graph_id = this.state.graphs[0].id;
      this.state.selected = this.state.graphs[0].selected || null;
    }
    this.markDirty(null);
    return true;
  }

  switchGraph(gid) {
    if (gid === this.state.graph_id) return false;
    this.state.graph_id = gid;
    const g = this.graph(gid);
    this.state.selected = g.selected || null;
    this.markDirty(null);
    return true;
  }

  // ---------------------------------------------------------------- 接口（定死）
  /** 连线两端固定在卡片哪条边：存在这张图的 sides 里，key 是 "src>dst" */
  sidesKey(src, dst) { return `${src}>${dst}`; }

  getSides(src, dst) {
    const g = this.graph();
    const rec = g && g.sides ? g.sides[this.sidesKey(src, dst)] : null;
    if (Array.isArray(rec) && rec.length === 2) return { from: rec[0], to: rec[1] };
    return null;
  }

  setSides(src, dst, sides) {
    const g = this.graph();
    if (!g) return;
    if (!g.sides) g.sides = {};
    g.sides[this.sidesKey(src, dst)] = [sides.from, sides.to];
    this.markDirty(null);
  }

  clearSides(src, dst) {
    const g = this.graph();
    if (g && g.sides) delete g.sides[this.sidesKey(src, dst)];
  }

  /** 整张图的接口全部解冻：下一次渲染按当前位置重新钉一遍 */
  clearAllSides() {
    const g = this.graph();
    if (!g) return;
    g.sides = {};
    this.markDirty(null);
  }

  /** 笔记被删 / 连线被断之后，把不再需要的接口记录清掉 */
  pruneSides() {
    const g = this.graph();
    if (!g || !g.sides) return;
    for (const key of Object.keys(g.sides)) {
      const [src, dst] = key.split('>');
      if (!this.notes[src] || !this.notes[dst]) delete g.sides[key];
    }
  }

  // ---------------------------------------------------------------- 视图状态
  setPositions(gid, positions) {
    const g = this.graph(gid);
    if (!g) return;
    g.pos = {};
    for (const [id, p] of Object.entries(positions)) {
      g.pos[id] = [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
    }
  }

  setSizes(gid, sizes) {
    const g = this.graph(gid);
    if (!g) return;
    g.size = {};
    for (const [id, s] of Object.entries(sizes)) {
      if (s[0] > 0 && s[1] > 0) g.size[id] = [Math.round(s[0] * 10) / 10, Math.round(s[1] * 10) / 10];
    }
  }

  // ---------------------------------------------------------------- 快照
  snapshot() {
    return JSON.stringify({ state: this.state, notes: this.notes });
  }

  pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  restore(json) {
    const data = JSON.parse(json);
    this.state = data.state;
    this.notes = data.notes;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.markDirty(null);
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.markDirty(null);
    return true;
  }

  markDirty(noteId) {
    if (this.onDirty) this.onDirty(noteId);
  }
}

export function bodyTitles(content) {
  const out = [];
  const seen = new Set();
  const text = String(content || '');
  LINK_RE.lastIndex = 0;
  let m = LINK_RE.exec(text);
  while (m) {
    const title = m[1].trim();
    // ![[图片.png]] 是嵌图，不算笔记链接
    if (title && !IMAGE_NAME.test(title) && !seen.has(title)) { seen.add(title); out.push(title); }
    m = LINK_RE.exec(text);
  }
  return out;
}
