'use strict';
/**
 * Electron 主进程：窗口 + 数据（笔记 JSON / app.json / 备份 / 迁移）。
 * 渲染进程只做界面，所有落盘都从这里走。
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const { initService } = require('./main/service');
const { createWindow } = require('./main/window');

const LOG_FILE = path.join(__dirname, 'launch.log');

function logLine(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (_e) { /* 日志写不了就算了 */ }
}

// 启动失败要留下痕迹：双击启动时没有控制台，出问题只能靠 launch.log
process.on('uncaughtException', (err) => logLine('uncaught: ' + (err && err.stack ? err.stack : err)));
process.on('unhandledRejection', (err) => logLine('rejection: ' + (err && err.stack ? err.stack : err)));
logLine(`boot electron ${process.versions.electron} node ${process.versions.node}`);

let win = null;

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.yalen.foryounotes');

  const dataDir = argValue('--data-dir') || process.env.FYN_DATA_DIR || undefined;
  initService({
    dataDir,
    legacyDir: path.join(__dirname, 'data'),
    getWindow: () => win,
  });

  win = createWindow({ width: 1420, height: 900 });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logLine(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine('render-process-gone ' + JSON.stringify(details));
  });
  win.on('closed', () => { win = null; });

  app.on('activate', () => {
    if (!win) win = createWindow({ width: 1420, height: 900 });
  });
});

app.on('window-all-closed', () => { app.quit(); });
