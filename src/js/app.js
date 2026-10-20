/** 应用外壳：把画板、右栏、菜单、窗口、快捷键、撤销重做装在一起。 */

import { Workspace } from './workspace.js';
import { Canvas } from './canvas.js';
import { NotePane } from './note.js';
import { escapeHtml } from './markdown.js';
import * as geometry from './geometry.js';

const $ = (id) => document.getElementById(id);
const api = window.foryou;

const dom = {
  titlebar: $('titlebar'),
  menubar: $('menubar'), btnCollapse: $('btnCollapse'), btnMax: $('btnMax'), btnClose: $('btnClose'),
  body: $('body'), leftPane: $('leftPane'), rightPane: $('rightPane'), splitter: $('splitter'),
  graphBtn: $('graphBtn'), graphName: $('graphName'),
  searchInput: $('searchInput'), focusBtn: $('focusBtn'),
  canvas: $('canvas'), world: $('world'), cards: $('cards'), edges: $('edges'),
  edgeLayer: $('edgeLayer'), edgeHitLayer: $('edgeHitLayer'), canvasEmpty: $('canvasEmpty'),
  nodeToolbar: $('nodeToolbar'), swatches: $('swatches'),
  toolClear: $('toolClear'), toolEdit: $('toolEdit'), toolNew: $('toolNew'), toolDelete: $('toolDelete'),
  linkToolbar: $('linkToolbar'), linkCurve: $('linkCurve'), linkLine: $('linkLine'),
  linkArrowSolid: $('linkArrowSolid'), linkArrowHollow: $('linkArrowHollow'), linkArrowNone: $('linkArrowNone'),
  linkWidthDown: $('linkWidthDown'), linkWidthVal: $('linkWidthVal'), linkWidthUp: $('linkWidthUp'),
  linkArrowDown: $('linkArrowDown'), linkArrowVal: $('linkArrowVal'), linkArrowUp: $('linkArrowUp'),
  linkRepin: $('linkRepin'), linkRemove: $('linkRemove'),
  btnTidy: $('btnTidy'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), statsLabel: $('statsLabel'),
  btnZoomOut: $('btnZoomOut'), btnZoomReset: $('btnZoomReset'), btnZoomIn: $('btnZoomIn'), btnFit: $('btnFit'),
  noteTitle: $('noteTitle'), noteAccent: $('noteAccent'),
  editor: $('editor'), preview: $('preview'), emptyHint: $('emptyHint'),
  metaSum: $('metaSum'), chips: $('chips'),
  statusLeft: $('statusLeft'), statusRight: $('statusRight'),
  resizeLayer: $('resizeLayer'), popover: $('popover'), submenu: $('submenu'),
};

let ws = null;
let canvas = null;
let pane = null;
let saveTimer = null;
let collapsed = false;
let savedBounds = null;

const COLORS = ['#fb464c', '#e9973f', '#e0de71', '#44cf6e', '#53dfdd', '#a882ff'];

// ---------------------------------------------------------------- 启动
async function boot() {
  const data = await api.load();
  ws = new Workspace(data.state, data.notes);
  ws.onDirty = () => scheduleSave();

  canvas = new Canvas({
    canvas: dom.canvas, world: dom.world, cards: dom.cards,
    edgeLayer: dom.edgeLayer, edgeHitLayer: dom.edgeHitLayer,
    empty: dom.canvasEmpty,
  }, ws, canvasHooks);

  pane = new NotePane({
    root: dom.rightPane,
    title: dom.noteTitle, preview: dom.preview,
    empty: dom.emptyHint, accent: dom.noteAccent,
    chips: dom.chips, sum: dom.metaSum,
  }, ws, paneHooks);

  buildSwatches();
  bindChrome();
  bindShortcuts();
  bindSplitter();
  bindLinkToolbar();
  bindResize();

  canvas.attach();
  pane.setScale(ws.state.zoom || 1);
  showNote(ws.note(ws.state.selected) || lastNoteOfGraph());
  dom.searchInput.value = ws.state.query || '';
  canvas.query = ws.state.query || '';
  setFocusOnly(Boolean(ws.state.focus));
  refreshChrome();
  placeToolbar();
  updateStatus();

  api.backup(ws.state, ws.notes, 'start', true).catch(() => {});
  window.addEventListener('beforeunload', () => {
    try { saveNow(); } catch (_e) { /* ignore */ }
    api.backup(ws.state, ws.notes, 'exit', true).catch(() => {});
  });
  // 主进程关窗口前会来要一次存盘：把分栏比例 / 选中项 / 字号一起写下去
  if (api.win && api.win.onFlushRequest) {
    api.win.onFlushRequest(async () => {
      await saveNow();
      await api.backup(ws.state, ws.notes, 'exit', true).catch(() => {});
    });
  }
  dom.canvas.focus?.();
}

// ---------------------------------------------------------------- 钩子
const canvasHooks = {
  onSelect(id) {
    // 取消选中（点画板空白）时不清空右栏：保留上一篇，方便继续读/改。
    // 只有右栏本来就没显示任何笔记时，才退回空态提示。
    if (id) showNote(ws.note(id));
    else if (!pane.note) showNote(lastNoteOfGraph());
    placeToolbar();
    updateStatus();
  },
  onOpen(id) {
    showNote(ws.note(id));
    pane.focusEditor();
    placeToolbar();
  },
  onBeforeChange() { pushUndo(); },
  onNodeMoved() { updateStatus(); },
  onResize() { updateStatus(); },
  onView() { placeToolbar(); },
  onZoom() { updateStatus(); },
  onLinkDrop(src, dst, side) {
    pushUndo();
    ws.addLink(src, dst);
    // 接口定死：源端用你拖出来的那条边，目标端用"面向源卡片"的那条边
    const a = canvas.records.get(src);
    const b = canvas.records.get(dst);
    if (a && b) {
      const [from, to] = geometry.facingSides(
        { x: a.x, y: a.y, w: a.w, h: a.h },
        { x: b.x, y: b.y, w: b.w, h: b.h },
      );
      ws.setSides(src, dst, { from: side || from, to });
    }
    canvas.render();
    pane.renderMeta();
    updateStatus();
  },
  onLinkSelect(pair, x, y) { showLinkToolbar(pair, x, y); },
  onContext(kind, payload, x, y) { openContextMenu(kind, payload, x, y); },
};

let wordCount = 0;
let statusNoteUntil = 0;

