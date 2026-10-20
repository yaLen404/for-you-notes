'use strict';
/** 渲染进程与主进程之间唯一的通道（contextBridge，不暴露 Node）。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foryou', {
  load: () => ipcRenderer.invoke('store:load'),
  saveAll: (state, notes) => ipcRenderer.invoke('store:save-all', { state, notes }),
  saveNote: (note) => ipcRenderer.invoke('store:save-note', note),
  saveState: (state) => ipcRenderer.invoke('store:save-state', state),
  backup: (state, notes, reason, force) =>
    ipcRenderer.invoke('store:backup', { state, notes, reason, force }),
  backups: () => ipcRenderer.invoke('store:backups'),
  info: () => ipcRenderer.invoke('store:info'),
  openFolder: (which) => ipcRenderer.invoke('shell:open-folder', which),
  confirm: (title, message) => ipcRenderer.invoke('dialog:confirm', { title, message }),

  // 图片：存进 data/image/，界面只认文件名（不显示路径）
  images: {
    save: (buffer, ext) => ipcRenderer.invoke('image:save', { buffer, ext }),
    stats: () => ipcRenderer.invoke('image:stats'),
    cleanup: (notes) => ipcRenderer.invoke('image:cleanup', notes),
  },

  win: {
    bounds: () => ipcRenderer.invoke('win:get-bounds'),
    setBounds: (b) => ipcRenderer.invoke('win:set-bounds', b),
    minSize: (width, height) => ipcRenderer.invoke('win:min-size', { width, height }),
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    close: () => ipcRenderer.invoke('win:close'),
    relaunch: () => ipcRenderer.invoke('win:relaunch'),
    onMaximized: (fn) => ipcRenderer.on('win:maximized', (_e, v) => fn(v)),
    // 关窗口前主进程会来要一次"存盘"，存完再回话，避免最后一点状态丢掉
    onFlushRequest: (fn) => {
      ipcRenderer.on('app:flush', async () => {
        try {
          await fn();
        } catch (_e) { /* ignore */ } finally {
          ipcRenderer.send('app:flush-done');
        }
      });
    },
  },
});
