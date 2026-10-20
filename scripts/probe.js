'use strict';
/** 通用探针：在离屏窗口里执行一段 JS 并打印返回值。 */
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

const argv = process.argv.slice(2);
const scriptArg = argv.find((a) => a.startsWith('--script='));
const scriptFile = scriptArg ? scriptArg.slice('--script='.length) : null;
const dataArg = argv.find((a) => a.startsWith('--data-dir='));
const dataDirArg = dataArg ? dataArg.slice('--data-dir='.length) : null;

let win = null;

app.whenReady().then(() => {
  const dataDir = dataDirArg || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-probe-')), 'data');
  if (!dataDirArg) seedDemo(new Store(dataDir));
  initService({ dataDir, getWindow: () => win });
  win = createWindow({ width: 1420, height: 900, show: false, offscreen: true });

  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 800));
      const code = fs.readFileSync(path.resolve(scriptFile), 'utf8');
      const result = await win.webContents.executeJavaScript(code, true);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('probe failed:', err);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
});

app.on('window-all-closed', () => app.quit());