const paneHooks = {
  onWordCount(n) { wordCount = n; updateStatus(); },
  onEdit() {
    scheduleSave();
    clearTimeout(paneHooks._t);
    paneHooks._t = setTimeout(() => {
      canvas.reload();
      pane.renderMeta();
      updateStatus();
      placeToolbar();
    }, 180);
  },
  onRename(id, title) {
    pushUndo();
    ws.renameNote(id, title);
    canvas.reload();
    showNote(ws.note(id));
    updateStatus();
    scheduleSave();
  },
  onLink(title) { followLink(title); },
  onTag(tag) {
    dom.searchInput.value = '#' + tag;
    canvas.query = dom.searchInput.value;
    canvas.render();
    updateStatus();
  },
  onOpenNote(id) { selectNote(id, true); },
  onCreateMissing(title) { createMissing(title); },
  onUnlink(srcId, dstId) {
    pushUndo();
    ws.removeLink(srcId, dstId);
    canvas.render();
    pane.renderMeta();
    updateStatus();
  },
  onUnlinkText(id, title) {
    const note = ws.note(id);
    if (!note) return;
    pushUndo();
    note.content = note.content.replace(`[[${title}]]`, title);
    note.updated = Date.now();
    showNote(note);
    canvas.reload();
    scheduleSave();
  },
  onEscape() { dom.canvas.focus(); },
  onScale() { updateStatus(); scheduleSave(); },
};

// ---------------------------------------------------------------- 选择 / 打开
/** 记住"右栏上次看的那篇"（每张图各记一份） */
function rememberNote(note) {
  if (!note) return;
  const g = ws.graph();
  if (g && g.last_note !== note.id) {
    g.last_note = note.id;
    ws.markDirty(null);
  }
}

/** 这张图上一次看的笔记（用来在画板没选中任何东西时继续显示） */
function lastNoteOfGraph() {
  const g = ws.graph();
  const note = g && g.last_note ? ws.note(g.last_note) : null;
  return note && note.graph === ws.graphId ? note : null;
}

function showNote(note) {
  rememberNote(note);
  pane.show(note || null);
}

function selectNote(id, focus = false) {
  if (!id) return;
  canvas.select(id);
  // 没有编辑/预览之分：右栏一直是可编辑的富文本
  showNote(ws.note(id));
  placeToolbar();
  updateStatus();
  if (focus) pane.focusEditor();
}

function followLink(title) {
  const note = ws.findTitle(title);
  if (note) selectNote(note.id, true);
  else createMissing(title);
}

function createMissing(title) {
  const existing = ws.findTitle(title);
  if (existing) { selectNote(existing.id, true); return; }
  pushUndo();
  const note = ws.createNote({ title });
  const src = ws.note(ws.state.selected);
  const anchor = canvas.records.get(ws.state.selected);
  if (anchor) placeRecord(note.id, anchor.x + anchor.w + 60, anchor.y + 30);
  if (src) ws.addLink(src.id, note.id);
  canvas.rebuild();
  selectNote(note.id, true);
  pane.focusEditor();
  updateStatus();
}

function placeRecord(id, x, y) {
  const rec = canvas.records.get(id);
  if (!rec) return;
  rec.x = Math.round(x); rec.y = Math.round(y);
  canvas.persistPositions();
}

/** 新笔记的记录要先 rebuild 才存在；这里统一"建出来 → 摆到指定世界坐标" */
function placeNote(noteId, x, y) {
  const rec = canvas.records.get(noteId);
  if (!rec) return false;
  rec.x = Math.round(x);
  rec.y = Math.round(y);
  canvas.updateCardPosition(noteId);
  canvas.renderEdges();
  canvas.persistPositions();
  return true;
}

function newNote(atWorld) {
  pushUndo();
  const note = ws.createNote({});
  canvas.rebuild({ layout: false });      // 先把这张卡片的记录建出来（不要顺手重排/缩放）
  const rec = canvas.records.get(note.id);
  if (!rec) return;
  // 位置优先级：右键点的地方 > 鼠标现在指的地方 > 选中卡片下方 > 视口中心
  const point = atWorld || canvas.pointerWorld();
  let x;
  let y;
  if (point) {
    x = point[0] - rec.w / 2;             // 以鼠标位置为中心，而不是硬编码偏移
    y = point[1] - rec.h / 2;
  } else {
    const sel = canvas.records.get(ws.state.selected);
    if (sel) {
      x = sel.x + 40;
      y = sel.y + sel.h + 50;
    } else {
      const center = canvas.centerWorld();
      x = center[0] - rec.w / 2;
      y = center[1] - rec.h / 2;
    }
  }
  placeNote(note.id, x, y);
  selectNote(note.id, false);
  pane.focusTitle();
  updateStatus();
}

function branchFrom(id) {
  const src = ws.note(id);
  if (!src) return;
  pushUndo();
  const note = ws.createNote({ title: ws.uniqueTitle('新笔记') });
  ws.addLink(id, note.id);
  canvas.rebuild({ layout: false });      // 记录建出来之后才有 rec
  const rec = canvas.records.get(id);
  if (rec) placeNote(note.id, rec.x + rec.w + 70, rec.y + 30);
  selectNote(note.id, true);
  updateStatus();
}

async function deleteNote(id) {
  const note = ws.note(id);
  if (!note) return;
  const ok = await api.confirm('删除笔记',
    `确定删除「${note.title || '未命名'}」吗？\n别处指向它的画布连接会一起清掉。`);
  if (!ok) return;
  pushUndo();
  ws.deleteNote(id);
  const rest = ws.notesOf();
  canvas.rebuild();
  if (rest.length) selectNote(rest[0].id, false);
  else { canvas.selected = null; pane.show(null); }
  placeToolbar();
  updateStatus();
}

// ---------------------------------------------------------------- 保存 / 撤销
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!ws) return;
  pane.flush();
  try { await api.saveAll(ws.state, ws.notes); } catch (_e) { /* ignore */ }
}

function pushUndo() {
  ws.pushUndo();
  updateUndoButtons();
}

function undo() {
  if (!ws.undoStack.length) return;
  ws.undo();
  afterHistory();
}

function redo() {
  if (!ws.redoStack.length) return;
  ws.redo();
  afterHistory();
}

