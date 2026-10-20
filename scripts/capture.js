'use strict';
/**
 * 截图脚本：用临时数据目录起一个隐藏窗口，抓一张 PNG 后退出。
 *
 *   npx electron scripts/capture.js --out=docs/screenshot-view.png
 *   npx electron scripts/capture.js --out=a.png --script=scripts/scenes/edit.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const { initService } = require('../main/service');
const { createWindow } = require('../main/window');
const { Store } = require('../main/store');
const { seedDemo } = require('./demo-data');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function flag(name) {
  return argv.includes('--' + name);
}

const out = path.resolve(arg('out', 'shot.png'));
const scriptFile = arg('script', null);
const width = Number(arg('width', 1420));
const height = Number(arg('height', 900));
const noDemo = flag('no-demo');

let win = null;

// 某些环境（远程/无 GPU）下 viz 合成会失败，截图时强制走软件渲染
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

app.whenReady().then(async () => {
  const dataDir = arg('data-dir', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-shot-')), 'data'));
  if (!noDemo && !fs.existsSync(path.join(dataDir, 'notes'))) {
    const store = new Store(dataDir);
    seedDemo(store);
  }
  initService({ dataDir, getWindow: () => win });
  win = createWindow({ width, height, show: false, offscreen: true });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log('[renderer]', level, message, source + ':' + line);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[fail-load]', code, desc));

  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 900));
      const probe = await win.webContents.executeJavaScript(
        `(() => { try { const w = window.__fyn; const c = w.canvas;
          const recs = [...c.records.values()];
          let overlaps = 0;
          for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
            const a = recs[i], b = recs[j];
            const ox = (a.w + b.w) / 2 - Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
            const oy = (a.h + b.h) / 2 - Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
            if (ox > 1 && oy > 1) overlaps++;
          }
          const first = document.querySelector('.card');
          const inner = first && first.querySelector('.card-inner');
          return JSON.stringify({
            notes: Object.keys(w.ws.notes).length,
            records: c.records.size,
            cards: document.querySelectorAll('.card').length,
            overlaps,
            scale: c.zoom.toFixed(2),
            cardBox: first ? [first.offsetWidth, first.offsetHeight] : null,
            innerBox: inner ? [inner.offsetWidth, inner.offsetHeight] : null,
            scrollH: first ? first.scrollHeight : null,
          }); } catch (e) { return 'probe error: ' + e.message + e.stack; } })()`, true);
      console.log('[probe]', probe);
      if (scriptFile) {
        const code = fs.readFileSync(path.resolve(scriptFile), 'utf8');
        await win.webContents.executeJavaScript(code, true);
      }
      await new Promise((r) => setTimeout(r, 600));
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, image.toPNG());
      console.log('saved', out);
    } catch (err) {
      console.error('capture failed:', err);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
});

app.on('window-all-closed', () => app.quit());
