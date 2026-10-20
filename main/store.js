'use strict';
/**
 * 数据层：笔记 / 图 / 工作区状态的读写、自动备份、旧数据迁移。
 *
 * 和 Python 版完全兼容：
 *   %LOCALAPPDATA%\ForYouNotes\data\
 *     notes\<id>.json
 *     app.json
 *     backups\backup-YYYYMMDD-HHMMSS.json
 *
 * 写入一律「临时文件 + rename」，不会写一半断电留下坏文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const KEEP_BACKUPS = 30;
const BACKUP_INTERVAL = 120; // 秒

function nowMs() {
  return Date.now();
}

function newId(prefix) {
  return prefix + String(Math.floor(Math.random() * 1e12));
}

function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ForYouNotes', 'data');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir || defaultDataDir());
    this.notesDir = path.join(this.dataDir, 'notes');
    this.backupsDir = path.join(this.dataDir, 'backups');
    // 图片统一放在整个笔记库下的 image 目录（界面里不显示这个路径）
    this.imageDir = path.join(this.dataDir, 'image');
    this.statePath = path.join(this.dataDir, 'app.json');
    this._lastSig = '';
    this._lastTs = 0;
  }

  ensureDirs() {
    for (const dir of [this.dataDir, this.notesDir, this.backupsDir, this.imageDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------- 读
  load() {
    this.ensureDirs();
    const state = readJson(this.statePath, null) || {};
    const notes = {};
    if (fs.existsSync(this.notesDir)) {
      for (const name of fs.readdirSync(this.notesDir)) {
        if (!name.endsWith('.json')) continue;
        const data = readJson(path.join(this.notesDir, name), null);
        if (data && data.id) notes[data.id] = normalizeNote(data);
      }
    }
    const normalized = normalizeState(state, notes);
    return { state: normalized, notes };
  }

  // ---------------------------------------------------------------- 写
  _atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2));
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  saveNote(note) {
    this.ensureDirs();
    this._atomicWrite(path.join(this.notesDir, note.id + '.json'),
      JSON.stringify(note, null, 2));
  }

  saveState(state) {
    this.ensureDirs();
    this._atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }

  /** 整库写盘；顺手清掉已经不在内存里的笔记文件 */
  saveAll(state, notes) {
    this.ensureDirs();
    const live = new Set();
    for (const note of Object.values(notes)) {
      this.saveNote(note);
      live.add(note.id + '.json');
    }
    for (const name of fs.readdirSync(this.notesDir)) {
      if (name.endsWith('.json') && !live.has(name)) {
        try { fs.unlinkSync(path.join(this.notesDir, name)); } catch (_e) { /* ignore */ }
      }
    }
    this.saveState(state);
  }

  deleteNoteFile(id) {
    try { fs.unlinkSync(path.join(this.notesDir, id + '.json')); } catch (_e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 图片
  /** 存一张图到 data/image/，返回文件名（笔记里只记文件名，不记路径） */
  saveImage(buffer, ext = 'png') {
    this.ensureDirs();
    const safeExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const name = `img-${nowMs().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
    fs.writeFileSync(path.join(this.imageDir, name), Buffer.from(buffer));
    return name;
  }

  /** 只允许读 image 目录里的普通文件名，杜绝 ../ 之类的路径穿越 */
  imagePath(name) {
    const base = path.basename(String(name || ''));
    if (!base || base !== String(name) || base.startsWith('.')) return null;
    const file = path.join(this.imageDir, base);
    if (!file.startsWith(this.imageDir + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  }

  listImages() {
    this.ensureDirs();
    try {
      return fs.readdirSync(this.imageDir).filter((n) => !n.startsWith('.')
        && fs.statSync(path.join(this.imageDir, n)).isFile());
    } catch (_e) {
      return [];
    }
  }

  /** 清掉没有被任何笔记引用的图片；返回 { removed, kept } */
  pruneImages(notes) {
    const used = new Set();
    for (const note of Object.values(notes || {})) {
      const text = String((note && note.content) || '');
      for (const m of text.matchAll(/!\[\[([^\[\]\n]{1,200})\]\]|!\[[^\]\n]*\]\(([^)\n]{1,300})\)/g)) {
        const raw = (m[1] || m[2] || '').trim();
        const base = raw.split(/[\\/]/).pop();
        if (base) used.add(base);
      }
    }
    let removed = 0;
    let kept = 0;
    for (const name of this.listImages()) {
      if (used.has(name)) { kept += 1; continue; }
      try { fs.unlinkSync(path.join(this.imageDir, name)); removed += 1; } catch (_e) { /* ignore */ }
    }
    return { removed, kept };
  }

  // ---------------------------------------------------------------- 备份
  signature(state, notes) {
    const payload = JSON.stringify({
      state,
      notes: Object.values(notes).sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
    return crypto.createHash('sha1').update(payload).digest('hex');
  }

  backup(state, notes, reason = 'auto', force = false) {
    this.ensureDirs();
    const sig = this.signature(state, notes);
    const now = nowMs();
    if (!force) {
      if (sig === this._lastSig) return null;
      if (this._lastTs && now / 1000 - this._lastTs < BACKUP_INTERVAL) return null;
    }
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.json`;
    const file = path.join(this.backupsDir, name);
    const payload = {
      saved: now,
      reason,
      state,
      notes: Object.values(notes).sort((a, b) => (a.created || 0) - (b.created || 0)),
    };
    this._atomicWrite(file, JSON.stringify(payload, null, 2));
    this._lastSig = sig;
    this._lastTs = now / 1000;
    this._prune();
    return file;
  }

  _prune() {
    let names = [];
    try {
      names = fs.readdirSync(this.backupsDir)
        .filter((n) => n.startsWith('backup-') && n.endsWith('.json')).sort();
    } catch (_e) { return; }
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
      try { fs.unlinkSync(path.join(this.backupsDir, name)); } catch (_e) { /* ignore */ }
    }
  }

  backups() {
    try {
      return fs.readdirSync(this.backupsDir)
        .filter((n) => n.startsWith('backup-') && n.endsWith('.json')).sort()
        .map((n) => path.join(this.backupsDir, n));
    } catch (_e) { return []; }
  }

  // ---------------------------------------------------------------- 迁移
  /** 旧版把数据放在程序目录 data\：只在用户目录还空着时复制一次，旧目录不删。 */
  migrateLegacy(legacyDir) {
    if (!legacyDir) return false;
    const legacyNotes = path.join(legacyDir, 'notes');
    if (!fs.existsSync(legacyNotes)) return false;
    const hasOwn = fs.existsSync(this.notesDir) &&
      fs.readdirSync(this.notesDir).some((n) => n.endsWith('.json'));
    if (hasOwn) return false;
    this.ensureDirs();
    let copied = 0;
    for (const name of fs.readdirSync(legacyNotes)) {
      if (!name.endsWith('.json')) continue;
      try {
        fs.copyFileSync(path.join(legacyNotes, name), path.join(this.notesDir, name));
        copied += 1;
      } catch (_e) { /* ignore */ }
    }
    const legacyState = path.join(legacyDir, 'app.json');
    if (fs.existsSync(legacyState) && !fs.existsSync(this.statePath)) {
      try { fs.copyFileSync(legacyState, this.statePath); } catch (_e) { /* ignore */ }
    }
    return copied > 0;
  }
}