function afterHistory() {
  canvas.attach();
  showNote(ws.note(ws.state.selected) || lastNoteOfGraph());
  dom.searchInput.value = ws.state.query || '';
  canvas.query = ws.state.query || '';
  setFocusOnly(Boolean(ws.state.focus));
  refreshChrome();
  placeToolbar();
  updateStatus();
  scheduleSave();
}

function updateUndoButtons() {
  dom.btnUndo.style.opacity = ws.undoStack.length ? '1' : '.4';
  dom.btnRedo.style.opacity = ws.redoStack.length ? '1' : '.4';
}

// ---------------------------------------------------------------- 界面刷新
function refreshChrome() {
  const g = ws.graph();
  dom.graphName.textContent = g.name;
  updateUndoButtons();
  updateStatus();
}

function updateStatus() {
  if (!ws) return;
  const count = ws.notesOf().length;
  const links = ws.linkCount();
  dom.statsLabel.textContent = `${count} 篇 · ${links} 链接`;
  // 左下不再显示图名 / 孤岛提示；这里只负责把过期的临时提示清掉
  if (!statusNoteUntil || Date.now() > statusNoteUntil) dom.statusLeft.textContent = '';
  const words = Number(wordCount || 0).toLocaleString('en-US');
  dom.statusRight.textContent = `字号 ${Math.round(pane.scale * 100)}% · ${words} 字`;
  const z = Math.round(canvas.zoom * 100);
  dom.btnZoomReset.textContent = `${z}%`;
  dom.canvasEmpty.hidden = !(ws.notesOf().length === 0 && !canvas.query);
}

/** 操作结果的临时提示（几秒后自动消失） */
function flashStatus(text, ms = 4000) {
  dom.statusLeft.textContent = text;
  statusNoteUntil = Date.now() + ms;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => {
    statusNoteUntil = 0;
    dom.statusLeft.textContent = '';
  }, ms);
}

function setFocusOnly(on) {
  ws.state.focus = Boolean(on);
  canvas.focusOnly = Boolean(on);
  dom.focusBtn.classList.toggle('active', Boolean(on));
  canvas.render();
  scheduleSave();
}

