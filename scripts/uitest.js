'use strict';
/**
 * 界面自检：在真实的 Electron 窗口里跑 scripts/ui-suite.js。
 *
 *   npx electron scripts/uitest.js
 *
 * 窗口用离屏渲染、临时数据目录，不碰真实笔记。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const { initService } = require('../main/service');
const { createWindow } = require('../main/window');
const { Store } = require('../main/store');
const { seedDemo } = require('./demo-data');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

let win = null;

app.whenReady().then(() => {
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-ui-')), 'data');
  seedDemo(new Store(dataDir));
  initService({ dataDir, getWindow: () => win });
  win = createWindow({ width: 1420, height: 900, show: false, offscreen: true });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log('[renderer]', message, source + ':' + line);
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 900));
      const code = fs.readFileSync(path.join(__dirname, 'ui-suite.js'), 'utf8');
      const results = await win.webContents.executeJavaScript(code, true);
      let passed = 0;
      console.log('\n== 界面自检 ==');
      for (const [name, ok, detail] of results) {
        if (ok) passed += 1;
        console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —  ' + detail : ''}`);
      }
      console.log(`  合计 ${passed} / ${results.length} 通过`);
      if (passed !== results.length) process.exitCode = 1;
    } catch (err) {
      console.error('uitest crashed:', err);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
});

app.on('window-all-closed', () => app.quit());
