/** 画板：Obsidian Canvas 的 DOM 实现。
 *
 * · 点阵背景用 CSS radial-gradient，平移缩放只改 background-position/size —— 由合成器完成，60fps；
 * · 卡片是 DOM（border-radius / 彩色描边 / 标题条 + 渲染后的正文）；
 * · 连线是 SVG path（二次贝塞尔 + 箭头 marker）；
 * · 世界层 `transform: translate() scale()`，所以缩放时卡片和文字一起变。
 */

import * as G from './geometry.js';
import { render as renderMarkdown } from './markdown.js';

const HEADER_H = 32;
const PAD = 12;
const MIN_W = 220;
const MAX_W = 720;
const MIN_H = 80;
const MAX_H = 760;
const DEFAULT_LINES = 5;
const LINE_H = 21;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.6;
const SNAP_PX = 6;
const GRID = 24;

const ICON = '<svg class="card-icon" viewBox="0 0 11 13" fill="none" stroke="currentColor" ' +
  'stroke-width="1"><path d="M1.5 1.5h5l3 3v7h-8z"/><path d="M6.5 1.5v3h3"/></svg>';

export class Canvas {
  constructor(dom, ws, hooks = {}) {
    this.root = dom.canvas;
    this.world = dom.world;
    this.cardsEl = dom.cards;
    this.edgeLayer = dom.edgeLayer;
    this.edgeHit = dom.edgeHitLayer;
    this.emptyEl = dom.empty;
    this.ws = ws;
    this.hooks = hooks;

    this.zoom = 1;
    this.cam = [0, 0];
    this.records = new Map();   // id -> { note, x, y, w, h, explicit }
    this.selected = null;
    this.hover = null;
    this.selectedLink = null;   // {src, dst}
    this.hoverLink = null;
    this.query = '';
    this.focusOnly = false;
    this.needsFit = false;

    this._drag = null;
    this._guides = [];
    this._ctx = document.createElement('canvas').getContext('2d');
    this._previewEl = null;

    // 画布尺寸变化（窗口缩放、分栏拖动）必须重算变换，否则 DOM 与命中测试会对不上
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.applyView());
      this._ro.observe(this.root);
    }

    this._bind();
  }

  /** 合成事件里 pointerId 不在活动指针里，setPointerCapture 会抛异常 */
  _capture(e) {
    try { this.root.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 基础
  get canvasRect() { return this.root.getBoundingClientRect(); }

  toScreen(p) {
    const r = this.canvasRect;
    return [(p[0] + this.cam[0]) * this.zoom + r.width / 2, (p[1] + this.cam[1]) * this.zoom + r.height / 2];
  }

  /** 事件坐标 → 画布局部坐标（画布不在页面左上角，必须先减掉 rect） */
  localPoint(e) {
    const r = this.canvasRect;
    return [e.clientX - r.left, e.clientY - r.top];
  }

  toWorld(sx, sy) {
    const r = this.canvasRect;
    return [(sx - r.width / 2) / this.zoom - this.cam[0], (sy - r.height / 2) / this.zoom - this.cam[1]];
  }

  /** 鼠标最后停在画布上的那个点（世界坐标）；鼠标不在画布上时返回 null */
  pointerWorld() {
    if (!this._lastPoint) return null;
    return this.toWorld(this._lastPoint[0], this._lastPoint[1]);
  }

  /** 画布视口中心的世界坐标（没有鼠标位置时新建笔记用它） */
  centerWorld() {
    const r = this.canvasRect;
    return this.toWorld(r.width / 2, r.height / 2);
  }

  record(id) { return this.records.get(id) || null; }

  note(id) { return this.ws.note(id); }

  visible(note) {
    if (!this.records.has(note.id)) return false;
    const q = this.query.trim().toLowerCase();
    if (q && !(note.title + '\n' + note.content).toLowerCase().includes(q)) return false;
    if (this.focusOnly && this.selected && note.id !== this.selected) {
      return this.neighbours(this.selected).has(note.id);
    }
    return true;
  }

  neighbours(id) {
    const out = new Set();
    const note = this.note(id);
    if (!note) return out;
    for (const tid of this.ws.outgoing(note).keys()) out.add(tid);
    for (const other of this.ws.notesOf(note.graph)) {
      if (this.ws.outgoing(other).has(id)) out.add(other.id);
    }
    return out;
  }

  // ---------------------------------------------------------------- 视图
  applyView() {
    const r = this.canvasRect;
    const tx = r.width / 2 + this.cam[0] * this.zoom;
    const ty = r.height / 2 + this.cam[1] * this.zoom;
    this.world.style.transform = `translate(${tx}px, ${ty}px) scale(${this.zoom})`;
    const grid = GRID * this.zoom;
    this.root.style.backgroundSize = `${grid}px ${grid}px`;
    this.root.style.backgroundPosition = `${tx}px ${ty}px`;
    this.root.style.setProperty('--z', String(this.zoom));
    if (this.hooks.onView) this.hooks.onView();
  }

  setZoom(z, anchor) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (Math.abs(next - this.zoom) < 1e-9) return;
    const r = this.canvasRect;
    const ax = anchor ? anchor[0] : r.width / 2;
    const ay = anchor ? anchor[1] : r.height / 2;
    const wx = (ax - r.width / 2) / this.zoom - this.cam[0];
    const wy = (ay - r.height / 2) / this.zoom - this.cam[1];
    this.zoom = next;
    this.cam[0] = (ax - r.width / 2) / this.zoom - wx;
    this.cam[1] = (ay - r.height / 2) / this.zoom - wy;
    this.applyView();
    this.persistView();
    if (this.hooks.onZoom) this.hooks.onZoom(this.zoom);
  }

  zoomBy(factor, anchor) { this.setZoom(this.zoom * factor, anchor); }

  fit() {
    if (!this.records.size) {
      this.zoom = 1; this.cam = [0, 0]; this.applyView(); return;
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const rec of this.records.values()) {
      x1 = Math.min(x1, rec.x); y1 = Math.min(y1, rec.y);
      x2 = Math.max(x2, rec.x + rec.w); y2 = Math.max(y2, rec.y + rec.h);
    }
    const r = this.canvasRect;
    const margin = 56;
    const zx = (r.width - margin * 2) / Math.max(1, x2 - x1);
    const zy = (r.height - margin * 2) / Math.max(1, y2 - y1);
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(zx, zy)));
    this.cam = [-(x1 + x2) / 2, -(y1 + y2) / 2];
    this.applyView();
    this.persistView();
    if (this.hooks.onZoom) this.hooks.onZoom(this.zoom);
  }

  persistView() {
    const g = this.ws.graph();
    if (!g) return;
    g.zoom = Math.round(this.zoom * 1e6) / 1e6;
    g.cam = [Math.round(this.cam[0] * 1000) / 1000, Math.round(this.cam[1] * 1000) / 1000];
    this.ws.markDirty(null);
  }

  // ---------------------------------------------------------------- 数据
  attach(gid) {
    if (gid) this.ws.switchGraph(gid);
    const g = this.ws.graph();
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, g.zoom || 1));
    this.cam = Array.isArray(g.cam) ? [g.cam[0] || 0, g.cam[1] || 0] : [0, 0];
    this.selected = this.ws.note(this.ws.state.selected) ? this.ws.state.selected : null;
    this.selectedLink = null;
    this.query = '';
    this.focusOnly = false;
    this._repairOnBuild = true;
    this.rebuild();
  }

  rebuild({ layout = true } = {}) {
    const g = this.ws.graph();
    const stored = g.pos || {};
    const sizes = g.size || {};
    this.records.clear();
    this.needsFit = Object.keys(stored).length === 0;
    for (const note of this.ws.notesOf()) {
      const [w0, h0] = this.defaultSize(note);
      const hasSize = Array.isArray(sizes[note.id]);
      const w = hasSize ? Math.max(MIN_W, Math.min(MAX_W, sizes[note.id][0])) : w0;
      const h = hasSize ? Math.max(MIN_H, Math.min(MAX_H, sizes[note.id][1])) : h0;
      const p = Array.isArray(stored[note.id]) ? stored[note.id] : [0, 0];
      this.records.set(note.id, {
        note, x: p[0], y: p[1], w, h, explicit: hasSize,
      });
    }
    if (layout && this.needsFit && this.records.size) {
      this.seedSpiral();
      this.simulate(220);
      this.separate();
      this.persistPositions();
    } else if (layout && this._repairOnBuild && this.hasOverlaps()) {
      // 旧版本卡片更小，升级后按老坐标摆会互相压住：轻推一次并记下来。
      // 只在打开这张图时做一次，平时 rebuild（新建笔记等）不能因为"有重叠"就乱挪。
      this._repairOnBuild = false;
      this.separate();
      this.persistPositions();
    }
    this.render();
    // 相机是每张图各存一份的，attach 之后必须重新套用，否则 DOM 还停在上一次的变换上
    this.applyView();
    if (layout && this.needsFit) this.fit();
  }

  reload() {
    // 数据变了但视图不变：重建卡片尺寸（没手动拉伸过的跟着标题变）
    const g = this.ws.graph();
    const sizes = g.size || {};
    for (const [id, rec] of this.records) {
      const note = this.ws.note(id);
      if (!note) continue;
      rec.note = note;
      if (!rec.explicit && !Array.isArray(sizes[id])) {
        const [w, h] = this.defaultSize(note);
        rec.w = w; rec.h = h;
      }
    }
    this.render();
  }

  /** 默认尺寸：宽度按标题、高度按正文前几行（和 Obsidian 的文件卡观感一致） */
  defaultSize(note) {
    this._ctx.font = '600 14px "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    const titleW = this._ctx.measureText(note.title || '未命名').width;
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(titleW + 30 + 26)));
    this._ctx.font = '400 14px "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    const inner = w - PAD * 2;
    let lines = 0;
    for (const plain of htmlLines(note.content)) {
      const words = plain;
      let line = '';
      for (const ch of words) {
        if (this._ctx.measureText(line + ch).width > inner) { lines += 1; line = ch; }
        else line += ch;
        if (lines >= DEFAULT_LINES) break;
      }
      if (line) lines += 1;
      if (lines >= DEFAULT_LINES) break;
    }
    lines = Math.max(1, Math.min(DEFAULT_LINES, lines));
    const h = HEADER_H + PAD * 2 + lines * LINE_H;
    return [w, Math.max(MIN_H, Math.round(h))];
  }

  positions() {
    const out = {};
    for (const [id, rec] of this.records) out[id] = [rec.x, rec.y];
    return out;
  }

  sizes() {
    const out = {};
    for (const [id, rec] of this.records) if (rec.explicit) out[id] = [rec.w, rec.h];
    return out;
  }

  persistPositions() {
    this.ws.setPositions(this.ws.graphId, this.positions());
    this.ws.setSizes(this.ws.graphId, this.sizes());
  }

  // ---------------------------------------------------------------- 渲染
  render() {
    const html = [];
    const order = [...this.records.keys()].filter((id) => this.visible(this.records.get(id).note));
    order.sort((a, b) => (a === this.selected ? 1 : 0) - (b === this.selected ? 1 : 0));
    for (const id of order) html.push(this.cardHtml(this.records.get(id)));
    this.cardsEl.innerHTML = html.join('');
    this.renderEdges();
    this.renderEmpty();
    if (this.hooks.onView) this.hooks.onView();
  }

  cardHtml(rec) {
    const note = rec.note;
    const exists = (t) => Boolean(this.ws.findTitle(t, note.graph));
    const cls = ['card'];
    if (note.color) cls.push('colored');
    if (note.id === this.selected) cls.push('selected');
    if (note.id === this.hover) cls.push('hover');
    if (!this.visible(note)) cls.push('dim');
    const style = [
      `left:${rec.x}px`, `top:${rec.y}px`, `width:${rec.w}px`, `height:${rec.h}px`,
      note.color ? `--c:${note.color}` : '',
    ].filter(Boolean).join(';');
    const body = renderMarkdown(note.content || '', exists);
    return `<div class="${cls.join(' ')}" data-id="${note.id}" style="${style}">
      <div class="card-inner">
        <div class="card-head">${ICON}<span class="card-title">${escapeHtml(note.title || '未命名')}</span><span class="card-open">↗</span></div>
        <div class="card-body">${body}</div>
      </div>
      <div class="handle" data-corner="nw"></div><div class="handle" data-corner="ne"></div>
      <div class="handle" data-corner="sw"></div><div class="handle" data-corner="se"></div>
      <div class="dot" data-side="n"></div><div class="dot" data-side="s"></div>
      <div class="dot" data-side="w"></div><div class="dot" data-side="e"></div>
    </div>`;
  }

  renderEmpty() {
    if (!this.emptyEl) return;
    if (this.records.size === 0 && !this.query) {
      this.emptyEl.hidden = false;
    } else {
      this.emptyEl.hidden = true;
    }
  }

  /** 所有连线（属性连接 ∪ 正文链接） */
  allLinks() {
    const out = [];
    for (const [id, rec] of this.records) {
      if (!this.visible(rec.note)) continue;
      for (const [dst, link] of this.ws.outgoing(rec.note)) {
        if (!this.records.has(dst)) continue;
        out.push({ src: id, dst, link });
      }
    }
    return out;
  }

  renderEdges() {
    const paths = [];
    const hits = [];
    const ports = [];
    for (const { src, dst, link } of this.allLinks()) {
      const a = this.records.get(src);
      const b = this.records.get(dst);
      if (!a || !b) continue;
      const ra = { x: a.x, y: a.y, w: a.w, h: a.h };
      const rb = { x: b.x, y: b.y, w: b.w, h: b.h };
      // 接口是定死的：没有记录时按连接时的几何算一次并记下来，之后再怎么挪都不换边
      let sides = this.ws.getSides(src, dst);
      if (!sides) {
        const [from, to] = G.facingSides(ra, rb);
        sides = { from, to };
        this.ws.setSides(src, dst, sides);
      }
      const path = G.linkPath(ra, rb, link.shape, sides);
      const sel = this.selectedLink && this.selectedLink.src === src && this.selectedLink.dst === dst;
      const hov = this.hoverLink && this.hoverLink.src === src && this.hoverLink.dst === dst;
      const cls = ['edge', sel ? 'selected' : '', hov ? 'hover' : ''].filter(Boolean).join(' ');
      const marker = link.arrow === 'none' ? '' : ` marker-end="url(#${sel ? 'arrow-sel' : 'arrow'})"`;
      // 选中这条线时，把两端真正落在哪个"接口"画出来（换边时一眼能看见）
      if (sel) {
        for (const p of [path.start, path.end]) {
          ports.push(`<circle class="port" cx="${p[0]}" cy="${p[1]}" r="${9 / this.zoom}" />`);
        }
      }
      paths.push(`<path class="${cls}" d="${path.d}"${marker} data-src="${src}" data-dst="${dst}"></path>`);
      hits.push(`<path class="hit" d="${path.d}" data-hitsrc="${src}" data-hitdst="${dst}"></path>`);
    }
    this.edgeLayer.innerHTML = paths.join('') + ports.join('');
    this.edgeHit.innerHTML = hits.join('');
  }

  /** 拖拽时只更新受影响的几何，不做整树重建 */
  updateCardPosition(id) {
    const rec = this.records.get(id);
    const el = this.cardsEl.querySelector(`.card[data-id="${id}"]`);
    if (!rec || !el) return;
    el.style.left = `${rec.x}px`;
    el.style.top = `${rec.y}px`;
  }

  updateCardSize(id) {
    const rec = this.records.get(id);
    const el = this.cardsEl.querySelector(`.card[data-id="${id}"]`);
    if (!rec || !el) return;
    el.style.width = `${rec.w}px`;
    el.style.height = `${rec.h}px`;
  }

  // ---------------------------------------------------------------- 选择
  select(id, { scroll = false } = {}) {
    if (this.selected === id) return;
    this.selected = id;
    this.selectedLink = null;
    const g = this.ws.graph();
    if (g) g.selected = id;
    this.ws.state.selected = id;
    this.ws.markDirty(null);
    this.paintSelection();
    if (this.hooks.onSelect) this.hooks.onSelect(id);
  }

  /** 点空白：取消选中（笔记和连线都取消），右栏回到"还没选中笔记" */
  clearSelection() {
    if (this.selected === null && !this.selectedLink) return;
    this.selected = null;
    this.selectedLink = null;
    this.hoverLink = null;
    const g = this.ws.graph();
    if (g) g.selected = null;
    this.ws.state.selected = null;
    this.ws.markDirty(null);
    this.paintSelection();
    if (this.hooks.onSelect) this.hooks.onSelect(null);
  }

  paintSelection() {
    for (const el of this.cardsEl.querySelectorAll('.card')) {
      el.classList.toggle('selected', el.dataset.id === this.selected);
    }
    for (const el of this.cardsEl.querySelectorAll('.card')) {
      el.classList.toggle('dim', !this.visible(this.records.get(el.dataset.id).note));
    }
    this.renderEdges();
  }

  paintHover() {
    for (const el of this.cardsEl.querySelectorAll('.card')) {
      el.classList.toggle('hover', el.dataset.id === this.hover);
    }
  }

  hasOverlaps() {
    const recs = [...this.records.values()];
    for (let i = 0; i < recs.length; i += 1) {
      for (let j = i + 1; j < recs.length; j += 1) {
        const a = recs[i];
        const b = recs[j];
        const ox = (a.w + b.w) / 2 - Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
        const oy = (a.h + b.h) / 2 - Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
        if (ox > 2 && oy > 2) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 布局
  seedSpiral() {
    const degree = new Map();
    for (const [id, rec] of this.records) degree.set(id, this.ws.outgoing(rec.note).size);
    const order = [...this.records.keys()].sort((a, b) =>
      (degree.get(b) - degree.get(a)) || (a < b ? -1 : 1));
    const step = 118;
    order.forEach((id, i) => {
      const rec = this.records.get(id);
      const angle = i * 1.35;
      const radius = step * Math.sqrt(i + 0.6);
      rec.x = Math.cos(angle) * radius;
      rec.y = Math.sin(angle) * radius;
    });
  }

  simulate(iterations = 220) {
    const ids = [...this.records.keys()];
    if (!ids.length) return;
    const idx = new Map(ids.map((id, i) => [id, i]));
    const links = [];
    for (const [id, rec] of this.records) {
      for (const dst of this.ws.outgoing(rec.note).keys()) {
        if (idx.has(dst) && idx.get(id) < idx.get(dst)) links.push([idx.get(id), idx.get(dst)]);
      }
    }
    const REPEL = 90000, SPRING = 0.05, REST = 260, GRAVITY = 0.048, STEP = 0.55;
    const pos = ids.map((id) => [this.records.get(id).x, this.records.get(id).y]);
    const size = ids.map((id) => [this.records.get(id).w, this.records.get(id).h]);
    const n = ids.length;
    for (let it = 0; it < iterations; it += 1) {
      const fx = new Array(n).fill(0);
      const fy = new Array(n).fill(0);
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          let dx = pos[i][0] - pos[j][0];
          let dy = pos[i][1] - pos[j][1];
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) { dx = 1; dy = 1; d2 = 2; }
          const d = Math.sqrt(d2);
          const f = REPEL / Math.max(d2, 1e-3) / d;
          fx[i] += dx * f; fy[i] += dy * f;
          fx[j] -= dx * f; fy[j] -= dy * f;
        }
      }
      for (const [i, j] of links) {
        const dx = pos[j][0] - pos[i][0];
        const dy = pos[j][1] - pos[i][1];
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = SPRING * (d - REST) / d;
        fx[i] += dx * f; fy[i] += dy * f;
        fx[j] -= dx * f; fy[j] -= dy * f;
      }
      for (let i = 0; i < n; i += 1) {
        fx[i] -= pos[i][0] * GRAVITY;
        fy[i] -= pos[i][1] * GRAVITY;
        pos[i][0] += Math.max(-90, Math.min(90, fx[i] * STEP));
        pos[i][1] += Math.max(-90, Math.min(90, fy[i] * STEP));
      }
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const w = (size[i][0] + size[j][0]) / 2 + 40 - Math.abs(pos[i][0] + size[i][0] / 2 - (pos[j][0] + size[j][0] / 2));
          const h = (size[i][1] + size[j][1]) / 2 + 40 - Math.abs(pos[i][1] + size[i][1] / 2 - (pos[j][1] + size[j][1] / 2));
          if (w <= 0 || h <= 0) continue;
          if (w < h) {
            const push = (w / 2 + 0.5) * (pos[i][0] < pos[j][0] ? 1 : -1);
            pos[i][0] -= push; pos[j][0] += push;
          } else {
            const push = (h / 2 + 0.5) * (pos[i][1] < pos[j][1] ? 1 : -1);
            pos[i][1] -= push; pos[j][1] += push;
          }
        }
      }
    }
    ids.forEach((id, i) => {
      const rec = this.records.get(id);
      rec.x = Math.round(pos[i][0] * 100) / 100;
      rec.y = Math.round(pos[i][1] * 100) / 100;
    });
  }

  separate() {
    const ids = [...this.records.keys()];
    for (let round = 0; round < 120; round += 1) {
      let moved = false;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = this.records.get(ids[i]);
          const b = this.records.get(ids[j]);
          const ox = (a.w + b.w) / 2 + 24 - Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
          const oy = (a.h + b.h) / 2 + 24 - Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const push = ox / 2;
            if (a.x < b.x) { a.x -= push; b.x += push; } else { a.x += push; b.x -= push; }
          } else {
            const push = oy / 2;
            if (a.y < b.y) { a.y -= push; b.y += push; } else { a.y += push; b.y -= push; }
          }
        }
      }
      if (!moved) break;
    }
  }

  arrange(randomize = false) {
    if (!this.records.size) return;
    if (randomize) {
      for (const rec of this.records.values()) {
        rec.x = (Math.random() - 0.5) * 900;
        rec.y = (Math.random() - 0.5) * 640;
      }
    } else {
      this.seedSpiral();
    }
    this.simulate(260);
    this.separate();
    this.persistPositions();
    this.render();
    this.fit();
  }

  // ---------------------------------------------------------------- 吸附
  snap(id, x, y, w, h) {
    const tol = SNAP_PX / this.zoom;
    const xs = [], ys = [];
    for (const [other, rec] of this.records) {
      if (other === id) continue;
      xs.push(rec.x, rec.x + rec.w / 2, rec.x + rec.w);
      ys.push(rec.y, rec.y + rec.h / 2, rec.y + rec.h);
    }
    let dx = 0, gx = null, bx = tol + 1e-9;
    for (const target of xs) {
      for (const mine of [x, x + w / 2, x + w]) {
        const d = target - mine;
        if (Math.abs(d) <= bx) { bx = Math.abs(d); dx = d; gx = target; }
      }
    }
    let dy = 0, gy = null, by = tol + 1e-9;
    for (const target of ys) {
      for (const mine of [y, y + h / 2, y + h]) {
        const d = target - mine;
        if (Math.abs(d) <= by) { by = Math.abs(d); dy = d; gy = target; }
      }
    }
    this._guides = [];
    if (gx !== null) this._guides.push(['x', gx]);
    if (gy !== null) this._guides.push(['y', gy]);
    return [x + dx, y + dy];
  }

  drawGuides() {
    this.root.querySelectorAll('.guide').forEach((el) => el.remove());
    for (const [axis, coord] of this._guides) {
      const el = document.createElement('div');
      el.className = 'guide ' + (axis === 'x' ? 'v' : 'h');
      const [sx, sy] = this.toScreen(axis === 'x' ? [coord, 0] : [0, coord]);
      if (axis === 'x') el.style.left = `${sx}px`; else el.style.top = `${sy}px`;
      this.root.appendChild(el);
    }
  }

  clearGuides() {
    this._guides = [];
    this.root.querySelectorAll('.guide').forEach((el) => el.remove());
  }

  // ---------------------------------------------------------------- 命中测试
  hitCard(clientX, clientY, pad = 0) {
    const r = this.canvasRect;
    const [wx, wy] = this.toWorld(clientX - r.left, clientY - r.top);
    const ids = [...this.records.keys()].reverse();
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!this.visible(rec.note)) continue;
      if (wx >= rec.x - pad && wx <= rec.x + rec.w + pad &&
          wy >= rec.y - pad && wy <= rec.y + rec.h + pad) return id;
    }
    return null;
  }

  // ---------------------------------------------------------------- 事件
  _bind() {
    this.root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    // 右键菜单关掉 / 用户点了别处之后，把"右键提示"的清掉
    document.addEventListener('pointerdown', () => this.clearContextCard(), true);
    // 记住鼠标最后落在画布的哪一点：Ctrl+N 新建的笔记就出现在那儿
    this.root.addEventListener('pointermove', (e) => {
      this._lastPoint = this.localPoint(e);
    });
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.root.addEventListener('pointerover', (e) => this.onHover(e));
    this.root.addEventListener('pointerleave', () => {
      if (this.hover) { this.hover = null; this.paintHover(); }
      this._lastPoint = null;   // 鼠标离开画布后，"光标位置"就不作数了
    });
  }

  onHover(e) {
    if (this._drag) return;
    const card = e.target.closest('.card');
    const id = card ? card.dataset.id : null;
    if (id !== this.hover) {
      this.hover = id;
      this.paintHover();
    }
  }

  onPointerDown(e) {
    if (e.button === 2) return;
    const t = e.target;
    // 画布上浮着的控件（缩放条 / 左下工具条 / 卡片工具条）自己处理点击；
    // 以前这里会把它们当成"空白处按下"，接着 setPointerCapture 抢走指针，
    // 结果按钮的 click 永远不来 —— 表现就是"缩放条点了没反应"。
    if (t.closest && t.closest('.pill, .toolbar')) return;
    const handle = t.closest('.handle');
    const dot = t.closest('.dot');
    const cardEl = t.closest('.card');
    const hit = t.closest('path.hit');

    if (handle && this.selected) {
      const rec = this.records.get(this.selected);
      this._drag = {
        kind: 'resize', id: this.selected, corner: handle.dataset.corner,
        startX: e.clientX, startY: e.clientY, x: rec.x, y: rec.y, w: rec.w, h: rec.h,
        moved: false,
      };
      this._capture(e);
      e.preventDefault();
      return;
    }
    if (dot) {
      const card = dot.closest('.card');
      const id = card.dataset.id;
      const rec = this.records.get(id);
      const side = dot.dataset.side;
      const anchor = G.anchor({ x: rec.x, y: rec.y, w: rec.w, h: rec.h }, side);
      this._drag = { kind: 'link', src: id, side, start: this.toScreen(anchor) };
      this.showPreviewLine(this.toScreen(anchor), this.localPoint(e));
      this._capture(e);
      e.preventDefault();
      return;
    }
    if (hit) {
      this.selectedLink = { src: hit.dataset.hitsrc, dst: hit.dataset.hitdst };
      this.ws.state.selected = this.selected;
      this.renderEdges();
      this.root.focus();
      if (this.hooks.onLinkSelect) {
        this.hooks.onLinkSelect(this.selectedLink, e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }
    if (cardEl) {
      const id = cardEl.dataset.id;
      const rec = this.records.get(id);
      const [lx, ly] = this.localPoint(e);
      const [wx, wy] = this.toWorld(lx, ly);
      // 点卡片就把键盘焦点收回画布：笔记那边会据此自动切回预览
      this.root.focus();
      if (this.selected !== id) this.select(id);
      this._drag = {
        kind: 'move', id, startX: e.clientX, startY: e.clientY,
        x: rec.x, y: rec.y, w: rec.w, h: rec.h, moved: false,
      };
      this._capture(e);
      e.preventDefault();
      return;
    }
    // 空白：平移；没拖动就当成"点空白"，松手时取消选中
    this._drag = {
      kind: 'pan', startX: e.clientX, startY: e.clientY,
      camX: this.cam[0], camY: this.cam[1], moved: false,
    };
    this.root.classList.add('panning');
    this._capture(e);
    this.root.focus();
    e.preventDefault();
  }

  onPointerMove(e) {
    if (!this._drag) return;
    const d = this._drag;
    if (d.kind === 'pan') {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) d.moved = true;
      this.cam[0] = d.camX + (e.clientX - d.startX) / this.zoom;
      this.cam[1] = d.camY + (e.clientY - d.startY) / this.zoom;
      this.applyView();
      return;
    }
    if (d.kind === 'move') {
      const dx = (e.clientX - d.startX) / this.zoom;
      const dy = (e.clientY - d.startY) / this.zoom;
      const rec = this.records.get(d.id);
      const [x, y] = this.snap(d.id, d.x + dx, d.y + dy, rec.w, rec.h);
      if (!d.moved && this.hooks.onBeforeChange) this.hooks.onBeforeChange();
      rec.x = Math.round(x * 100) / 100;
      rec.y = Math.round(y * 100) / 100;
      d.moved = true;
      this.updateCardPosition(d.id);
      this.renderEdges();
      this.drawGuides();
      return;
    }
    if (d.kind === 'resize') {
      const dx = (e.clientX - d.startX) / this.zoom;
      const dy = (e.clientY - d.startY) / this.zoom;
      const rec = this.records.get(d.id);
      if (!d.moved && this.hooks.onBeforeChange) this.hooks.onBeforeChange();
      d.moved = true;
      let { x, y, w, h } = d;
      if (d.corner.includes('e')) w = Math.max(MIN_W, Math.min(MAX_W, d.w + dx));
      if (d.corner.includes('s')) h = Math.max(MIN_H, Math.min(MAX_H, d.h + dy));
      if (d.corner.includes('w')) {
        const nw = Math.max(MIN_W, Math.min(MAX_W, d.w - dx));
        x = d.x + (d.w - nw); w = nw;
      }
      if (d.corner.includes('n')) {
        const nh = Math.max(MIN_H, Math.min(MAX_H, d.h - dy));
        y = d.y + (d.h - nh); h = nh;
      }
      rec.x = Math.round(x * 100) / 100; rec.y = Math.round(y * 100) / 100;
      rec.w = Math.round(w * 100) / 100; rec.h = Math.round(h * 100) / 100;
      rec.explicit = true;
      this.updateCardPosition(d.id);
      this.updateCardSize(d.id);
      this.renderEdges();
      return;
    }
    if (d.kind === 'link') {
      const anchor = this.toScreen(G.anchor(
        { x: this.records.get(d.src).x, y: this.records.get(d.src).y,
          w: this.records.get(d.src).w, h: this.records.get(d.src).h }, d.side));
      this.showPreviewLine(anchor, this.localPoint(e));
      const over = this.hitCard(e.clientX, e.clientY);
      this.hover = over && over !== d.src ? over : null;
      this.paintHover();
      this.showTargetPort(this.hover, d.src);
    }
  }

  onPointerUp(e) {
    const d = this._drag;
    this._drag = null;
    this.root.classList.remove('panning');
    this.clearGuides();
    this.hidePreviewLine();
    this.hideTargetPort();
    if (!d) return;
    if (d.kind === 'pan') {
      this.persistView();
      // 只点不拖：把选中取消掉（拖动平移时保留选中）
      if (!d.moved) this.clearSelection();
    }
    if (d.kind === 'move' && d.moved) {
      this.persistPositions();
      this.ws.markDirty(null);
      this.renderEdges();
      if (this.hooks.onNodeMoved) this.hooks.onNodeMoved(d.id);
    }
    if (d.kind === 'resize') {
      this.persistPositions();
      this.ws.markDirty(null);
      this.renderEdges();
      if (this.hooks.onResize) this.hooks.onResize(d.id);
    }
    if (d.kind === 'link') {
      const target = this.hitCard(e.clientX, e.clientY);
      this.hover = null;
      this.paintHover();
      if (target && target !== d.src && this.hooks.onLinkDrop) {
        this.hooks.onLinkDrop(d.src, target, d.side);
      }
    }
  }

  onWheel(e) {
    if (e.ctrlKey) return; // Ctrl+滚轮 = 右栏字号，交给 app
    e.preventDefault();
    const r = this.canvasRect;
    const anchor = [e.clientX - r.left, e.clientY - r.top];
    const factor = Math.pow(1.1, e.deltaY > 0 ? -1 : 1);
    this.zoomBy(factor, anchor);
  }

  onDoubleClick(e) {
    if (e.target.closest('.handle') || e.target.closest('.dot')) return;
    const card = e.target.closest('.card');
    if (card) {
      const id = card.dataset.id;
      this.select(id);
      if (this.hooks.onOpen) this.hooks.onOpen(id);
    }
  }

  /** 右键时把落点那张卡片淡淡标一下（只是提示，不是"选中"） */
  markContextCard(id) {
    this._ctxCard = id || null;
    this.paintContextCard();
  }

  clearContextCard() {
    if (!this._ctxCard) return;
    this._ctxCard = null;
    this.paintContextCard();
  }

  paintContextCard() {
    for (const el of this.cardsEl.querySelectorAll('.card')) {
      el.classList.toggle('ctx', el.dataset.id === this._ctxCard);
    }
  }

  /**
   * 右键：**只弹菜单，不改变当前选中的笔记**。
   * 菜单里的操作针对右键的那一张卡片（payload 带 id），选中的笔记和右栏都保持原样。
   */
  onContextMenu(e) {
    e.preventDefault();
    const card = e.target.closest('.card');
    if (card) {
      this.markContextCard(card.dataset.id);
      if (this.hooks.onContext) this.hooks.onContext('node', card.dataset.id, e.clientX, e.clientY);
      return;
    }
    const hit = e.target.closest('path.hit');
    if (hit) {
      this.selectedLink = { src: hit.dataset.hitsrc, dst: hit.dataset.hitdst };
      this.renderEdges();
      if (this.hooks.onContext) {
        this.hooks.onContext('link', this.selectedLink, e.clientX, e.clientY);
      }
      return;
    }
    // 落点被工具条 / 手柄 / 浮层接走了？按坐标找回那张卡片，同样只弹菜单
    const id = this.hitCard(e.clientX, e.clientY);
    if (id) {
      this.markContextCard(id);
      if (this.hooks.onContext) this.hooks.onContext('node', id, e.clientX, e.clientY);
      return;
    }
    const [lx, ly] = this.localPoint(e);
    const [wx, wy] = this.toWorld(lx, ly);
    if (this.hooks.onContext) this.hooks.onContext('canvas', [wx, wy], e.clientX, e.clientY);
  }

  // ---------------------------------------------------------------- 预览线
  showPreviewLine(from, toLocal) {
    if (!this._previewEl) {
      this._previewEl = document.createElement('div');
      this._previewEl.className = 'preview-line';
      this.root.appendChild(this._previewEl);
    }
    const r = this.canvasRect;
    const x1 = from[0], y1 = from[1];
    const x2 = toLocal[0], y2 = toLocal[1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    this._previewEl.style.width = `${len}px`;
    this._previewEl.style.transform = `translate(${x1}px, ${y1}px) rotate(${ang}rad)`;
  }

  hidePreviewLine() {
    if (this._previewEl) { this._previewEl.remove(); this._previewEl = null; }
  }

  /** 拖新连线时，在目标卡片"将要连接的那个接口"上亮一个点 */
  showTargetPort(targetId, srcId) {
    if (!targetId || !this.records.has(targetId) || !this.records.has(srcId)) {
      if (this._portDot) { this._portDot.remove(); this._portDot = null; }
      return;
    }
    const rt = this.records.get(targetId);
    const rs = this.records.get(srcId);
    const [side] = G.facingSides(
      { x: rt.x, y: rt.y, w: rt.w, h: rt.h },
      { x: rs.x, y: rs.y, w: rs.w, h: rs.h },
    );
    const [lx, ly] = this.toScreen(G.anchor({ x: rt.x, y: rt.y, w: rt.w, h: rt.h }, side));
    if (!this._portDot) {
      this._portDot = document.createElement('div');
      this._portDot.className = 'preview-dot';
      this.root.appendChild(this._portDot);
    }
    this._portDot.style.left = `${lx}px`;
    this._portDot.style.top = `${ly}px`;
  }

  hideTargetPort() {
    if (this._portDot) { this._portDot.remove(); this._portDot = null; }
  }

  screenRectOf(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const [sx, sy] = this.toScreen([rec.x, rec.y]);
    return { x: sx, y: sy, w: rec.w * this.zoom, h: rec.h * this.zoom };
  }
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 估算高度用：把 Markdown 压成若干纯文本行 */
function htmlLines(md) {
  const out = [];
  for (const raw of String(md || '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^(>\s*)+/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s*/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\[\[([^\[\]\n]{1,80})\]\]/g, '$1')
      .replace(/(^|\s)#[0-9A-Za-z_\u4e00-\u9fa5-]{1,30}/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (line.trim()) out.push(line);
    if (out.length > 8) break;
  }
  return out;
}