// ---------------------------------------------------------------- 节点工具条
function buildSwatches() {
  dom.swatches.innerHTML = COLORS.map((c) =>
    `<button class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  dom.swatches.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (btn) setCardColor(btn.dataset.color);
  });
  dom.toolClear.addEventListener('click', () => setCardColor(''));
  dom.toolEdit.addEventListener('click', () => { if (canvas.selected) pane.focusEditor(); });
  dom.toolNew.addEventListener('click', () => { if (canvas.selected) branchFrom(canvas.selected); });
  dom.toolDelete.addEventListener('click', () => { if (canvas.selected) deleteNote(canvas.selected); });
}

function setCardColor(color) {
  const note = ws.note(canvas.selected);
  if (!note || (note.color || '') === color) return;
  pushUndo();
  note.color = color;
  note.updated = Date.now();
  canvas.render();
  showNote(note);
  syncSwatches();
  scheduleSave();
}

function syncSwatches() {
  const note = ws.note(canvas.selected);
  const current = note ? note.color : '';
  for (const btn of dom.swatches.querySelectorAll('.swatch')) {
    btn.classList.toggle('active', btn.dataset.color === current);
  }
}

function placeToolbar() {
  // 连线工具栏跟着"选中的那条线"走，没选就让位
  if (!canvas || !canvas.selectedLink) hideLinkToolbar();
  else if (linkToolbarPair) syncLinkToolbar();
  if (!canvas || !canvas.selected) { dom.nodeToolbar.hidden = true; return; }
  const rect = canvas.screenRectOf(canvas.selected);
  if (!rect) { dom.nodeToolbar.hidden = true; return; }
  dom.nodeToolbar.hidden = false;
  const w = dom.nodeToolbar.offsetWidth;
  const h = dom.nodeToolbar.offsetHeight;
  const cw = dom.canvas.clientWidth;
  const ch = dom.canvas.clientHeight;
  let x = rect.x + rect.w / 2 - w / 2;
  let y = rect.y - h - 8;
  if (y < 4) y = rect.y + rect.h + 8;
  x = Math.max(6, Math.min(cw - w - 6, x));
  y = Math.max(4, Math.min(ch - h - 4, y));
  dom.nodeToolbar.style.left = `${x}px`;
  dom.nodeToolbar.style.top = `${y}px`;
  syncSwatches();
}

// ---------------------------------------------------------------- 菜单
function openPopover(items, x, y) {
  const el = dom.popover;
  el.innerHTML = items.map((it, idx) => {
    if (it.sep) return '<div class="sep"></div>';
    const cls = ['item', it.disabled ? 'disabled' : '', it.checked ? 'checked' : ''].filter(Boolean).join(' ');
    const accel = it.accel ? `<span class="accel">${escapeHtml(it.accel)}</span>` : '';
    const label = (it.checked ? '✓ ' : '') + escapeHtml(it.label);
    // 按下标派发：条目可能重名（两张图同名），也可能都没有 value。
    // 以前按 data-value 匹配 → 永远命中第一项：点第二张图跳回第一张、点"退出"变成"新建笔记"。
    return `<div class="${cls}" data-index="${idx}">${label}${accel}</div>`;
  }).join('');
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x))}px`;
  el.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, y))}px`;
  el._items = items;
  el.onclick = (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    const item = (el._items || [])[Number(row.dataset.index)];
    if (!item || item.disabled) return;
    closePopover();
    if (item.action) item.action();
  };
  // 某一项自己带 context 的（比如图列表里的"这张图"）→ 右键只针对那一项
  el.oncontextmenu = (e) => {
    const row = e.target.closest && e.target.closest('.item');
    if (!row) return;
    const item = (el._items || [])[Number(row.dataset.index)];
    if (!item || !item.context) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = row.getBoundingClientRect();
    openSubMenu(item.context, Math.round(rect.right + 6), Math.round(rect.top));
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', closeOnOutside, { capture: true });
  }, 0);
}

function closeOnOutside(e) {
  if (dom.popover.contains(e.target)) return;
  if (dom.submenu && !dom.submenu.hidden && dom.submenu.contains(e.target)) return;
  closePopover();
}

function closePopover() {
  dom.popover.hidden = true;
  dom.popover.onclick = null;
  window.removeEventListener('pointerdown', closeOnOutside, { capture: true });
  closeSubMenu();
}

/** 右键某一项时在它旁边弹出的二级菜单；主菜单保持不动 */
function closeSubMenu() {
  if (!dom.submenu) return;
  dom.submenu.hidden = true;
  dom.submenu.onclick = null;
  window.removeEventListener('pointerdown', closeSubOnOutside, { capture: true });
}

function closeSubOnOutside(e) {
  if (dom.submenu && dom.submenu.contains(e.target)) return;
  closeSubMenu();
}

function openSubMenu(items, x, y) {
  const el = dom.submenu;
  if (!el) return;
  el.innerHTML = items.map((it, idx) => {
    if (it.sep) return '<div class="sep"></div>';
    const cls = ['item', it.disabled ? 'disabled' : '', it.checked ? 'checked' : ''].filter(Boolean).join(' ');
    const accel = it.accel ? `<span class="accel">${escapeHtml(it.accel)}</span>` : '';
    const label = (it.checked ? '✓ ' : '') + escapeHtml(it.label);
    return `<div class="${cls}" data-index="${idx}">${label}${accel}</div>`;
  }).join('');
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x))}px`;
  el.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, y))}px`;
  el._items = items;
  el.onclick = (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    const item = (el._items || [])[Number(row.dataset.index)];
    if (!item || item.disabled) return;
    closeSubMenu();
    closePopover();
    if (item.action) item.action();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', closeSubOnOutside, { once: true, capture: true });
  }, 0);
}

function menuSpec(name) {
  if (name === 'file') {
    return [
      { label: '新建笔记', accel: 'Ctrl+N', action: () => newNote() },
      { label: '新建图', accel: 'Ctrl+Shift+N', action: () => newGraph() },
      { label: '切换到下一张图', accel: 'Ctrl+Tab', action: () => nextGraph() },
      { sep: true },
      { label: '立即保存', accel: 'Ctrl+S', action: () => saveNow() },
      { label: '立即备份一份', action: () => backupNow() },
      { label: '清理没被引用的图片…', action: () => cleanupImages() },
      { sep: true },
      { label: '打开数据文件夹', action: () => api.openFolder('data') },
      { label: '打开备份文件夹', action: () => api.openFolder('backups') },
      { sep: true },
      { label: '重启', action: () => api.win.relaunch() },
      { label: '退出', action: () => api.win.close() },
    ];
  }
  if (name === 'view') {
    return [
      { label: '笔记字号放大', accel: 'Ctrl+＋', action: () => zoomNote(1.1) },
      { label: '笔记字号缩小', accel: 'Ctrl+－', action: () => zoomNote(1 / 1.1) },
      { label: '笔记字号恢复默认', accel: 'Ctrl+0', action: () => zoomNote(0) },
      { sep: true },
      { label: '整理布局', action: () => tidy() },
      { label: '重排图谱（随机）', accel: 'F5', action: () => relayout() },
      { label: '适应窗口', accel: 'F', action: () => canvas.fit() },
      { sep: true },
      { label: '接口全部重新对准', action: () => repinAll() },
      { label: '只看与当前笔记相连', checked: canvas.focusOnly, action: () => setFocusOnly(!canvas.focusOnly) },
      { label: '收起窗口', action: () => toggleCollapse() },
    ];
  }
  return [
    { label: '使用说明', accel: 'F1', action: () => showHelp() },
    { label: '关于 For You Notes', action: () => showAbout() },
  ];
}

function openContextMenu(kind, payload, x, y) {
  if (kind === 'node') {
    openPopover([
      { label: '重命名…', action: () => { selectNote(payload, false); pane.focusTitle(); } },
      { label: '从这篇新建并链接', action: () => branchFrom(payload) },
      { label: '编辑这篇（焦点交给笔记）', action: () => { selectNote(payload, true); } },
      { sep: true },
      { label: '删除这篇笔记', action: () => deleteNote(payload) },
    ], x, y);
    return;
  }
  if (kind === 'link') {
    const note = ws.note(payload.src);
    const link = note && (note.links || []).find((l) => l.id === payload.dst);
    openPopover([
      { label: '打开目标笔记', action: () => selectNote(payload.dst, true) },
      { label: `切成${link && link.shape === 'curve' ? '直线' : '曲线'}`, action: () => setLinkShape(payload) },
      { label: '箭头：实心', action: () => setLinkArrow(payload, 'solid') },
      { label: '箭头：空心', action: () => setLinkArrow(payload, 'hollow') },
      { label: '箭头：无', action: () => setLinkArrow(payload, 'none') },
      { sep: true },
      { label: '接口重新对准当前位置', action: () => repinLink(payload) },
      { label: '删除这条连接', action: () => removeLink(payload) },
      { label: '复制链接文字', action: () => copyLinkText(payload) },
    ], x, y);
    return;
  }
  openPopover([
    { label: '在这里新建笔记', action: () => newNote(payload) },
    { label: '整理布局', action: () => tidy() },
    { label: '适应窗口', action: () => canvas.fit() },
  ], x, y);
}


// ---------------------------------------------------------------- 连线工具栏
let linkToolbarPair = null;

function showLinkToolbar(pair) {
  linkToolbarPair = pair;
  if (!dom.linkToolbar) return;
  dom.linkToolbar.hidden = false;
  syncLinkToolbar();
}

function hideLinkToolbar() {
  linkToolbarPair = null;
  if (dom.linkToolbar) dom.linkToolbar.hidden = true;
}

function currentLink() {
  if (!linkToolbarPair) return null;
  const note = ws.note(linkToolbarPair.src);
  return (note && (note.links || []).find((l) => l.id === linkToolbarPair.dst)) || null;
}

function syncLinkToolbar() {
  if (!dom.linkToolbar || dom.linkToolbar.hidden) return;
  const link = currentLink();
  const shape = link ? link.shape : 'line';
  const arrow = link ? link.arrow : 'solid';
  dom.linkCurve.classList.toggle('active', shape === 'curve');
  dom.linkLine.classList.toggle('active', shape !== 'curve');
  dom.linkArrowSolid.classList.toggle('active', arrow !== 'hollow' && arrow !== 'none');
  dom.linkArrowHollow.classList.toggle('active', arrow === 'hollow');
  dom.linkArrowNone.classList.toggle('active', arrow === 'none');
  dom.linkWidthVal.textContent = String(link ? (Number(link.width) || 2) : 2);
  dom.linkArrowVal.textContent = String(link ? (Number(link.arrowSize) || 6) : 6);
  placeLinkToolbar();
}

function placeLinkToolbar() {
  const el = dom.linkToolbar;
  if (!el || el.hidden || !linkToolbarPair) return;
  const a = canvas.records.get(linkToolbarPair.src);
  const b = canvas.records.get(linkToolbarPair.dst);
  if (!a || !b) return;
  // 用画布内部坐标：工具条就挂在 .canvas 里，和卡片的坐标体系一致
  const ma = canvas.toScreen([a.x + a.w / 2, a.y + a.h / 2]);
  const mb = canvas.toScreen([b.x + b.w / 2, b.y + b.h / 2]);
  const midX = (ma[0] + mb[0]) / 2;
  const midY = (ma[1] + mb[1]) / 2;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const cw = dom.canvas.clientWidth;
  const ch = dom.canvas.clientHeight;
  // 永远放在连线中点的上方；上方放不下再退到下方
  let top = midY - h - 14;
  if (top < 6) top = midY + 16;
  el.style.left = Math.max(6, Math.min(cw - w - 6, midX - w / 2)) + 'px';
  el.style.top = Math.max(6, Math.min(ch - h - 6, top)) + 'px';
}

/** 改这条线的样式（粗细 / 箭头大小也走这里） */
function bumpLinkStyle(patch) {
  if (!linkToolbarPair) return;
  pushUndo();
  ensureLink(linkToolbarPair);
  ws.setLinkStyle(linkToolbarPair.src, linkToolbarPair.dst, patch);
  canvas.renderEdges();
  syncLinkToolbar();
  scheduleSave();
}

function bindLinkToolbar() {
  if (!dom.linkToolbar) return;
  dom.linkCurve.addEventListener('click', () => bumpLinkStyle({ shape: 'curve' }));
  dom.linkLine.addEventListener('click', () => bumpLinkStyle({ shape: 'line' }));
  dom.linkArrowSolid.addEventListener('click', () => bumpLinkStyle({ arrow: 'solid' }));
  dom.linkArrowHollow.addEventListener('click', () => bumpLinkStyle({ arrow: 'hollow' }));
  dom.linkArrowNone.addEventListener('click', () => bumpLinkStyle({ arrow: 'none' }));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const step = (field, delta, lo, hi) => {
    const link = currentLink();
    const now = link ? (Number(link[field]) || (field === 'width' ? 2 : 6)) : (field === 'width' ? 2 : 6);
    bumpLinkStyle({ [field]: clamp(now + delta, lo, hi) });
  };
  dom.linkWidthDown.addEventListener('click', () => step('width', -1, 1, 8));
  dom.linkWidthUp.addEventListener('click', () => step('width', 1, 1, 8));
  dom.linkArrowDown.addEventListener('click', () => step('arrowSize', -2, 4, 18));
  dom.linkArrowUp.addEventListener('click', () => step('arrowSize', 2, 4, 18));
  dom.linkRepin.addEventListener('click', () => { if (linkToolbarPair) repinLink(linkToolbarPair); });
  dom.linkRemove.addEventListener('click', () => {
    if (!linkToolbarPair) return;
    const pair = linkToolbarPair;
    hideLinkToolbar();
    removeLink(pair);
  });
}

function openLinkMenu(pair, x, y) {
  const note = ws.note(pair.src);
  const link = note && (note.links || []).find((l) => l.id === pair.dst);
  openPopover([
    { label: '曲线', checked: Boolean(link && link.shape === 'curve'), action: () => setLinkShape(pair, 'curve') },
    { label: '直线', checked: Boolean(link && link.shape === 'line'), action: () => setLinkShape(pair, 'line') },
    { sep: true },
    { label: '实心箭头', checked: !link || link.arrow !== 'hollow' && link.arrow !== 'none', action: () => setLinkArrow(pair, 'solid') },
    { label: '空心箭头', checked: Boolean(link && link.arrow === 'hollow'), action: () => setLinkArrow(pair, 'hollow') },
    { label: '无箭头', checked: Boolean(link && link.arrow === 'none'), action: () => setLinkArrow(pair, 'none') },
    { sep: true },
    { label: '接口重新对准当前位置', action: () => repinLink(pair) },
    { label: '断开这条连接', action: () => removeLink(pair) },
  ], x, y);
}

function ensureLink(pair) {
  const note = ws.note(pair.src);
  if (!note) return null;
  let link = (note.links || []).find((l) => l.id === pair.dst);
  if (!link) {
    ws.addLink(pair.src, pair.dst);
    link = (ws.note(pair.src).links || []).find((l) => l.id === pair.dst);
  }
  return link;
}

function setLinkShape(pair, shape) {
  pushUndo();
  const link = ensureLink(pair);
  const next = shape || (link && link.shape === 'line' ? 'curve' : 'line');
  ws.setLinkStyle(pair.src, pair.dst, { shape: next });
  canvas.renderEdges();
  pane.renderMeta();
  scheduleSave();
}

function setLinkArrow(pair, arrow) {
  pushUndo();
  ensureLink(pair);
  ws.setLinkStyle(pair.src, pair.dst, { arrow });
  canvas.renderEdges();
  pane.renderMeta();
  scheduleSave();
}

function removeLink(pair) {
  pushUndo();
  ws.removeLink(pair.src, pair.dst);
  ws.clearSides(pair.src, pair.dst);
  canvas.selectedLink = null;
  canvas.render();
  pane.renderMeta();
  updateStatus();
}

/** 把这条线两端的接口重新对准当前位置（接口平时是定死的，这里手动解冻一次） */
function repinLink(pair) {
  pushUndo();
  ws.clearSides(pair.src, pair.dst);
  canvas.renderEdges();
  scheduleSave();
}

/** 整张图的接口全部重新对准当前位置（整理布局之后好用） */
function repinAll() {
  pushUndo();
  ws.clearAllSides();
  canvas.renderEdges();
  scheduleSave();
  flashStatus('已按当前位置重新对准全部接口');
  setTimeout(updateStatus, 3000);
}

function copyLinkText(pair) {
  const target = ws.note(pair.dst);
  if (target) navigator.clipboard.writeText(`[[${target.title || ''}]]`).catch(() => {});
}

function openGraphMenu(x, y) {
  // 每一项都是一张图；右键某一项只针对那张图（重命名 / 删除）
  const items = ws.graphs().map((g) => ({
    label: g.name,
    graphId: g.id,
    checked: g.id === ws.graphId,
    action: () => switchGraph(g.id),
    context: [
      { label: '重命名这张图…', action: () => inlineRenameGraph(g.id) },
      { label: '删除这张图…', action: () => deleteGraph(g.id) },
    ],
  }));
  items.push({ sep: true });
  items.push({ label: '新建图  Ctrl+Shift+N', action: () => newGraph() });
  const r = dom.graphBtn.getBoundingClientRect();
  openPopover(items, r.left, r.bottom + 4);
}

// ---------------------------------------------------------------- 图
function newGraph() {
  pushUndo();
  ws.addGraph();
  canvas.attach();
  pane.show(null);
  refreshChrome();
  placeToolbar();
  updateStatus();
}

function switchGraph(gid) {
  saveNow();
  canvas.attach(gid);
  showNote(ws.note(ws.state.selected) || lastNoteOfGraph());
  refreshChrome();
  placeToolbar();
  updateStatus();
}

function nextGraph() {
  if (ws.graphs().length < 2) return;
  const ids = ws.graphs().map((g) => g.id);
  const i = ids.indexOf(ws.graphId);
  switchGraph(ids[(i + 1) % ids.length]);
}

async function renameGraph(gid) {
  const g = (gid && ws.graphs().find((x) => x.id === gid)) || ws.graph();
  if (!g) return;
  const name = await askText('重命名图', g.name);
  if (name && name.trim()) {
    pushUndo();
    ws.renameGraph(g.id, name.trim());
    refreshChrome();
    scheduleSave();
  }
}

/** 原地重命名某张图。
 *  anchor 给了就直接盖在它上面（比如图名按钮），否则盖在图列表对应的那一行上。 */
function inlineRenameGraph(gid, { anchor = null } = {}) {
  const g = (gid && ws.graphs().find((x) => x.id === gid)) || ws.graph();
  if (!g) return;

  const placeOver = (rect) => {
    const input = document.createElement('input');
    input.className = 'inline-edit';
    input.value = g.name;
    input.spellcheck = false;
    input.style.left = rect.left + 'px';
    input.style.top = rect.top + 'px';
    input.style.width = Math.max(120, rect.width) + 'px';
    input.style.height = rect.height + 'px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (commit && value && value !== g.name) {
        pushUndo();
        ws.renameGraph(g.id, value);
        refreshChrome();
        scheduleSave();
      }
      closePopover();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  };

  // ① 直接改图名按钮本身（右键按钮 → 重命名）
  if (anchor) {
    placeOver(anchor.getBoundingClientRect());
    return;
  }

  // ② 改列表里的那一行
  const overRow = () => {
    const pop = dom.popover;
    if (!pop || pop.hidden) return false;
    const row = [...pop.querySelectorAll('.item')].find((el) => {
      const item = (pop._items || [])[Number(el.dataset.index)];
      return item && item.graphId === g.id;
    });
    if (!row) return false;
    placeOver(row.getBoundingClientRect());
    return true;
  };

  if (!overRow()) {
    const r = dom.graphBtn.getBoundingClientRect();
    openGraphMenu(r.left, r.bottom + 4);
    setTimeout(overRow, 0);
  }
}

async function deleteGraph(gid) {
  if (ws.graphs().length <= 1) {
    await modal('删除图', '<p style="color:var(--muted)">至少要保留一张图。</p>');
    return;
  }
  const g = (gid && ws.graphs().find((x) => x.id === gid)) || ws.graph();
  if (!g) return;
  const ok = await api.confirm('删除图',
    `确定删除「${g.name}」吗？\n这张图里的笔记会一起删掉，且不可恢复。`);
  if (!ok) return;
  pushUndo();
  ws.deleteGraph(g.id);
  canvas.attach();
  showNote(ws.note(ws.state.selected) || lastNoteOfGraph());
  refreshChrome();
  placeToolbar();
  updateStatus();
}

// ---------------------------------------------------------------- 视图命令
function tidy() {
  if (!canvas.records.size) return;
  pushUndo();
  canvas.arrange(false);
  updateStatus();
  scheduleSave();
}

function relayout() {
  if (!canvas.records.size) return;
  pushUndo();
  canvas.arrange(true);
  updateStatus();
  scheduleSave();
}

function zoomNote(factor) {
  const next = factor === 0 ? 1 : pane.scale * factor;
  pane.setScale(next);
  ws.state.zoom = pane.scale;
  updateStatus();
  scheduleSave();
}

async function backupNow() {
  await saveNow();
  const file = await api.backup(ws.state, ws.notes, 'manual', true);
  flashStatus(file ? `已备份整库快照：${file.split('\\').pop()}` : '（无变化）');
  setTimeout(updateStatus, 4000);
}

/** 删掉没有被任何笔记引用的图片（图片存在库里，界面不显示路径） */
async function cleanupImages() {
  await saveNow();
  const stats = await api.images.stats();
  if (!stats.count) {
    flashStatus('库里还没有图片');
    setTimeout(updateStatus, 3000);
    return;
  }
  const ok = await api.confirm('清理图片',
    `库里有 ${stats.count} 张图片。\n删掉没有被任何笔记引用的那些吗？（不影响笔记正文）`);
  if (!ok) return;
  const res = await api.images.cleanup(ws.notes);
  flashStatus(`图片清理：删除 ${res.removed} 张，保留 ${res.kept} 张`);
  setTimeout(updateStatus, 4000);
}

// ---------------------------------------------------------------- 弹窗
function modal(title, bodyHtml, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <header>${escapeHtml(title)}</header>
        <div class="modal-body">${bodyHtml}</div>
        <footer></footer>
      </div>`;
    const footer = overlay.querySelector('footer');
    if (options.input !== undefined) {
      const input = document.createElement('input');
      input.className = 'modal-input';
      input.value = options.input || '';
      overlay.querySelector('.modal-body').appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      options._input = input;
    }
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.className = 'modal-btn';
    const ok = document.createElement('button');
    ok.textContent = '确定';
    ok.className = 'modal-btn primary';
    footer.append(cancel, ok);
    const close = (value) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(options._input ? options._input.value : true);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') close(options._input ? options._input.value : true);
    });
    document.body.appendChild(overlay);
    setTimeout(() => (options._input || ok).focus(), 0);
  });
}