// ---------------------------------------------------------------- 规范化
function normalizeNote(data) {
  const links = Array.isArray(data.links) ? data.links.map((raw) => {
    if (typeof raw === 'string') return { id: raw, shape: 'line', arrow: 'solid', width: 4, arrowSize: 14 };
    if (raw && raw.id) {
      return {
        id: raw.id,
        shape: raw.shape === 'curve' ? 'curve' : 'line',
      width: Math.max(1, Math.min(10, Number(raw.width) || 4)),
      arrowSize: Math.max(4, Math.min(40, Number(raw.arrowSize) || 14)),
        arrow: ['solid', 'hollow', 'none'].includes(raw.arrow) ? raw.arrow : 'solid',
      };
    }
    return null;
  }).filter(Boolean) : [];
  return {
    id: String(data.id),
    title: String(data.title || ''),
    content: String(data.content || ''),
    color: typeof data.color === 'string' ? data.color : '',
    todo: Boolean(data.todo),
    created: Number(data.created) || nowMs(),
    updated: Number(data.updated) || nowMs(),
    graph: String(data.graph || ''),
    links,
  };
}

function normalizeState(state, notes) {
  const out = Object.assign({}, state || {});
  let graphs = Array.isArray(out.graphs) ? out.graphs.filter((g) => g && g.id) : [];
  graphs = graphs.map((g) => ({
    id: String(g.id),
    name: String(g.name || '知识体系图'),
    created: Number(g.created) || nowMs(),
    selected: g.selected || null,
    zoom: Number(g.zoom) || 1,
    cam: Array.isArray(g.cam) ? [Number(g.cam[0]) || 0, Number(g.cam[1]) || 0] : [0, 0],
    pos: g.pos && typeof g.pos === 'object' ? g.pos : {},
    size: g.size && typeof g.size === 'object' ? g.size : {},
    sides: g.sides && typeof g.sides === 'object' ? g.sides : {},
    last_note: g.last_note || null,
  }));
  if (!graphs.length) {
    graphs = [{
      id: newId('g'), name: '知识体系图', created: nowMs(),
      selected: null, zoom: 1, cam: [0, 0], pos: {}, size: {},
    }];
  }
  const known = new Set(graphs.map((g) => g.id));
  for (const note of Object.values(notes)) {
    if (!known.has(note.graph)) note.graph = graphs[0].id;
  }
  out.graphs = graphs;
  if (!known.has(out.graph_id)) out.graph_id = graphs[0].id;
  if (!notes[out.selected]) out.selected = null;
  if (!['edit', 'view'].includes(out.mode)) out.mode = 'edit';
  if (typeof out.query !== 'string') out.query = '';
  out.focus = Boolean(out.focus);
  out.zoom = Math.max(0.7, Math.min(2.4, Number(out.zoom) || 1));
  out.split = Math.min(0.78, Math.max(0.22, Number(out.split) || 0.5));
  return out;
}

module.exports = {
  Store, defaultDataDir, normalizeNote, normalizeState, newId, nowMs,
  KEEP_BACKUPS, BACKUP_INTERVAL,
};
