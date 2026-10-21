'use strict';
/** 主进程服务：数据层 + IPC（main.js 和截图脚本共用）。 */

const path = require('path');
const fs = require('fs');
const { ipcMain, shell, dialog, protocol, app } = require('electron');
const { Store } = require('./store');
const { clampBounds, flushWindow } = require('./window');

// 图片走私有协议：fyn-img://local/<文件名>。
// registerSchemesAsPrivileged 必须在 app ready 之前调用，所以放在模块加载阶段。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fyn-img',
    privileges: {
      standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
    },
  },
]);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

function mimeOf(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

let store = null;
let win = null;

function initService({ dataDir, legacyDir, getWindow }) {
  store = new Store(dataDir);
  if (legacyDir) {
    try { store.migrateLegacy(legacyDir); } catch (_e) { /* ignore */ }
  }
  win = getWindow;
  register();
  return store;
}

function currentWindow() {
  return typeof win === 'function' ? win() : win;
}

function register() {
  const send = (channel, payload) => {
    const w = currentWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  // 笔记里的图片：从 data/image/ 读，路径不进界面
  protocol.handle('fyn-img', async (request) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const file = store.imagePath(name);
      if (!file) return new Response('not found', { status: 404 });
      const buf = await fs.promises.readFile(file);
      return new Response(buf, {
        headers: { 'content-type': mimeOf(file), 'cache-control': 'no-cache' },
      });
    } catch (_err) {
      return new Response('bad request', { status: 400 });
    }
  });

  ipcMain.handle('image:save', (_e, { buffer, ext }) => ({ name: store.saveImage(buffer, ext) }));
  ipcMain.handle('image:stats', () => ({ count: store.listImages().length }));
  ipcMain.handle('image:cleanup', (_e, notes) => store.pruneImages(notes));

  ipcMain.handle('store:load', () => store.load());
  ipcMain.handle('store:save-all', (_e, { state, notes }) => { store.saveAll(state, notes); return true; });
  ipcMain.handle('store:save-note', (_e, note) => { store.saveNote(note); return true; });
  ipcMain.handle('store:save-state', (_e, state) => { store.saveState(state); return true; });
  ipcMain.handle('store:backup', (_e, { state, notes, reason, force }) =>
    store.backup(state, notes, reason, force));
  ipcMain.handle('store:info', () => ({
    dataDir: store.dataDir, notesDir: store.notesDir, backupsDir: store.backupsDir,
  }));  ipcMain.handle('store:backups', () => store.backups());

  ipcMain.handle('shell:open-folder', async (_e, which) => {
    const dir = which === 'backups' ? store.backupsDir : store.dataDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('win:get-bounds', () => {
    const w = currentWindow();
    return w ? w.getBounds() : null;
  });
  ipcMain.handle('win:set-bounds', (_e, bounds) => {
    const w = currentWindow();
    if (!w || !bounds) return w ? w.getBounds() : null;
    // force=true 时绕过最小尺寸限制（"收起成小条"要用）
    const next = bounds.force
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : clampBounds(bounds);
    w.setBounds(next);
    return w.getBounds();
  });
  ipcMain.handle('win:min-size', (_e, size) => {
    const w = currentWindow();
    if (!w || !size) return false;
    w.setMinimumSize(Math.max(0, size.width | 0), Math.max(0, size.height | 0));
    return true;
  });
  ipcMain.handle('win:minimize', () => { const w = currentWindow(); if (w) w.minimize(); });
  ipcMain.handle('win:maximize', () => {
    const w = currentWindow();
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('win:is-maximized', () => {
    const w = currentWindow();
    return w ? w.isMaximized() : false;
  });
  ipcMain.handle('win:close', () => { const w = currentWindow(); if (w) w.close(); });
  // 重启：先存盘再重新拉起进程
  ipcMain.handle('win:relaunch', async () => {
    const w = currentWindow();
    await flushWindow(w);
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('clipboard:read', () => require('electron').clipboard.readText() || '');
  ipcMain.handle('clipboard:write', (_e, text) => {
    require('electron').clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  ipcMain.handle('dialog:confirm', async (_e, { title, message }) => {
    const w = currentWindow();
    const result = await dialog.showMessageBox(w, {
      type: 'question', buttons: ['取消', '确定'], defaultId: 1, cancelId: 0,
      title: title || '确认', message: message || '',
    });
    return result.response === 1;
  });
}

module.exports = { initService, getStore: () => store };