const askText = (title, value) => modal(title, '<p style="color:var(--muted);margin:0 0 8px">新的名字：</p>',
  { input: value });

function showHelp() {
  modal('使用说明', `
    <div class="help">
      <h3>窗口</h3>
      <p>拖标题栏移动；双击标题栏最大化；拖四边 / 四角缩放；
         ─ 最小化、▢ 最大化 / 还原、✕ 关闭。文件菜单里还有「重启」。</p>

      <h3>左栏 · 知识体系图</h3>
      <ul>
        <li>单击卡片：选中；双击卡片：打开并把光标交给右栏。</li>
        <li>拖卡片：移动，靠近别的卡片会吸附并显示参考线；拖四角方块：改尺寸。</li>
        <li>鼠标移到卡片上，四边中点出现灰色圆点，拖到另一张卡片即成连线。</li>
        <li>点连线：选中并弹出样式条（曲线 / 直线、实心 / 空心 / 无箭头、断开）。</li>
        <li>拖空白：平移；滚轮：以光标为中心缩放；Ctrl+滚轮：只改右栏字号。</li>
        <li>右键卡片 / 连线 / 空白：各自的上下文菜单（重命名、删除、改样式等）。</li>
        <li>左上角图名：左键点开切换图、新建图；<b>右键图名</b>可原地改名或删除这张图。</li>
      </ul>

      <h3>右栏 · 笔记</h3>
      <ul>
        <li><b>单击正文任意一段</b>，光标就落在那里，边写边排版 —— 没有"编辑 / 预览"开关。</li>
        <li>回车在光标处拆成两段；Shift+回车在段内换行；段首按退格并进上一段。</li>
        <li>空段落里打 <b>/</b> 选块类型：正文 / 标题 1-3 / 无序 / 有序 / 待办 / 引用 / 代码 / 公式 / 分割线。</li>
        <li>也可以直接打 <b># </b>、<b>- </b>、<b>1. </b>、<b>[] </b>、<b>&gt; </b>、<b>\`\`\`</b>，会自动变成对应块。</li>
        <li>列表里 <b>Tab</b> 缩进、<b>Shift+Tab</b> 反缩进；块尾按 ↓ 或块首按 ↑ 可以跨段移动光标。</li>
        <li>正文写 [[另一篇标题]] 建立链接：蓝色可点，橙色说明还没有这篇，点一下即创建。</li>
        <li>Ctrl+V 直接粘图片（或把图片拖进来），图存进库里，正文只留 ![[文件名]]。</li>
        <li>#标签 用来归类，点标签可以按标签筛选画布。</li>
        <li>右下角状态栏显示当前字号和这篇笔记的字数。</li>
      </ul>

      <h3>快捷键</h3>
      <p>Ctrl+N 新建笔记 · Ctrl+Shift+N 新建图 · Ctrl+Tab 切图 · Ctrl+S 保存<br>
         Ctrl+Z 撤销 · Ctrl+Y 重做（在正文里撤的是正文内容）<br>
         Ctrl+滚轮 字号 · Ctrl+0 字号复位 · F5 重排 · F 适应窗口 · F1 使用说明</p>
    </div>`);
}

function showAbout() {
  modal('关于 For You Notes', `
    <div class="help">
      <p><strong>For You Notes 1.0.0</strong></p>
      <p>一个装在自己电脑上的双栏笔记程序：左栏是知识体系图，右栏是选中笔记的内容。
         笔记、图片、备份都存在本机，<b>不联网也能用</b>，也不会上传任何内容。</p>
      <p>数据放在 %LOCALAPPDATA%\\ForYouNotes\\data：一篇笔记一个 JSON 文件，图片在 data\\image，
         备份在 data\\backups。</p>
      <p>退出时自动保存，关窗口前还会再存一次；分栏比例、字号、上次看的那篇笔记都会记住。</p>
    </div>`);
}

// ---------------------------------------------------------------- 窗口
function bindChrome() {
  dom.menubar.addEventListener('click', (e) => {
    const btn = e.target.closest('.menubar-btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    openPopover(menuSpec(btn.dataset.menu), r.left, r.bottom + 4);
  });

  dom.btnClose.addEventListener('click', () => api.win.close());
  dom.btnMax.addEventListener('click', async () => {
    const max = await api.win.maximize();
    dom.btnMax.textContent = max ? '❐' : '▢';
    setTimeout(placeToolbar, 60);
  });
  dom.btnCollapse.addEventListener('click', () => api.win.minimize());

  dom.graphBtn.addEventListener('click', () => {
    const r = dom.graphBtn.getBoundingClientRect();
    openGraphMenu(r.left, r.bottom + 4);
  });
  // 右键这张图的按钮 → 只给"重命名 / 删除"这两件事
  dom.graphBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openPopover([
      { label: '重命名这张图…', action: () => inlineRenameGraph(ws.graphId, { anchor: dom.graphBtn }) },
      { label: '删除这张图…', action: () => deleteGraph() },
    ], e.clientX, e.clientY);
  });

  dom.searchInput.addEventListener('input', () => {
    canvas.query = dom.searchInput.value;
    ws.state.query = dom.searchInput.value;
    canvas.render();
    updateStatus();
    scheduleSave();
  });
  dom.focusBtn.addEventListener('click', () => setFocusOnly(!canvas.focusOnly));

  dom.btnTidy.addEventListener('click', () => tidy());
  dom.btnUndo.addEventListener('click', () => undo());
  dom.btnRedo.addEventListener('click', () => redo());
  dom.btnZoomOut.addEventListener('click', () => canvas.zoomBy(1 / 1.15));
  dom.btnZoomIn.addEventListener('click', () => canvas.zoomBy(1.15));
  dom.btnZoomReset.addEventListener('click', () => canvas.setZoom(1));
  dom.btnFit.addEventListener('click', () => canvas.fit());

  // 标题栏拖动 / 双击最大化
  let drag = null;
  dom.titlebar.addEventListener('pointerdown', async (e) => {
    if (e.target.closest('button')) return;
    const bounds = await api.win.bounds();
    drag = { sx: e.screenX, sy: e.screenY, bounds };
    dom.titlebar.setPointerCapture?.(e.pointerId);
  });
  dom.titlebar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    api.win.setBounds({ x: drag.bounds.x + dx, y: drag.bounds.y + dy,
      width: drag.bounds.width, height: drag.bounds.height });
  });
  dom.titlebar.addEventListener('pointerup', () => { drag = null; });
  dom.titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    dom.btnMax.click();
  });

  window.addEventListener('resize', () => { placeToolbar(); });

  api.win.onMaximized((max) => {
    dom.btnMax.textContent = max ? '❐' : '▢';
    setTimeout(placeToolbar, 60);
  });

  api.win.isMaximized().then((max) => { dom.btnMax.textContent = max ? '❐' : '▢'; });
}

async function toggleCollapse() {
  if (!collapsed) {
    savedBounds = await api.win.bounds();
    const work = { width: window.screen.availWidth, height: window.screen.availHeight };
    // 先把最小尺寸放开，否则 880x560 的下限会把"收起"顶回去
    if (api.win.minSize) await api.win.minSize(120, 40);
    await api.win.setBounds({
      x: work.width - 380, y: work.height - 60, width: 360, height: 44, force: true,
    });
    collapsed = true;
  } else {
    if (savedBounds) await api.win.setBounds(savedBounds);
    if (api.win.minSize) await api.win.minSize(880, 560);
    collapsed = false;
  }
}

function bindResize() {
  let drag = null;
  for (const el of dom.resizeLayer.querySelectorAll('[data-edge]')) {
    el.addEventListener('pointerdown', async (e) => {
      const bounds = await api.win.bounds();
      drag = { edge: el.dataset.edge, sx: e.screenX, sy: e.screenY, bounds };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      const b = { ...drag.bounds };
      const minW = 880, minH = 560;
      if (drag.edge.includes('e')) b.width = Math.max(minW, drag.bounds.width + dx);
      if (drag.edge.includes('s')) b.height = Math.max(minH, drag.bounds.height + dy);
      if (drag.edge.includes('w')) {
        b.width = Math.max(minW, drag.bounds.width - dx);
        b.x = drag.bounds.x + (drag.bounds.width - b.width);
      }
      if (drag.edge.includes('n')) {
        b.height = Math.max(minH, drag.bounds.height - dy);
        b.y = drag.bounds.y + (drag.bounds.height - b.height);
      }
      api.win.setBounds(b);
    });
    el.addEventListener('pointerup', () => { drag = null; });
  }
}

// ---------------------------------------------------------------- 分栏
function bindSplitter() {
  let drag = null;
  dom.splitter.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, width: dom.leftPane.getBoundingClientRect().width };
    try { dom.splitter.setPointerCapture(e.pointerId); } catch (_e) { /* 合成事件没有真实指针 */ }
    e.preventDefault();
  });
  dom.splitter.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const total = dom.body.clientWidth;
    const width = Math.max(300, Math.min(total - 320, drag.width + (e.clientX - drag.sx)));
    dom.leftPane.style.flex = `0 0 ${width}px`;
    dom.leftPane.style.width = `${width}px`;
    ws.state.split = Math.round((width / total) * 1000) / 1000;
    placeToolbar();
  });
  dom.splitter.addEventListener('pointerup', () => {
    drag = null;
    // 分栏比例立刻落盘：拖完马上关窗口也不会丢
    saveNow();
  });
  applySplit();
  // 窗口大小变了也按同一个比例重新分栏
  window.addEventListener('resize', () => { if (!drag) applySplit(); });
}

function applySplit() {
  const total = dom.body.clientWidth || window.innerWidth;
  const width = Math.max(300, Math.min(total - 320, Math.round(total * (ws.state.split || 0.5))));
  dom.leftPane.style.flex = `0 0 ${width}px`;
  dom.leftPane.style.width = `${width}px`;
}

// ---------------------------------------------------------------- 快捷键
function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    const inPreview = Boolean(el && el.closest && el.closest('#preview'));
    const inCanvas = Boolean(el && el.closest && el.closest('#canvas'));
    // 焦点在"能打字的"地方（输入框 / 正文富文本）时，单键快捷键一律不生效
    const typing = Boolean(el && (el instanceof HTMLInputElement
      || el instanceof HTMLTextAreaElement || el.isContentEditable));
    const inField = typing || inPreview;
    // 焦点在笔记正文里：撤销 / 重做走笔记自己的内容历史
    const inNote = inPreview;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); newNote(); return; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newGraph(); return; }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
    if (ctrl && e.key === 'Tab') { e.preventDefault(); nextGraph(); return; }
    // 撤销 / 重做：笔记里先撤笔记内容，其它地方才走画布那套；普通输入框交给浏览器
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'z') {
      if (inNote && pane.redoNote()) { e.preventDefault(); return; }
      if (!inField) { e.preventDefault(); redo(); return; }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      if (inNote && pane.redoNote()) { e.preventDefault(); return; }
      if (!inField) { e.preventDefault(); redo(); return; }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      if (inNote && pane.undoNote()) { e.preventDefault(); return; }
      if (!inField) { e.preventDefault(); undo(); return; }
      return;
    }
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomNote(1.1); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); zoomNote(1 / 1.1); return; }
    if (ctrl && e.key === '0') { e.preventDefault(); zoomNote(0); return; }

    if (e.key === 'Escape') {
      if (inNote) { e.preventDefault(); pane.flush(); return; }   // 正文里按 Esc 只收光标，别抢去画布
      closePopover();
      dom.canvas.focus();
      return;
    }
    if (inField) return;

    if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
    // 下面这些只作用于画布：焦点不在画布上就不许执行
    if (!inCanvas) return;
    if (e.key === 'F5') { e.preventDefault(); relayout(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); canvas.fit(); return; }
    if (e.key === 'Delete' && canvas.selected) { e.preventDefault(); deleteNote(canvas.selected); }
  });

  // Ctrl+滚轮：只缩放右栏字号
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomNote(e.deltaY > 0 ? 1 / 1.1 : 1.1);
  }, { passive: false });
}

// ---------------------------------------------------------------- 启动
window.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    document.body.innerHTML = `<pre style="color:#fb464c;padding:20px">启动失败：\n${err && err.stack}</pre>`;
  });
});

// 供测试脚本调用
window.__fyn = {
  get ws() { return ws; },
  get canvas() { return canvas; },
  get pane() { return pane; },
  newNote, deleteNote, selectNote, switchGraph, newGraph, tidy, relayout,
  setCardColor, openPopover, menuSpec, saveNow, undo, redo, zoomNote,
  setFocusOnly, placeToolbar, api, geometry, setLinkShape, setLinkArrow,
  followLink, createMissing, branchFrom, repinLink, removeLink, repinAll,
  showHelp, showAbout, menuAction: (menu, idx) => menuSpec(menu)[idx],
};
