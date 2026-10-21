// 界面自检（在渲染进程里跑）：返回 [[name, ok, detail], ...]
(async () => {
  const out = [];
  const f = window.__fyn;
  const ws = f.ws;
  const c = f.canvas;
  const G = f.geometry;
  const $ = (s) => document.querySelector(s);
  const canvasEl = document.getElementById('canvas');
  const preview = document.getElementById('preview');
  // 富文本块编辑：正文切成 .blk，编辑中的块里是 contenteditable 的 .blk-txt
  const anyEditing = () => document.querySelectorAll('#preview .blk.is-editing');
  /** 当前"能打字的东西"：源码块是 textarea，富文本块是聚焦的 .blk-txt */
  const activeEditor = () => {
    const ta = document.querySelector('#preview .blk.is-editing textarea');
    if (ta) return ta;
    // 单宿主：焦点在 #preview，当前块由选区决定
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    const blk = el && el.closest ? el.closest('.blk') : null;
    return blk ? blk.querySelector('.blk-txt') : null;
  };
  const activeTA = activeEditor;   // 老名字，保留给已有用例
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /** 往"当前编辑的东西"里写一段纯文本（textarea 和富文本块都支持） */
  const setBlockText = (el, text) => {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') el.value = text;
    else el.innerHTML = esc(text).replace(/\n/g, '<br>');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  // 真实点击：点一下某一块就应该能在里面落光标
  const clickBlock = async (i = 0) => {
    const el = document.querySelector(`#preview .blk[data-i="${i}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    pointer(el, 'pointerdown', r.left + 12, r.top + 6);
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: r.left + 12, clientY: r.top + 6,
    }));
    await wait(180);
    return activeEditor();
  };
  /** 只单击一次（现在单击就该进编辑） */
  const singleClickBlock = clickBlock;
  // 其它用例只需要"某一块在编辑"，直接走公开 API
  const openBlock = async (i = 0) => {
    if (f.pane.mode !== 'edit') f.pane.setMode('edit');
    f.pane.focusBlock(i, 'end');
    await wait(140);
    return activeEditor();
  };
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const run = async (name, fn) => {
    try { const d = await fn(); out.push([name, true, d == null ? '' : String(d)]); }
    catch (e) { out.push([name, false, e && e.message ? e.message : String(e)]); }
  };
  const fail = (msg) => { throw new Error(msg); };
  const placeToolbarForTest = () => f.setFocusOnly(false);
  /** 真实鼠标路径的点击：pointdown → pointerup → click（能暴露"指针被抢走"的问题） */
  const realClick = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const target = document.elementFromPoint(x, y) || el;
    pointer(target, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  };
  const closePopoverForTest = () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const pointer = (el, type, x, y, extra = {}) => el.dispatchEvent(new PointerEvent(type, Object.assign({
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true,
  }, extra)));
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const cardOf = (id) => document.querySelector(`.card[data-id="${id}"]`);

  await wait(200);

  await run('默认左右等宽', async () => {
    const body = document.getElementById('body').clientWidth;
    const left = document.getElementById('leftPane').clientWidth;
    if (Math.abs(left / body - 0.5) > 0.03) fail(`${left}/${body}`);
    return `${left}/${body} = ${(left / body).toFixed(3)}`;
  });

  await run('分隔条是 1px 白线', async () => {
    const st = getComputedStyle($('.splitter-line'));
    if (st.width !== '1px' || st.backgroundColor !== 'rgb(255, 255, 255)') fail(`${st.width} ${st.backgroundColor}`);
    return '白色 1px';
  });

  await run('单击卡片：选中但不夺走笔记焦点', async () => {
    f.pane.focusBlock(0, 'end');
    await wait(80);
    const card = $('.card');
    const id = card.dataset.id;
    const [x, y] = center(card);
    pointer(card, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
    await wait();
    if (c.selected !== id) fail('没有选中');
    if (anyEditing().length) fail('笔记还停在编辑态');
    return '选中且焦点在画布';
  });

  await run('双击卡片：焦点交给笔记', async () => {
    // 先把可能残留的焦点清掉，模拟"用户在画布上"的状态
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await wait(80);
    const card = $('.card');
    const [x, y] = center(card);
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
    await wait(250);
    const ae = document.activeElement;
    const inNote = Boolean(ae && (ae === preview || preview.contains(ae)));
    if (!inNote) fail('焦点没进笔记区');
    return '焦点在笔记区';
  });

  await run('点空白：焦点收回画布', async () => {
    f.pane.focusBlock(0, 'end');
    await wait(80);
    pointer(canvasEl, 'pointerdown', 6, 6);
    pointer(window, 'pointerup', 6, 6);
    await wait();
    if (anyEditing().length) fail('正文还停在编辑态');
    return '焦点已收回';
  });

  await run('笔记字号只放大右栏', async () => {
    const card = $('.card');
    const id = card.dataset.id;
    const z0 = c.zoom;
    const w0 = card.getBoundingClientRect().width;
    const fs0 = getComputedStyle(preview).fontSize;
    f.zoomNote(1.5);
    await wait();
    const w1 = cardOf(id).getBoundingClientRect().width;
    const fs1 = getComputedStyle(preview).fontSize;
    f.zoomNote(0);
    await wait();
    if (Math.abs(c.zoom - z0) > 1e-9) fail('画布缩放变了');
    if (Math.abs(w1 - w0) > 1) fail(`卡片尺寸变了 ${w0} -> ${w1}`);
    if (fs0 === fs1) fail('字号没变');
    return `${fs0} -> ${fs1}`;
  });

  await run('Ctrl+滚轮只改字号', async () => {
    const z0 = c.zoom;
    const s0 = f.pane.scale;
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await wait();
    const ok = Math.abs(c.zoom - z0) < 1e-9 && f.pane.scale > s0;
    f.zoomNote(0);
    await wait();
    if (!ok) fail(`zoom ${z0} -> ${c.zoom}, scale ${s0} -> ${f.pane.scale}`);
    return '画布不动，右栏变大';
  });

  await run('滚轮以光标为焦点不漂移', async () => {
    c.setZoom(1);
    await wait();
    const r = canvasEl.getBoundingClientRect();
    const px = r.left + r.width * 0.42;
    const py = r.top + r.height * 0.38;
    const before = c.toWorld(px - r.left, py - r.top);
    canvasEl.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, bubbles: true, cancelable: true, clientX: px, clientY: py,
    }));
    await wait();
    const after = c.toWorld(px - r.left, py - r.top);
    const drift = Math.hypot(after[0] - before[0], after[1] - before[1]);
    if (drift > 0.2) fail(`漂移 ${drift.toFixed(3)}`);
    return `漂移 ${drift.toFixed(4)}`;
  });

  await run('缩放后箭头仍然贴边', async () => {
    c.setZoom(1.8);
    await wait();
    let checked = 0;
    for (const { src, dst, link } of c.allLinks()) {
      const a = c.records.get(src);
      const b = c.records.get(dst);
      const ra = { x: a.x, y: a.y, w: a.w, h: a.h };
      const rb = { x: b.x, y: b.y, w: b.w, h: b.h };
      const path = G.linkPath(ra, rb, link.shape);
      if (!G.isSideMidpoint(ra, path.start)) fail('起点不在中点');
      if (!G.isSideMidpoint(rb, path.end)) fail('终点不在中点');
      const sa = c.toScreen(path.start);
      const sb = c.toScreen(path.end);
      const pa = c.toScreen([ra.x, ra.y]);
      const pb = c.toScreen([rb.x, rb.y]);
      const sra = { x: pa[0], y: pa[1], w: ra.w * c.zoom, h: ra.h * c.zoom };
      const srb = { x: pb[0], y: pb[1], w: rb.w * c.zoom, h: rb.h * c.zoom };
      if (!G.onBorder(sra, sa, 0.6)) fail('起点没贴边');
      if (!G.onBorder(srb, sb, 0.6)) fail('终点没贴边');
      checked += 1;
    }
    c.setZoom(1);
    await wait();
    if (checked < 3) fail(`只检查了 ${checked} 条`);
    return `${checked} 条连线`;
  });

  await run('整理布局可复现且不重叠', async () => {
    f.tidy();
    await wait();
    const p1 = c.positions();
    f.tidy();
    await wait();
    const p2 = c.positions();
    let worst = 0;
    for (const k of Object.keys(p1)) {
      worst = Math.max(worst, Math.abs(p1[k][0] - p2[k][0]) + Math.abs(p1[k][1] - p2[k][1]));
    }
    if (worst > 0.02) fail(`两次布局差 ${worst}`);
    let overlaps = 0;
    const recs = [...c.records.values()];
    for (let i = 0; i < recs.length; i += 1) {
      for (let j = i + 1; j < recs.length; j += 1) {
        const a = recs[i];
        const b = recs[j];
        const ox = (a.w + b.w) / 2 - Math.abs(a.x + a.w / 2 - (b.x + b.w / 2));
        const oy = (a.h + b.h) / 2 - Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
        if (ox > 1 && oy > 1) overlaps += 1;
      }
    }
    if (overlaps) fail(`还有 ${overlaps} 对重叠`);
    return `${recs.length} 个节点，两次一致，无重叠`;
  });

  await run('撤销 / 重做', async () => {
    const n0 = ws.notesOf().length;
    f.newNote();
    await wait();
    if (ws.notesOf().length !== n0 + 1) fail('新建没生效');
    f.undo();
    await wait();
    if (ws.notesOf().length !== n0) fail(`撤销后 ${ws.notesOf().length}`);
    f.redo();
    await wait();
    if (ws.notesOf().length !== n0 + 1) fail('重做没生效');
    f.undo();
    await wait();
    return '新建 -> 撤销 -> 重做 -> 撤销';
  });

  await run('多图隔离', async () => {
    const g1 = ws.graphId;
    const count = ws.notesOf().length;
    f.newGraph();
    await wait();
    const empty = ws.notesOf().length === 0;
    f.switchGraph(g1);
    await wait();
    const back = ws.notesOf().length === count;
    if (!empty) fail('新图带了笔记');
    if (!back) fail('切回来笔记数不对');
    return `两张图 ${count} / 0`;
  });

  await run('图菜单能切到别的图', async () => {
    const g1 = ws.graphId;
    const notes1 = ws.notesOf().length;
    f.newGraph();
    await wait(200);
    const g2 = ws.graphId;
    if (g1 === g2) fail('新建图后没有切过去');
    if (ws.notesOf().length !== 0) fail('新图不该有旧笔记');
    const btn = document.getElementById('graphBtn');
    const idxOf = (gid) => ws.graphs().findIndex((g) => g.id === gid);
    const clickGraph = async (gid) => {
      btn.click();
      await wait(150);
      const rows = [...document.getElementById('popover').querySelectorAll('.item')];
      const row = rows[idxOf(gid)];
      if (!row) fail(`菜单里找不到第 ${idxOf(gid) + 1} 张图`);
      row.click();
      await wait(220);
    };
    await clickGraph(g1);
    if (ws.graphId !== g1) fail('点原有的图没切回去');
    if (ws.notesOf().length !== notes1) fail('切回去笔记数不对');
    await clickGraph(g2);
    if (ws.graphId !== g2) fail('点新图没切过去');
    await clickGraph(g1); // 收尾：回到有笔记的那张
    if (ws.graphId !== g1) fail('收尾没切回原图');
    return `${ws.graphs().length} 张图，来回切换正常`;
  });

  await run('菜单点击命中正确的项', async () => {
    const before = ws.notesOf().length;
    document.querySelector('.menubar-btn[data-menu="file"]').click();
    await wait(140);
    const rows = [...document.getElementById('popover').querySelectorAll('.item')];
    const target = rows.find((r) => r.textContent.includes('立即保存'));
    if (!target) fail('文件菜单里找不到「立即保存」');
    target.click();
    await wait(180);
    if (ws.notesOf().length !== before) fail('点「立即保存」却新建了笔记 —— 菜单派发跑到第一项去了');
    return '点哪项执行哪项';
  });

  await run('文件菜单里有「重启」，就在「退出」上面', async () => {
    const items = f.menuSpec('file');
    const labels = items.filter((it) => !it.sep).map((it) => it.label);
    const iRestart = labels.indexOf('重启');
    const iQuit = labels.indexOf('退出');
    if (iRestart < 0) fail('文件菜单里没有「重启」：' + labels.join(' / '));
    if (iQuit < 0) fail('文件菜单里没有「退出」');
    if (iRestart !== iQuit - 1) fail(`「重启」应该紧挨在「退出」上面：${labels.join(' / ')}`);
    if (typeof window.foryou.win.relaunch !== 'function') fail('主进程没暴露 win.relaunch');
    // 菜单里这一项必须真的指向重启，而不是别的动作
    const item = items.find((it) => it.label === '重启');
    if (item.accel) fail('「重启」不该占用快捷键：' + item.accel);
    return labels.slice(iRestart - 1).join(' → ');
  });

  await run('图片：存进库里，正文只留文件名', async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const res = await window.foryou.images.save(bytes, 'png');
    if (!res || !res.name) fail('保存图片失败');
    const name = res.name;
    if (!/^img-.*\.png$/.test(name)) fail('文件名不对: ' + name);
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(150);
    if (!(await openBlock(0))) fail('没有进入块编辑');
    f.pane.insertText(`![[${name}]]`);
    await wait(200);
    const content = ws.note(note.id).content;
    if (!content.includes(`![[${name}]]`)) fail('正文里没插入图片引用');
    if (content.includes('image/')) fail('正文里不该出现存放路径');
    f.pane.setMode('view');
    let img = null;
    for (let i = 0; i < 20; i += 1) {
      img = document.querySelector('#preview img.note-img');
      if (img && img.complete && img.naturalWidth > 0) break;
      await wait(100);
    }
    if (!img) fail('预览里没有图片元素');
    if (!img.complete || img.naturalWidth !== 1) fail(`图片没加载（w=${img.naturalWidth}）`);
    if (!img.src.startsWith('fyn-img://')) fail('src 不是私有协议: ' + img.src);
    return `${name} 已渲染，正文无路径`;
  });

  await run('粘贴事件：真的按 Ctrl+V 也能插进来', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(150);
    await openBlock(0);
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    const before = ws.note(note.id).content;
    const taPaste = activeTA();
    if (!taPaste) fail('没有进入块编辑');
    taPaste.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    let after = before;
    for (let i = 0; i < 30; i += 1) {
      after = ws.note(note.id).content;
      if (after.length > before.length && after.includes('![[img-')) break;
      await wait(100);
    }
    if (!after.includes('![[img-')) fail('粘贴没有插入图片');
    if (after.includes('image/')) fail('正文里出现了路径');
    return '剪贴板图片已落到库里的 image 目录';
  });

  await run('清理图片：不算正在用的那张', async () => {
    const res = await window.foryou.images.cleanup(ws.notes);
    if (res.removed > 0) fail(`误删了 ${res.removed} 张正在用的图片`);
    if (res.kept < 1) fail('没有被保留的图片');
    return `保留 ${res.kept} 张，删除 ${res.removed} 张`;
  });

  await run('公式：LaTeX 渲染成排版结果', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(160);
    // 公式是独立块，直接写进笔记内容再看渲染结果
    const original = ws.note(note.id).content;
    ws.note(note.id).content = [
      '算力公式 $CI = \\text{FLOPs} / \\text{Bytes}$ 到此结束。',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
    ].join('\n');
    f.pane.renderBlocks();
    await wait(400);
    const nodes = document.querySelectorAll('#preview .katex');
    if (!nodes.length) fail('没有渲染出 KaTeX 节点');
    const bad = document.querySelector('#preview .katex-error');
    if (bad) fail('公式报错：' + bad.textContent.slice(0, 60));
    const box = nodes[0].getBoundingClientRect();
    if (box.width < 5) fail('公式宽度异常 ' + box.width);
    const block = document.querySelector('#preview .math-block .katex-display');
    if (!block) fail('独立公式块没按 display 模式渲染');
    ws.note(note.id).content = original;
    f.pane.renderBlocks();
    await wait(150);
    return `${nodes.length} 个公式（含一个独行公式）`;
  });

  await run('公式：KaTeX 字体是本地加载的', async () => {
    const sheet = [...document.styleSheets].find((s) => (s.href || '').includes('katex'));
    if (!sheet) fail('没加载 katex 样式表');
    // 自己造一段公式，别依赖上一个用例的现场
    const note = ws.notesOf()[0];
    const original = ws.note(note.id).content;
    ws.note(note.id).content = '行内公式 $a^2 + b^2 = c^2$ 结束。';
    f.pane.renderBlocks();
    await wait(300);
    const probe = document.querySelector('#preview .katex .mathnormal, #preview .katex .mord');
    if (!probe) fail('找不到公式内部节点');
    const fam = getComputedStyle(probe).fontFamily || '';
    ws.note(note.id).content = original;
    f.pane.renderBlocks();
    if (!/KaTeX/i.test(fam)) fail('公式没用到 KaTeX 字体：' + fam);
    return fam.split(',')[0];
  });

  await run('一直按回车会一直加空块', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(240);
    const count = () => document.querySelectorAll('#preview .blk').length;
    const base = count();
    const original = ws.note(note.id).content;
    // 光标放到最后一块的末尾
    f.pane.focusBlock(f.pane._blocks.length - 1, 'end');
    await wait(220);
    for (let i = 0; i < 3; i += 1) {
      const ed = activeEditor();
      if (!ed) fail(`第 ${i + 1} 次回车前没有光标`);
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(240);
    }
    const after = count();
    if (after !== base + 3) fail(`回车 3 次后块数 ${base} → ${after}`);
    // 存回去再解析一遍也不能把空块压掉（round-trip）
    f.pane.renderBlocks();
    await wait(240);
    const again = count();
    if (again !== after) fail(`重新渲染后空块被压掉了：${after} → ${again}`);
    // 收尾：还原
    ws.note(note.id).content = original;
    f.pane.renderBlocks();
    await wait(150);
    return `回车 3 次 → ${after} 块，重渲染仍是 ${again} 块`;
  });

  await run('块可以新增、删除、拆分', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 2);
    if (!note) fail('找不到多段落的样例笔记');
    f.selectNote(note.id);
    await wait(260);
    f.pane.setMode('edit');
    await wait(220);
    const blkCount = () => document.querySelectorAll('#preview .blk').length;
    const content = () => ws.note(note.id).content;
    const base = blkCount();
    const originalContent = content();
    if (base < 2) fail('样例笔记块数太少：' + base);

    // ① 在最后一块按回车，加一块并写字
    f.pane.focusBlock(f.pane._blocks.length - 1, 'end');
    await wait(220);
    let ed = activeEditor();
    if (!ed) fail('最后一块没有光标');
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(320);
    ed = activeEditor();
    if (!ed) fail('回车后没有进入新块');
    if (blkCount() !== base + 1) fail(`新增块后块数 ${base} → ${blkCount()}`);
    setBlockText(ed, '新加的一块');
    await wait(220);
    if (!content().includes('新加的一块')) fail('新增块的内容没有写进笔记');

    // ② 删空这一块 → 空块要留下来
    ed = activeEditor();
    if (!ed) fail('空块没有光标');
    setBlockText(ed, '');
    await wait(200);
    if (content().includes('新加的一块')) fail('删空后文字还在');
    if (blkCount() !== base + 1) fail(`删空后空块应该还在：块数 ${blkCount()}，应为 ${base + 1}`);

    // ③ 空块开头退格 → 这一块才真的消失
    f.pane.focusBlock(blkCount() - 1, 'start');
    await wait(220);
    ed = activeEditor();
    if (!ed) fail('空块没有光标');
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    await wait(320);
    if (blkCount() !== base) fail(`空块退格后块数 ${blkCount()}，应为 ${base}`);

    // ④ 块尾回车 → 拆出一块空的
    f.pane.focusBlock(0, 'end');
    await wait(220);
    ed = activeEditor();
    if (!ed) fail('没进第一块');
    const beforeSplit = blkCount();
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(320);
    if (blkCount() !== beforeSplit + 1) fail(`回车后块数 ${beforeSplit} → ${blkCount()}`);
    const ed2 = activeEditor();
    if (!ed2) fail('回车后没有进入新块');
    if (String(ed2.textContent || '').trim() !== '') {
      fail('回车拆出的新块不是空的：' + JSON.stringify(ed2.textContent));
    }

    // 还原成一开始的内容（不动撤销栈）
    ws.note(note.id).content = originalContent;
    f.pane.renderBlocks();
    await wait(150);
    return `新增/删除/拆分/退格删块都正常（${base} 块）`;
  });

  await run('单击块就地编辑，失焦回预览', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(220);

    // 1) 编辑态下每块都是富文本，但还没有光标落在任何块里
    if (f.pane.mode !== 'edit') f.pane.setMode('edit');
    await wait(200);
    if (f.pane._focus != null) fail('没点就聚焦了某一块');

    // 2) 单击一次 → 光标落在被点的那一块里
    const single = await singleClickBlock(0);
    if (!single) fail('单击块没有进入编辑');
    if (!single.classList.contains('blk-txt')) fail('聚焦的不是块文本');
    const blk = single.closest('.blk');
    if (!blk || Number(blk.dataset.i) !== 0) fail('进的不是被点的那一块');

    // 3) 打字 → 内容进笔记
    const marker = '块编辑写入 ' + Date.now();
    setBlockText(single, (single.textContent || '') + ' ' + marker);
    await wait(200);
    if (!ws.note(note.id).content.includes(marker)) fail('输入没有写回笔记');

    // 4) 焦点离开笔记（像用户那样点到左栏搜索框）→ 回到全预览，且内容已提交
    //    注意：必须真的派发 pointerdown。离屏窗口没有焦点时 Chromium 不派发
    //    blur/focusin，靠 focus() 是测不出来的（真实窗口里 blur 会正常触发）。
    const search = document.getElementById('searchInput');
    const sr = search.getBoundingClientRect();
    pointer(search, 'pointerdown', sr.left + 12, sr.top + 6);
    pointer(window, 'pointerup', sr.left + 12, sr.top + 6);
    search.focus();
    await wait(420);
    if (anyEditing().length) fail('失焦后还有块停在编辑态');
    if (!document.getElementById('preview').innerHTML.includes(marker)) fail('预览没更新');
    if (!ws.note(note.id).content.includes(marker)) fail('内容没写回笔记');
    return '预览 → 单击某块就地编辑 → 失焦回预览';
  });

  await run('块左侧没有手柄了，加块靠回车', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 2);
    f.selectNote(note.id);
    await wait(250);
    if (document.querySelector('#preview .blk-ctl')) fail('块左侧还挂着手柄');
    if (document.querySelector('#preview .blk-plus')) fail('还有 ＋ 手柄');
    // 回车仍然能在块尾加一块
    const before = document.querySelectorAll('#preview .blk').length;
    f.pane.focusBlock(f.pane._blocks.length - 1, 'end');
    await wait(220);
    const ed = activeEditor();
    if (!ed) fail('最后一块没有光标');
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(300);
    const after = document.querySelectorAll('#preview .blk').length;
    if (after !== before + 1) fail(`回车后块数 ${before} → ${after}`);
    if (!activeEditor()) fail('回车后没有进入新块');
    return '没有手柄，回车照常加块';
  });

  await run('使用说明 / 关于 里不提别的软件，也不讲已经删掉的操作', async () => {
    const closeAll = () => {
      document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    };
    closeAll();
    f.showHelp();
    await wait(300);
    const helpEl = document.querySelector('.modal-overlay .modal-body');
    if (!helpEl) fail('使用说明没打开');
    const help = helpEl.textContent.replace(/\s+/g, ' ');
    if (/Notion|Obsidian|VSCode|Electron|Chromium|Tkinter/i.test(help)) {
      fail('使用说明里提到了别的软件');
    }
    if (help.includes('⋮⋮') || help.includes('＋ 新段落')) fail('使用说明还在讲已经删掉的按钮');
    if (!help.includes('/')) fail('使用说明没讲 / 菜单');
    if (!help.includes('Tab')) fail('使用说明没讲 Tab 缩进');
    closeAll();
    await wait(120);

    f.showAbout();
    await wait(300);
    const aboutEl = document.querySelector('.modal-overlay .modal-body');
    if (!aboutEl) fail('关于没打开');
    const about = aboutEl.textContent.replace(/\s+/g, ' ');
    if (/Obsidian|Notion|VSCode|Electron|Chromium|Tkinter/i.test(about)) {
      fail('关于里提到了别的软件');
    }
    if (!about.includes('For You Notes')) fail('关于里没有名字');
    if (!about.includes('本机') && !about.includes('不联网')) fail('关于没讲数据在本机');
    closeAll();
    await wait(120);
    return '说明 ' + help.length + ' 字 / 关于 ' + about.length + ' 字，均未提别的软件';
  });

  await run('右键图名按钮改名：原地在按钮上编辑，不打开列表', async () => {
    const gid = ws.graphId;
    const before = ws.graph().name;
    const btn = document.getElementById('graphBtn');
    const r = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 10), clientY: Math.round(r.bottom + 4),
    }));
    await wait(240);
    const pop = document.getElementById('popover');
    const rename = [...pop.querySelectorAll('.item')].find((el) => el.textContent.includes('重命名'));
    if (!rename) fail('右键菜单里没有重命名');
    rename.click();
    await wait(280);
    const input = document.querySelector('.inline-edit');
    if (!input) fail('没有出现原地编辑框');
    if (!pop.hidden) fail('不该弹出图列表');
    const ir = input.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (Math.abs(ir.left - br.left) > 6 || Math.abs(ir.top - br.top) > 6) fail('编辑框没盖在按钮上');
    input.value = '按钮自检';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(320);
    if (ws.graphs().find((g) => g.id === gid).name !== '按钮自检') fail('改名没生效');
    if (document.querySelector('.inline-edit')) fail('提交后编辑框没消失');
    ws.renameGraph(gid, before);
    await f.saveNow();
    await wait(150);
    return before + ' → 按钮自检（盖在按钮上改）';
  });

  await run('图重命名就在原地改，不弹窗', async () => {
    const gid = ws.graphId;
    const before = ws.graph().name;
    document.getElementById('graphBtn').click();
    await wait(240);
    const pop = document.getElementById('popover');
    const first = pop.querySelector('.item');
    const fr = first.getBoundingClientRect();
    first.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(fr.left + 8), clientY: Math.round(fr.top + 8),
    }));
    await wait(240);
    const sub = document.getElementById('submenu');
    const rename = [...sub.querySelectorAll('.item')].find((el) => el.textContent.includes('重命名'));
    if (!rename) fail('没有重命名这一项');
    rename.click();
    await wait(280);
    const input = document.querySelector('.inline-edit');
    if (!input) fail('没有出现原地编辑框');
    if (document.activeElement !== input) fail('编辑框没有拿到焦点');
    if (input.value !== before) fail('编辑框里不是现在的名字：' + input.value);
    if (document.querySelector('.overlay:not([hidden])')) fail('还是弹了模态框');
    input.value = '自检改名';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(320);
    if (ws.graphs().find((g) => g.id === gid).name !== '自检改名') fail('改名没生效');
    if (document.querySelector('.inline-edit')) fail('提交后编辑框没消失');
    // 还原
    ws.renameGraph(gid, before);
    await f.saveNow();
    await wait(150);
    return before + ' → 自检改名（原地）';
  });

  await run('右键图列表里的某一项：主菜单不消失，旁边弹出这张图的菜单', async () => {
    const btn = document.getElementById('graphBtn');
    btn.click();                       // 左键打开图列表
    await wait(240);
    const pop = document.getElementById('popover');
    if (!pop || pop.hidden) fail('图列表没打开');
    const labels = [...pop.querySelectorAll('.item')].map((el) => el.textContent.trim());
    if (labels.some((t) => t.includes('重命名这张图'))) fail('列表底部还留着「重命名这张图」');
    if (labels.some((t) => t.includes('删除这张图'))) fail('列表底部还留着「删除这张图」');
    const first = pop.querySelector('.item');
    const fr = first.getBoundingClientRect();
    first.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(fr.left + 10), clientY: Math.round(fr.top + 10),
    }));
    await wait(260);
    // 主菜单必须还在
    if (pop.hidden) fail('弹出二级菜单时主菜单消失了');
    if (!pop.querySelector('.item')) fail('主菜单内容被清空了');
    // 二级菜单：正好两项
    const sub = document.getElementById('submenu');
    if (!sub || sub.hidden) fail('右键没有弹出这张图的菜单');
    const ctx = [...sub.querySelectorAll('.item')].map((el) => el.textContent.trim());
    if (ctx.length !== 2) fail('右键菜单项不对：' + ctx.join(' / '));
    if (!ctx[0].includes('重命名')) fail('第一项不是重命名：' + ctx[0]);
    if (!ctx[1].includes('删除')) fail('第二项不是删除：' + ctx[1]);
    // 二级菜单在主菜单右边
    if (sub.getBoundingClientRect().left < pop.getBoundingClientRect().right - 2) {
      fail('二级菜单没在主菜单旁边');
    }
    closePopoverForTest();
    await wait(150);
    if (!sub.hidden) fail('点外面后二级菜单没关掉');
    return '列表 ' + labels.length + ' 项仍在，右键菜单：' + ctx.join(' / ');
  });

  await run('右键图的按钮弹出「重命名 / 删除」菜单', async () => {
    const btn = document.getElementById('graphBtn');
    if (!btn) fail('找不到图的按钮');
    const r = btn.getBoundingClientRect();
    btn.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 20), clientY: Math.round(r.bottom + 6),
    }));
    await wait(240);
    const pop = document.getElementById('popover');
    if (!pop || pop.hidden) fail('右键没有弹出菜单');
    const items = [...pop.querySelectorAll('.item')].map((el) => el.textContent.trim());
    if (items.length !== 2) fail('菜单项数量不对：' + items.join(' / '));
    if (!items[0].includes('重命名')) fail('第一项不是重命名：' + items[0]);
    if (!items[1].includes('删除')) fail('第二项不是删除：' + items[1]);
    closePopoverForTest();
    await wait(150);
    return items.join(' / ');
  });

  await run('跨块选中后按 Delete，删掉的是全部选中内容且不会复活', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 5);
    f.selectNote(note.id);
    await wait(360);
    const txts = [...document.querySelectorAll('#preview .blk-txt')].filter((t) => (t.textContent || '').trim());
    if (txts.length < 3) fail('块不够');
    const before = { blocks: f.pane._blocks.length, len: ws.note(note.id).content.length };
    const a = txts[0].firstChild || txts[0];
    const c = txts[2].firstChild || txts[2];
    const range = document.createRange();
    range.setStart(a, 2);
    range.setEnd(c, Math.max(1, (c.nodeValue || '').length - 2));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await wait(150);
    const picked = sel.toString().length;
    if (!picked) fail('没有选区');

    txts[0].closest('.blk').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await wait(360);
    const after = { blocks: f.pane._blocks.length, len: ws.note(note.id).content.length };
    if (after.len >= before.len) fail('内容没有变少：' + before.len + ' → ' + after.len);
    if (after.blocks !== before.blocks - 2) fail('块数不对：' + before.blocks + ' → ' + after.blocks);

    // 切走再切回：删掉的内容不能复活
    const other = ws.notesOf().find((n) => n.id !== note.id);
    f.selectNote(other.id);
    await wait(200);
    f.selectNote(note.id);
    await wait(300);
    if (ws.note(note.id).content.length !== after.len) fail('删掉的内容又回来了');
    // 收尾：撤销回去，别影响后面的用例
    f.pane.undoNote();
    await wait(200);
    return '选中 ' + picked + ' 字 → 删除：' + before.len + ' → ' + after.len + ' 字，' + before.blocks + ' → ' + after.blocks + ' 块';
  });

  await run('选完之后不会被"松手后的 click"清掉', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 4);
    f.selectNote(note.id);
    await wait(320);
    const txts = [...document.querySelectorAll('#preview .blk-txt')].filter((t) => (t.textContent || '').trim());
    const a = txts[0].firstChild || txts[0];
    const c = txts[2].firstChild || txts[2];
    const range = document.createRange();
    range.setStart(a, 3);
    range.setEnd(c, 5);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const before = sel.toString().length;
    if (!before) fail('没有选区');

    // 1) 松手后的 click 落在某一块上
    const blk = txts[0].closest('.blk');
    const r = blk.getBoundingClientRect();
    blk.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Math.round(r.left + 16), clientY: Math.round(r.top + 8) }));

    // 2) 松手后的 click 落在正文空白处（#preview 本身）
    const prev = document.getElementById('preview');
    const pr = prev.getBoundingClientRect();
    prev.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: Math.round(pr.left + pr.width / 2),
      clientY: Math.round(pr.bottom - 6),
    }));
    await wait(260);
    const after = window.getSelection().toString().length;
    if (after !== before) fail('选区被清掉了：' + before + ' → ' + after);
    return '两种落点都不影响：仍选中 ' + after + ' 字';
  });

  await run('跨块拖拽 = 原生选区，复制拿到完整内容', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 4);
    f.selectNote(note.id);
    await wait(320);
    const txts = [...document.querySelectorAll('#preview .blk-txt')].filter((t) => (t.textContent || '').trim());
    if (txts.length < 3) fail('块不够');
    const first = txts[0].firstChild || txts[0];
    const third = txts[2].firstChild || txts[2];
    const range = document.createRange();
    range.setStart(first, Math.min(5, (first.nodeValue || '').length));
    range.setEnd(third, Math.min(6, (third.nodeValue || '').length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await wait(150);
    const picked = sel.toString();
    if (!picked || !picked.includes('\n')) fail('原生选区没跨块');
    const copied = f.pane.selectedText();
    if (!copied) fail('复制内容为空');
    if (copied.length < picked.length) fail('复制内容和选区不一致');
    return '原生选区 ' + picked.length + ' 字，复制得 ' + copied.length + ' 字';
  });

await run('只选一块也能右键（选中不会被清掉）', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 4);
    f.selectNote(note.id);
    await wait(320);
    const blk = document.querySelector('#preview .blk[data-i="2"]');
    const r = blk.getBoundingClientRect();
    const x = Math.round(r.left + 12);
    const y = Math.round(r.top + 8);
    blk.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, shiftKey: true }));
    blk.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, shiftKey: true }));
    blk.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, shiftKey: true }));
    await wait(260);
    if (!f.pane._sel.size) fail('Shift 点击没有选中');

    // 真实右键：pointerdown(右键) → pointerup → contextmenu
    blk.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 2, buttons: 2 }));
    blk.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 2 }));
    blk.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await wait(280);
    if (!f.pane._sel.size) fail('右键之后选中被清掉了');
    if (!document.querySelector('#preview .blk.sel')) fail('选中高亮没了');
    const menu = document.querySelector('.blk-menu');
    if (!menu) fail('右键没有菜单');
    const del = [...menu.querySelectorAll('button')].find((b) => b.dataset.act === 'del');
    if (!del) fail('菜单里没有"删除选中"');
    return '单选 → 右键 → 仍可删除，选中数 ' + f.pane._sel.size;
  });

  await run('Shift 点块可以多选，右键整体删除', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 4);
    f.selectNote(note.id);
    await wait(320);
    const blockOf = (i) => document.querySelector('#preview .blk[data-i="' + i + '"]');
    const click = (i, mods = {}) => {
      const blk = blockOf(i);
      const r = blk.getBoundingClientRect();
      blk.dispatchEvent(new MouseEvent('click', Object.assign({
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 12), clientY: Math.round(r.top + 8),
      }, mods)));
    };
    click(1);
    await wait(200);
    click(3, { shiftKey: true });
    await wait(260);
    const sel = [...f.pane._sel].sort((a, b) => a - b);
    if (sel.join(',') !== '1,2,3') fail('Shift 选区间不对：' + sel.join(','));
    if (document.querySelectorAll('#preview .blk.sel').length !== 3) fail('选中高亮数量不对');

    const before = f.pane._blocks.length;
    const blk = blockOf(2);
    const r = blk.getBoundingClientRect();
    blk.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 8),
    }));
    await wait(260);
    const menu = document.querySelector('.blk-menu');
    if (!menu) fail('多选时右键没有菜单');
    const del = [...menu.querySelectorAll('button')].find((b) => b.dataset.act === 'del');
    if (!del) fail('多选菜单里没有删除');
    realClick(del);
    await wait(340);
    if (f.pane._blocks.length !== before - 3) {
      fail('删除块数不对：' + before + ' → ' + f.pane._blocks.length);
    }
    return '选中 3 块 → 删除，' + before + ' → ' + f.pane._blocks.length;
  });

  await run('单宿主：文字选区可以跨块（原生选区）', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 4);
    f.selectNote(note.id);
    await wait(320);
    const blocks = [...document.querySelectorAll('#preview .blk')];
    const txts = blocks.map((b) => b.querySelector('.blk-txt')).filter(Boolean);
    if (txts.length < 3) fail('块不够');
    const a = txts[0];
    const b = txts[2];
    const range = document.createRange();
    range.setStart(a.firstChild || a, 2);
    range.setEnd(b.firstChild || b, 4);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await wait(120);
    const picked = sel.toString();
    if (!picked) fail('跨块选区拿不到文字');
    if (!picked.includes('\n')) fail('选区没有跨过多个块：' + JSON.stringify(picked.slice(0, 30)));
    // 复制跟随选区
    const text = f.pane.selectedText();
    if (!text) fail('selectedText 为空');
    return '跨 3 块选区，文字 ' + picked.length + ' 字（含换行）';
  });

  await run('点正文空白处，光标落到最后一块', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(300);
    const prev = document.getElementById('preview');
    const r = prev.getBoundingClientRect();
    const lastIndex = f.pane._blocks.length - 1;
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.bottom - 8);
    const target = document.elementFromPoint(x, y) || prev;
    pointer(target, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await wait(340);
    if (f.pane._focus !== lastIndex) fail('没落到最后一块：' + f.pane._focus + ' / 最后 ' + lastIndex);
    // 单宿主：焦点在 #preview，光标位置看选区
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    const blk = el && el.closest ? el.closest('.blk') : null;
    if (!blk || Number(blk.dataset.i) !== lastIndex) {
      fail('光标不在最后一块里');
    }
    return '空白处点击 → 最后一块（第 ' + (lastIndex + 1) + ' 块）';
  });

  await run('画布按钮：临时让画布占满，再点还原', async () => {
    const body = document.getElementById('body');
    const right = document.getElementById('rightPane');
    const canvas = document.getElementById('canvas');
    const btn = document.getElementById('btnFit');
    const before = Math.round(canvas.getBoundingClientRect().width);
    realClick(btn);
    await wait(420);
    const wide = Math.round(canvas.getBoundingClientRect().width);
    if (getComputedStyle(right).display !== 'none') fail('笔记栏没收起来');
    if (wide <= before + 100) fail('画布没有占满：' + before + ' → ' + wide);
    if (Math.abs(wide - body.clientWidth) > 4) fail('画布没有占满整条：' + wide + ' vs ' + body.clientWidth);
    realClick(btn);
    await wait(420);
    if (getComputedStyle(right).display === 'none') fail('再点没有还原笔记栏');
    if (Math.abs(Math.round(canvas.getBoundingClientRect().width) - before) > 4) fail('画布宽度没还原');
    return '画布 ' + before + ' → ' + wide + ' → ' + Math.round(canvas.getBoundingClientRect().width);
  });

  await run('画布缩放条能用（走真实指针路径）', async () => {
    const btn = document.getElementById('btnZoomIn');
    if (!btn) fail('没有缩放条');
    const r = btn.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const target = document.elementFromPoint(x, y) || btn;
    if (target !== btn) fail('缩放条被别的东西盖住了：' + (target.className || target.id));
    const before = f.canvas.zoom;
    pointer(target, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await wait(260);
    if (f.canvas._drag) fail('按缩放条被当成了画布拖拽');
    if (!(f.canvas.zoom > before)) fail('点 ＋ 没有放大画布');
    // 再点 − 缩回来
    const zoomed = f.canvas.zoom;
    const out = document.getElementById('btnZoomOut');
    const or = out.getBoundingClientRect();
    const ox = Math.round(or.left + or.width / 2);
    const oy = Math.round(or.top + or.height / 2);
    const outTarget = document.elementFromPoint(ox, oy) || out;
    pointer(outTarget, 'pointerdown', ox, oy);
    pointer(window, 'pointerup', ox, oy);
    outTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ox, clientY: oy }));
    await wait(260);
    if (!(f.canvas.zoom < zoomed)) fail('点 − 没有缩小画布');
    const pct = (n) => Math.round(n * 100) + '%';
    return '缩放 ' + pct(before) + ' → ' + pct(zoomed) + ' → ' + pct(f.canvas.zoom);
  });

  await run('字数并进底部状态栏的字号那一栏，改了会跟着变', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(320);
    if (document.getElementById('noteMeta')) fail('右栏底部那条字数栏还在');
    const right = document.getElementById('statusRight');
    const text = right.textContent.trim();
    if (!/^字号 \d+% · [\d,]+ 字$/.test(text)) fail('状态栏格式不对：' + JSON.stringify(text));
    const before = Number(text.split('·')[1].replace(/[^\d]/g, ''));
    // 写点东西 → 字数变多
    f.pane.focusBlock(0, 'end');
    await wait(220);
    const ed = activeEditor();
    if (!ed) fail('没有光标');
    setBlockText(ed, (ed.textContent || '') + ' 一二三四五六七八九十');
    await wait(360);
    const after = Number(right.textContent.split('·')[1].replace(/[^\d]/g, ''));
    if (!(after > before)) fail(`字数没更新：${before} → ${after}`);
    return `状态栏「${right.textContent.trim()}」（${before} → ${after}）`;
  });

  await run('焦点在笔记里，单键快捷键不会作用到画布', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(240);
    f.pane.focusBlock(0, 'end');
    await wait(240);
    const ed = activeEditor();
    if (!ed) fail('没有光标');
    const before = ws.notesOf().length;
    const sel = ws.state.selected;
    const scale = ws.state.zoom;

    // Del：不能删画布上的笔记（更不能弹删除确认框）
    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    ed.dispatchEvent(del);
    await wait(260);
    if (ws.notesOf().length !== before) fail('在笔记里按 Del 删掉了画布笔记');
    if (ws.state.selected !== sel) fail('按 Del 改了画布选中项');
    if (del.defaultPrevented) fail('Del 在笔记里不该被全局拦截');

    // f：不能触发画布"适应窗口"
    const fkey = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
    ed.dispatchEvent(fkey);
    await wait(220);
    if (Math.abs((ws.state.zoom || 1) - (scale || 1)) > 1e-6) fail('在笔记里按 f 把画布缩放了');
    if (fkey.defaultPrevented) fail('字母键在笔记里被全局拦截了');

    // 焦点回到画布后，Del 依然好用
    canvasEl.focus();
    await wait(150);
    if (document.activeElement !== canvasEl && !canvasEl.contains(document.activeElement)) {
      fail('焦点没能回到画布');
    }
    return 'Del / f 只在画布获得焦点时生效';
  });

  await run('笔记里 Ctrl+Z / Ctrl+Y 能撤销和重做', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(240);
    const content = () => ws.note(note.id).content;
    const original = content();
    f.pane.focusBlock(0, 'end');
    await wait(220);
    let ed = activeEditor();
    if (!ed) fail('没有光标');
    const marker = '撤销测试 ' + Date.now();
    setBlockText(ed, marker + ' ' + (ed.textContent || ''));
    await wait(300);
    if (!content().includes(marker)) fail('写入没生效');
    // Ctrl+Z：目标是正文块，应该撤掉这次输入
    ed = activeEditor();
    ed.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true,
    }));
    await wait(320);
    if (content().includes(marker)) fail('Ctrl+Z 没有撤销掉刚才的输入');
    if (content() !== original) fail('撤销后内容不是原文');
    // Ctrl+Y：重做回来
    const ed2 = activeEditor() || document.querySelector('#preview .blk-txt');
    ed2.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'y', ctrlKey: true, bubbles: true,
    }));
    await wait(320);
    if (!content().includes(marker)) fail('Ctrl+Y 没有重做');
    // 收尾
    ws.note(note.id).content = original;
    f.pane.renderBlocks();
    await wait(150);
    return '撤销 / 重做都作用在笔记内容上';
  });

  await run('文本光标在深色背景上看得见', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').length > 20);
    f.selectNote(note.id);
    await wait(250);
    f.pane.focusBlock(0, 'end');
    await wait(250);
    const txt = document.querySelector('#preview .blk-txt');
    if (!txt) fail('没有可编辑的块');
    const caret = getComputedStyle(txt).caretColor;
    // 必须不是主题里的深紫 #7c3aed，且亮度够高
    const rgb = caret.match(/\d+/g);
    if (!rgb || rgb.length < 3) fail('拿不到光标颜色：' + caret);
    const [r, g, b] = rgb.map(Number);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 150) fail(`光标太暗，看不清：${caret}（亮度 ${Math.round(lum)}）`);
    // 聚焦的块还要有落点提示
    const bg = getComputedStyle(txt).backgroundColor;
    if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') fail('聚焦的块没有落点底色');
    return `光标 ${caret}（亮度 ${Math.round(lum)}）`;
  });

  await run('输入即转换 / Tab 缩进 / 上下键跨块 / 多行粘贴拆块', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(220);
    const content = () => ws.note(note.id).content;
    const original = content();

    // ① 打 "# 标题" → 直接变成标题块
    f.pane.appendBlock();
    await wait(250);
    let ed = activeEditor();
    if (!ed) fail('没有进入新块');
    setBlockText(ed, '# 自动标题');
    await wait(300);
    if (!/^# 自动标题/m.test(content())) fail('输入 "# " 没有转成标题：' + content().slice(-40));
    if (!document.querySelector('#preview .blk-h1')) fail('预览里没出现 h1 块');

    // ② 打 "- 列表" → 变成无序列表
    f.pane.appendBlock();
    await wait(250);
    ed = activeEditor();
    setBlockText(ed, '- 自动列表');
    await wait(300);
    if (!/^- 自动列表/m.test(content())) fail('输入 "- " 没有转成列表');
    if (!document.querySelector('#preview .blk-bullet')) fail('预览里没出现列表块');

    // ③ Tab 缩进这一块
    const listIndex = f.pane._blocks.findIndex((b) => b.type === 'bullet');
    if (listIndex < 0) fail('找不到列表块');
    f.pane.focusBlock(listIndex, 'end');
    await wait(200);
    ed = activeEditor();
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await wait(300);
    const indented = f.pane._blocks[listIndex];
    if (!indented || (indented.depth || 0) !== 1) fail('Tab 没有缩进：' + JSON.stringify(indented && indented.depth));

    // ④ 多行粘贴 → 拆成多块
    const beforePaste = f.pane._blocks.length;
    ed = activeEditor();
    const dt = new DataTransfer();
    dt.setData('text/plain', '粘贴第一行\n粘贴第二行\n粘贴第三行');
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(320);
    if (f.pane._blocks.length !== beforePaste + 2) {
      fail(`多行粘贴后块数 ${beforePaste} → ${f.pane._blocks.length}`);
    }
    if (!content().includes('粘贴第三行')) fail('粘贴内容没进笔记');

    // ⑤ 块尾按 ↓ → 光标移到下一块（自己定位，别依赖前面步骤留下的状态）
    const idx = 1;
    f.pane.focusBlock(idx, 'end');
    await wait(200);
    ed = activeEditor();
    if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await wait(280);
    if (f.pane._focus === idx) fail('↓ 没有跨到下一块');

    // 还原
    ws.note(note.id).content = original;
    f.pane.renderBlocks();
    await wait(150);
    return '自动转换 / 缩进 / 跨块 / 粘贴拆块 都正常';
  });

  await run('右键正文：文本编辑菜单 + 「转为」子菜单；"/" 只是普通字符', async () => {
    const note = ws.notesOf().find((n) => (n.content || '').split('\n\n').length >= 2);
    f.selectNote(note.id);
    await wait(280);
    f.pane.appendBlock();
    await wait(300);
    const ed = activeEditor();
    if (!ed) fail('空块没有光标');

    // 打 "/"：普通字符，不弹菜单
    ed.innerHTML = '/';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(220);
    if (document.querySelector('.blk-menu')) fail('打 / 还是弹菜单了');
    if (!ws.note(note.id).content.includes('/')) fail('/ 没写进内容');

    // 右键 → 文本编辑菜单
    const blk = ed.closest('.blk');
    const r = blk.getBoundingClientRect();
    blk.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 12), clientY: Math.round(r.top + 10),
    }));
    await wait(260);
    const menu = document.querySelector('.blk-menu');
    if (!menu) fail('右键没有弹出菜单');
    const acts = [...menu.querySelectorAll('button')].map((b) => b.dataset.act).filter(Boolean);
    for (const a of ['cut', 'copy', 'paste', 'select', 'type']) {
      if (!acts.includes(a)) fail('右键菜单缺少 ' + a);
    }

    // 悬停「转为」→ 子菜单
    const typeBtn = menu.querySelector('[data-act="type"]');
    typeBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(260);
    const sub = document.querySelector('.blk-menu.sub');
    if (!sub) fail('「转为」没有子菜单');
    const types = [...sub.querySelectorAll('button')].map((b) => b.dataset.type);
    for (const t of ['h1', 'h2', 'h3', 'bullet', 'num', 'task', 'quote', 'code', 'hr']) {
      if (!types.includes(t)) fail('子菜单缺少块类型 ' + t);
    }
    const h2 = [...sub.querySelectorAll('button')].find((b) => b.dataset.type === 'h2');
    realClick(h2);   // 走真实指针路径：pointerdown 会先触发"点外面"逻辑
    await wait(320);
    if (!preview.querySelector('.blk-h2')) fail('转成标题 2 没生效');
    if (document.querySelector('.blk-menu')) fail('选完菜单没关掉');
    return '剪切/复制/粘贴/全选 + 转为子菜单，" / " 正常输入';
  });

  await run('在笔记里打字不会因为失焦丢内容', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(200);
    f.pane.focusBlock(0, 'end');
    await wait(180);
    const ed = activeTA();
    if (!ed) fail('没有进入块编辑');
    const marker = '失焦保留 ' + Date.now();
    setBlockText(ed, marker + ' ' + (ed.textContent || ''));
    await wait(200);
    // 直接切到另一篇（模拟点别的卡片）
    const other = ws.notesOf().find((n) => n.id !== note.id);
    f.selectNote(other.id);
    await wait(280);
    if (!ws.note(note.id).content.includes(marker)) fail('切换笔记时内容丢了');
    return '切走也保住了';
  });

  await run('编辑内容落盘', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(200);
    const marker = 'selftest ' + Date.now();
    const ed = await openBlock(0);
    if (!ed) fail('没有进入块编辑');
    setBlockText(ed, (ed.textContent || '') + ' ' + marker);
    await f.saveNow();
    await wait(200);
    const loaded = await window.foryou.load();
    if (!loaded.notes[note.id].content.includes(marker)) fail('没有落盘');
    return '写入并读回成功';
  });

  await run('从哪条边的圆点拉线，就钉在哪条边', async () => {
    const notes = ws.notesOf();
    const src = notes[0];
    f.selectNote(src.id);
    await wait(220);
    const sides = ['e', 'w', 'n', 's'];
    const seen = [];
    for (let i = 0; i < sides.length; i += 1) {
      const target = notes.find((n) => n.id !== src.id && !ws.outgoingAttr(src).has(n.id));
      if (!target) break;
      const dot = document.querySelector('.card.selected .dot[data-side="' + sides[i] + '"]');
      if (!dot) fail('没有 ' + sides[i] + ' 边的圆点');
      const [dx, dy] = center(dot);
      pointer(dot, 'pointerdown', dx, dy);
      const used = c._drag ? c._drag.side : null;
      const [tx, ty] = center(cardOf(target.id));
      pointer(window, 'pointermove', tx, ty);
      pointer(window, 'pointerup', tx, ty);
      await wait(220);
      const pinned = ws.getSides(src.id, target.id);
      if (!used) fail(sides[i] + ' 边按下去没有开始拉线');
      if (['n', 's', 'w', 'e'].includes(used)) fail('拖拽记录的边没归一化：' + used);
      if (!pinned) fail(sides[i] + ' 边拉线后没有记录接口');
      if (pinned.from !== used) fail('钉住的边和拖出来的不一致：' + pinned.from + ' vs ' + used);
      const link = (ws.note(src.id).links || []).find((l) => l.id === target.id);
      if (!link) fail('连线没写进笔记');
      if (link.shape !== 'line') fail('新连线默认不是直线：' + link.shape);
      seen.push(sides[i] + '→' + pinned.from);
    }
    if (seen.length < 2) fail('只测到 ' + seen.length + ' 条边');
    return seen.join(' ');
  });

  await run('从手柄拉线建立属性连接', async () => {
    const notes = ws.notesOf();
    const src = notes[0];
    let dst = null;
    for (const n of notes.slice(1)) {
      if (!ws.outgoingAttr(src).has(n.id)) { dst = n; break; }
    }
    if (!dst) fail('找不到可连的卡片');
    f.selectNote(src.id);
    await wait();
    const dot = document.querySelector('.card.selected .dot[data-side="e"]');
    if (!dot) fail('没有连线圆点');
    const [dx, dy] = center(dot);
    pointer(dot, 'pointerdown', dx, dy);
    const dragKind = c._drag && c._drag.kind;
    const [tx, ty] = center(cardOf(dst.id));
    pointer(window, 'pointermove', tx, ty);
    const over = c.hitCard(tx, ty);
    const cr = c.canvasRect;
    const wpt = c.toWorld(tx - cr.left, ty - cr.top).map((v) => Math.round(v));
    const rec = c.records.get(dst.id);
    const expect = c.toScreen([rec.x + rec.w / 2, rec.y + rec.h / 2]).map((v) => Math.round(v));
    const domCenter = [Math.round(tx - cr.left), Math.round(ty - cr.top)];
    const el = cardOf(dst.id);
    const dbg = `tf=${c.world.style.transform} rect=${Math.round(c.canvasRect.width)}x${Math.round(c.canvasRect.height)} z=${c.zoom} cam=${c.cam.map((v) => Math.round(v))} rec=${[rec.x, rec.y, rec.w, rec.h].map((v) => Math.round(v))} el=${el.offsetLeft},${el.offsetTop}`;
    pointer(window, 'pointerup', tx, ty);
    await wait();
    if (!ws.outgoingAttr(ws.note(src.id)).has(dst.id)) {
      fail(`drag=${dragKind} over=${over} expect=${expect} dom=${domCenter} ${dbg}`);
    }
    return `${src.title} -> ${dst.title}`;
  });

  await run('接口定死：移动卡片不换边，可手动重新对准', async () => {
    const notes = ws.notesOf();
    let src = null;
    let dst = null;
    for (const n of notes) {
      const l = (n.links || [])[0];
      if (l && ws.note(l.id)) { src = n; dst = ws.note(l.id); break; }
    }
    if (!src) fail('没有连线可用');
    f.selectNote(src.id);
    await wait();
    const ra = c.records.get(src.id);
    const rb = c.records.get(dst.id);
    const sideOf = (d) => {
      const m = /^M ([\d.-]+) ([\d.-]+)/.exec(d || '');
      if (!m) return null;
      const x = Number(m[1]);
      const y = Number(m[2]);
      const near = (v, t) => Math.abs(v - t) < 1.5;
      if (near(x, ra.x + ra.w) && near(y, ra.y + ra.h / 2)) return 'right';
      if (near(x, ra.x) && near(y, ra.y + ra.h / 2)) return 'left';
      if (near(x, ra.x + ra.w / 2) && near(y, ra.y + ra.h)) return 'bottom';
      if (near(x, ra.x + ra.w / 2) && near(y, ra.y)) return 'top';
      return `other(${x.toFixed(0)},${y.toFixed(0)})`;
    };
    const pathOf = () => {
      const p = document.querySelector(`path.edge[data-src="${src.id}"][data-dst="${dst.id}"]`);
      return p && p.getAttribute('d');
    };
    // 摆成左右并排 → 首次渲染把接口钉成 right/left
    rb.x = ra.x + ra.w + 200;
    rb.y = ra.y;
    c.updateCardPosition(dst.id);
    f.repinLink({ src: src.id, dst: dst.id });
    await wait();
    const pinnedAt = sideOf(pathOf());
    // 真拖着它绕到下面去
    const el = document.querySelector(`.card[data-id="${dst.id}"]`);
    const r = el.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + 10;
    pointer(el, 'pointerdown', sx, sy);
    pointer(window, 'pointermove', sx - 100, sy + 320);
    await wait();
    const during = sideOf(pathOf());
    pointer(window, 'pointerup', sx - 100, sy + 320);
    await wait();
    const after = sideOf(pathOf());
    // 手动"重新对准"才换边
    f.repinLink({ src: src.id, dst: dst.id });
    await wait();
    const repinned = sideOf(pathOf());
    if (pinnedAt !== 'right') fail(`初始应为 right，实为 ${pinnedAt}`);
    if (during !== 'right') fail(`拖动中应该定死在 right，实为 ${during}`);
    if (after !== 'right') fail(`松手后应该仍是 right，实为 ${after}`);
    if (repinned !== 'bottom') fail(`重新对准后应为 bottom，实为 ${repinned}`);
    return `right -> 拖动仍 right -> 松手仍 right -> 重新对准 bottom`;
  });

  await run('接口定死会存进 app.json', async () => {
    await f.saveNow();
    await wait(200);
    const loaded = await window.foryou.load();
    const g = loaded.state.graphs.find((x) => x.id === ws.graphId);
    const keys = g && g.sides ? Object.keys(g.sides) : [];
    if (!keys.length) fail('sides 没写进 app.json');
    const entry = g.sides[keys[0]];
    if (!Array.isArray(entry) || entry.length !== 2) fail('sides 格式不对: ' + JSON.stringify(entry));
    return `${keys.length} 条接口记录，示例 ${keys[0]} = ${entry.join('/')}`;
  });

  await run('右栏填满窗口（空笔记也不能缩成一条）', async () => {
    // 新建一篇空笔记：内容为空时最容易暴露"右栏缩水"的问题
    f.newNote();
    await wait(150);
    const note = ws.note(ws.state.selected);
    if (!note) fail('没有新建成功');
    if ((note.content || '').length !== 0) fail('新笔记不是空的');
    ws.note(ws.state.selected).content = '';
    f.pane.renderBlocks();
    await wait(200);
    const pane = document.getElementById('rightPane').getBoundingClientRect();
    const winW = window.innerWidth;
    const gap = Math.round(winW - pane.right);
    if (Math.abs(gap) > 2) fail(`右栏右侧还空着 ${gap}px（宽 ${Math.round(pane.width)}）`);
    if (pane.width < 300) fail(`右栏只有 ${Math.round(pane.width)}px 宽`);
    f.undo();
    await wait(120);
    return `右栏 ${Math.round(pane.width)}px，右边缘间隙 ${gap}px`;
  });

  await run('新建笔记落在光标所指的位置', async () => {
    const emptyPoint = () => {
      const r = canvasEl.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.88], [0.15, 0.85], [0.85, 0.12], [0.2, 0.2], [0.1, 0.5]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (!c.hitCard(x, y)) return [x, y];
      }
      return null;
    };
    const pt = emptyPoint();
    if (!pt) fail('找不到空白位置');
    const r = canvasEl.getBoundingClientRect();
    const world = c.toWorld(pt[0] - r.left, pt[1] - r.top);

    // ① 右键空白 → 「在这里新建笔记」
    canvasEl.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: pt[0], clientY: pt[1],
    }));
    await wait(160);
    const rows = [...document.getElementById('popover').querySelectorAll('.item')];
    const item = rows.find((x) => x.textContent.includes('在这里新建笔记'));
    if (!item) fail('右键菜单里没有「在这里新建笔记」');
    item.click();
    await wait(300);
    let note = ws.note(ws.state.selected);
    if (!note) fail('新建后没有选中新笔记');
    let rec = c.records.get(note.id);
    let d = Math.hypot(rec.x + rec.w / 2 - world[0], rec.y + rec.h / 2 - world[1]);
    if (d > 6) fail(`右键新建偏离光标 ${d.toFixed(1)}px（卡片中心 ${Math.round(rec.x + rec.w / 2)},${Math.round(rec.y + rec.h / 2)} / 光标 ${Math.round(world[0])},${Math.round(world[1])}）`);

    // ② 鼠标移到别处，Ctrl+N 也要落在鼠标那儿
    const pt2 = [pt[0] - 60, pt[1] - 40];
    const world2 = c.toWorld(pt2[0] - r.left, pt2[1] - r.top);
    canvasEl.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: pt2[0], clientY: pt2[1], pointerId: 1,
    }));
    await wait(80);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    await wait(300);
    const note2 = ws.note(ws.state.selected);
    if (!note2 || note2.id === note.id) fail('Ctrl+N 没新建出笔记');
    const rec2 = c.records.get(note2.id);
    const d2 = Math.hypot(rec2.x + rec2.w / 2 - world2[0], rec2.y + rec2.h / 2 - world2[1]);
    if (d2 > 6) fail(`Ctrl+N 偏离鼠标 ${d2.toFixed(1)}px`);

    f.undo();
    f.undo();
    await wait(150);
    return `右键新建偏差 ${d.toFixed(1)}px，Ctrl+N 偏差 ${d2.toFixed(1)}px`;
  });

  await run('标题删空后不会弹回旧标题，能接着输入', async () => {
    f.newNote();
    await wait(350);
    const note = ws.note(ws.state.selected);
    if (!note) fail('没有新建成功');
    const title = document.getElementById('noteTitle');
    if (document.activeElement !== title) fail('新笔记没有把焦点放到标题上');
    const old = note.title;
    // 全选删空
    title.value = '';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(800);                       // 远超过 500ms 的防抖
    if (title.value !== '') fail(`删空后旧标题被写回来了：「${title.value}」`);
    if (ws.note(note.id).title !== old) fail('删空期间不该改笔记标题');
    // 继续输入新标题
    title.value = '负载均衡';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(800);
    if (ws.note(note.id).title !== '负载均衡') fail('新标题没写进笔记：' + ws.note(note.id).title);
    if (title.value !== '负载均衡') fail('输入框被改写了：' + title.value);
    // 空着切走再切回来：标题仍然是被认下来的那个（输入框会按笔记内容刷新）
    title.value = '';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    const other = ws.notesOf().find((n) => n.id !== note.id);
    if (other) {
      f.selectNote(other.id);
      await wait(200);
      f.selectNote(note.id);
      await wait(250);
    } else {
      f.selectNote(note.id);
      await wait(250);
    }
    if (ws.note(note.id).title !== '负载均衡') fail('空着切走时笔记标题被改了');
    if (title.value !== '负载均衡') fail('切回来标题不对：' + title.value);
    f.undo();
    await wait(150);
    return '删空不弹回 → 能输入新标题 → 切走切回标题还在';
  });

  await run('工具条 ＋ 从这篇新建并链接', async () => {
    const src = ws.notesOf()[0];
    f.selectNote(src.id);
    await wait(200);
    const before = ws.notesOf().length;
    document.getElementById('toolNew').click();
    await wait(300);
    if (ws.notesOf().length !== before + 1) fail('没有新建笔记');
    const created = ws.note(ws.state.selected);
    if (!created || created.id === src.id) fail('新建后没选中新笔记');
    if (!ws.outgoingAttr(ws.note(src.id)).has(created.id)) fail('没有自动连上源笔记');
    const a = c.records.get(src.id);
    const b = c.records.get(created.id);
    if (!b) fail('新卡片没有记录');
    if (b.x < a.x + a.w) fail('新卡片没有摆在源卡片右边');
    f.undo();
    await wait(150);
    return `新卡片在源卡片右侧 +${Math.round(b.x - (a.x + a.w))}px`;
  });

  await run('右键卡片不切换选中的笔记', async () => {
    const cards = [...document.querySelectorAll('.card')];
    if (cards.length < 2) fail('卡片不够');
    const a = cards[0];
    const b = cards[1];
    f.selectNote(a.dataset.id);
    await wait(220);
    if (c.selected !== a.dataset.id) fail('先选中 A 失败');
    const paneBefore = f.pane.note ? f.pane.note.id : null;

    // ① 正常右键 B：菜单要弹，但选中和右栏都不许变
    const rb = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: rb.left + rb.width / 2, clientY: rb.top + 12,
    }));
    await wait(240);
    if (document.getElementById('popover').hidden) fail('右键没弹菜单');
    if (c.selected !== a.dataset.id) fail(`右键 B 之后选中被改了：${c.selected}`);
    if ((f.pane.note ? f.pane.note.id : null) !== paneBefore) fail('右键 B 之后右栏被换了');
    const menuForB = [...document.querySelectorAll('#popover .item')]
      .some((x) => x.textContent.includes('删除这篇笔记'));
    if (!menuForB) fail('弹出的不是卡片的右键菜单');
    const ctxMarked = document.querySelectorAll('.card.ctx').length;
    if (ctxMarked !== 1) fail('右键提示高亮数量 = ' + ctxMarked);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(140);

    // ② 落点被浮层接走（事件派发到画布元素、坐标压在 B 上）→ 仍然只弹 B 的菜单，选中不动
    canvasEl.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: rb.left + rb.width / 2, clientY: rb.top + 12,
    }));
    await wait(240);
    const stillB = [...document.querySelectorAll('#popover .item')]
      .some((x) => x.textContent.includes('删除这篇笔记'));
    if (!stillB) fail('浮层挡住时没弹卡片菜单');
    if (c.selected !== a.dataset.id) fail('浮层挡住右键时选中被改了');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(140);
    return '右键只开菜单，选中保持 ' + ws.note(c.selected).title;
  });

  await run('点空白取消选中：右栏保留上一篇笔记', async () => {
    const first = ws.notesOf()[0];
    f.selectNote(first.id, false);
    await wait(120);
    if (c.selected !== first.id) fail('先选中都失败了');
    const titleShown = document.getElementById('noteTitle').value;
    pointer(canvasEl, 'pointerdown', 8, 8);
    pointer(window, 'pointerup', 8, 8);
    await wait(180);
    if (c.selected !== null) fail('点空白后还选着');
    if (ws.state.selected !== null) fail('state.selected 没清空');
    // 取消选中不清空右栏：应该还在看刚才那一篇
    if (!f.pane.note || f.pane.note.id !== first.id) fail('右栏没有保留上一篇笔记');
    if (!document.getElementById('emptyHint').hidden) fail('右栏被清成空态了');
    if (document.getElementById('noteTitle').value !== titleShown) fail('标题被清掉了');
    if (!document.querySelectorAll('#preview .blk').length) fail('正文被清掉了');
    const bar = document.getElementById('nodeToolbar');
    if (!bar.hidden) fail('工具条还挂着');
    return '选中清空，右栏仍显示上一篇';
  });

  await run('取消选中后，右栏那篇会记进 app.json', async () => {
    const first = ws.notesOf()[0];
    f.selectNote(first.id);
    await wait(180);
    pointer(canvasEl, 'pointerdown', 8, 8);
    pointer(window, 'pointerup', 8, 8);
    await wait(250);
    if (c.selected !== null) fail('没有取消选中');
    if (!f.pane.note || f.pane.note.id !== first.id) fail('右栏没保留上一篇');
    await f.saveNow();
    await wait(200);
    const loaded = await window.foryou.load();
    const g = loaded.state.graphs.find((x) => x.id === ws.graphId);
    if (!g) fail('找不到当前图的状态');
    if (loaded.state.selected !== null) fail('selected 应该是 null');
    if (g.last_note !== first.id) fail('last_note 没写进 app.json');
    return '画板不指任何笔记时，右栏这篇记在 last_note 里';
  });

  await run('拖空白平移时不取消选中', async () => {
    const first = ws.notesOf()[0];
    f.selectNote(first.id, false);
    await wait(100);
    pointer(canvasEl, 'pointerdown', 20, 20);
    pointer(window, 'pointermove', 120, 90);
    pointer(window, 'pointerup', 120, 90);
    await wait(120);
    if (c.selected !== first.id) fail('平移把选中弄丢了');
    f.canvas.fit();
    await wait(80);
    return '平移保留选中';
  });

  await run('再点卡片能重新选中', async () => {
    const card = document.querySelector('.card');
    const [x, y] = center(card);
    pointer(card, 'pointerdown', x, y);
    pointer(window, 'pointerup', x, y);
    await wait(120);
    if (!c.selected) fail('点卡片没选上');
    return `重新选中 ${ws.note(c.selected).title}`;
  });

  await run('拖四角改卡片尺寸', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait();
    const h = document.querySelector('.card.selected .handle[data-corner="se"]');
    if (!h) fail('没有尺寸手柄');
    const rec = c.records.get(note.id);
    const w0 = rec.w;
    const h0 = rec.h;
    const [hx, hy] = center(h);
    pointer(h, 'pointerdown', hx, hy);
    pointer(window, 'pointermove', hx + 70, hy + 50);
    pointer(window, 'pointerup', hx + 70, hy + 50);
    await wait();
    if (!(rec.w > w0 + 30 && rec.h > h0 + 20)) fail(`尺寸没变 ${w0}x${h0} -> ${rec.w}x${rec.h}`);
    const grown = `${Math.round(w0)}x${Math.round(h0)} -> ${Math.round(rec.w)}x${Math.round(rec.h)}`;
    // 再往小拖：能小过以前 220x80 的下限
    const [h2x, h2y] = center(h);
    pointer(h, 'pointerdown', h2x, h2y);
    pointer(window, 'pointermove', h2x - 400, h2y - 400);
    pointer(window, 'pointerup', h2x - 400, h2y - 400);
    await wait();
    if (!(rec.w <= 140 && rec.h <= 60)) fail(`卡片的尺寸下限还是太大：${Math.round(rec.w)}x${Math.round(rec.h)}`);
    return grown + `，再缩到 ${Math.round(rec.w)}x${Math.round(rec.h)}`;
  });

  await run('点连线弹出上方工具栏，能调线宽和箭头大小', async () => {
    const notes = ws.notesOf();
    const a = notes[0];
    const b = notes.find((n) => n.id !== a.id);
    ws.addLink(a.id, b.id);
    ws.setLinkStyle(a.id, b.id, { shape: 'line', arrow: 'solid', width: 2, arrowSize: 6 });
    c.renderEdges();
    await wait(280);
    const hit = document.querySelector('path.hit[data-hitsrc="' + a.id + '"][data-hitdst="' + b.id + '"]');
    if (!hit) fail('找不到这条连线');
    const r = hit.getBoundingClientRect();
    pointer(hit, 'pointerdown', Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    await wait(300);
    const tb = document.getElementById('linkToolbar');
    if (!tb || tb.hidden) fail('点连线没有弹出工具栏');
    const rect = tb.getBoundingClientRect();
    const path = document.querySelector('path.edge[data-src="' + a.id + '"][data-dst="' + b.id + '"]');
    if (!path) fail('找不到这条线的 path');
    // 工具栏必须在"连线中点"的正上方、并且水平居中
    const ra2 = c.records.get(a.id);
    const rb2 = c.records.get(b.id);
    const canvasBox = document.getElementById('canvas').getBoundingClientRect();
    const ma = c.toScreen([ra2.x + ra2.w / 2, ra2.y + ra2.h / 2]);
    const mb = c.toScreen([rb2.x + rb2.w / 2, rb2.y + rb2.h / 2]);
    const midX = (ma[0] + mb[0]) / 2 + canvasBox.left;
    const midY = (ma[1] + mb[1]) / 2 + canvasBox.top;
    if (rect.bottom > midY + 4) fail('工具栏没在连线上方：' + Math.round(rect.bottom) + ' vs ' + Math.round(midY));
    if (Math.abs(rect.left + rect.width / 2 - midX) > 60) fail('工具栏没对准连线中点');
    const link = () => ws.note(a.id).links.find((l) => l.id === b.id);
    // 每次重画都会换掉 path 节点，取最新的那个
    const edge = () => document.querySelector('path.edge[data-src="' + a.id + '"][data-dst="' + b.id + '"]');
    if (link().width !== 2) fail('初始线宽不是 2');
    realClick(document.getElementById('linkSizeUp'));
    realClick(document.getElementById('linkSizeUp'));
    await wait(280);
    if (link().width !== 3) fail('线宽没跟着档位变：' + link().width);

    const p1 = edge();
    if (!p1) fail('连线节点不见了');
    if (p1.getAttribute('stroke-width') !== '3') fail('线宽没画到 path 上：' + p1.getAttribute('stroke-width'));
    await wait(120);
    // 同一档位把箭头一起带上去（2 档 = 箭头 6；4 档 = 箭头 12）
    if (link().arrowSize !== 10) fail('箭头没跟着档位变：' + link().arrowSize);
    const marker = (edge() || { getAttribute: () => '' }).getAttribute('marker-end') || '';
    if (!marker.includes('-10')) fail('箭头 marker 没换尺寸：' + marker);
    if (document.getElementById('linkSizeVal').textContent !== '4') fail('档位数字没同步');
    // 收起
    c.selectedLink = null;
    placeToolbarForTest();
    await wait(150);
    return '工具栏在线条上方，档位 2→4（线宽 2→3、箭头 6→10）';
  });

  await run('连线样式可改', async () => {
    const src = ws.notesOf().find((n) => (n.links || []).length);
    if (!src) fail('没有连线');
    const dst = src.links[0].id;
    f.setLinkShape({ src: src.id, dst }, 'line');
    await wait();
    f.setLinkArrow({ src: src.id, dst }, 'hollow');
    await wait();
    const link = ws.note(src.id).links.find((l) => l.id === dst);
    if (link.shape !== 'line' || link.arrow !== 'hollow') fail(`${link.shape}/${link.arrow}`);
    return '直线 + 空心箭头';
  });

  await run('工具条上的「标记」给卡片打待办，再点取消', async () => {
    const note = ws.notesOf()[0];
    f.selectNote(note.id);
    await wait(260);
    const btn = document.getElementById('toolTodo');
    if (!btn) fail('工具条上没有标记按钮');
    const card = () => document.querySelector('.card[data-id="' + note.id + '"]');
    if (!card()) fail('找不到卡片');
    if (card().querySelector('.card-mark')) fail('一开始就有待办标记');
    realClick(btn);
    await wait(300);
    if (!card().querySelector('.card-mark')) fail('点了标记但没出现待办图标');
    if (!ws.note(note.id).todo) fail('数据里没记上 todo');
    realClick(btn);
    await wait(300);
    if (card().querySelector('.card-mark')) fail('再点一次标记没消失');
    if (ws.note(note.id).todo) fail('数据里的 todo 没清掉');
    return '标记 → 出现 ☑ → 再点消失';
  });

  await run('选中卡片浮出工具条', async () => {
    const note = ws.notesOf()[1] || ws.notesOf()[0];
    f.selectNote(note.id);
    await wait();
    const bar = document.getElementById('nodeToolbar');
    const rect = c.screenRectOf(note.id);
    if (bar.hidden) fail('工具条没出现');
    const cx = parseFloat(bar.style.left) + bar.offsetWidth / 2;
    if (Math.abs(cx - (rect.x + rect.w / 2)) > 40) fail('工具条没对准卡片');
    return '位置正确';
  });

  await run('右键卡片弹出菜单', async () => {
    const card = $('.card');
    const [x, y] = center(card);
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
    await wait();
    const pop = document.getElementById('popover');
    const shown = !pop.hidden && pop.querySelectorAll('.item').length >= 2;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait();
    if (!shown) fail('菜单没出来');
    return '菜单可见';
  });

  await run('点阵背景', async () => {
    const bg = getComputedStyle(canvasEl).backgroundImage;
    if (!bg.includes('radial-gradient')) fail(bg);
    return 'CSS 点阵';
  });

  await run('拖分栏后比例记下来，重启还是同一个比例', async () => {
    const body = document.getElementById('body');
    const left = document.getElementById('leftPane');
    const splitter = document.getElementById('splitter');
    const before = left.getBoundingClientRect().width;
    const target = Math.round(body.clientWidth * 0.36);
    const dx = target - before;
    const r = splitter.getBoundingClientRect();
    const sx = r.left + 3;
    const sy = r.top + 40;
    splitter.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: sx, clientY: sy, pointerId: 1, button: 0,
    }));
    splitter.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: sx + dx, clientY: sy, pointerId: 1,
    }));
    splitter.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: sx + dx, clientY: sy, pointerId: 1,
    }));
    await wait(500);
    const ratio = +(left.getBoundingClientRect().width / body.clientWidth).toFixed(3);
    if (Math.abs(ratio - ws.state.split) > 0.02) fail(`比例没写进 state：${ratio} vs ${ws.state.split}`);
    if (Math.abs(ratio - 0.36) > 0.05) fail(`拖完比例不对：${ratio}`);
    // 落盘 + 读回
    await f.saveNow();
    await wait(200);
    const loaded = await window.foryou.load();
    const saved = loaded.state.split || 0;
    if (Math.abs(saved - ws.state.split) > 0.005) fail(`比例没落盘：${saved} vs ${ws.state.split}`);
    // 用读回来的比例重算一次，应该和屏幕上的一致
    const again = Math.round(body.clientWidth * saved) / body.clientWidth;
    if (Math.abs(again - ratio) > 0.03) fail(`重开后比例会变：${again} vs ${ratio}`);
    return `比例 ${saved}（${Math.round(ratio * 100)}%）已记住`;
  });

  await run('重启后恢复视图', async () => {
    const st = { split: ws.state.split, zoom: ws.state.zoom, sel: ws.state.selected };
    await f.saveNow();
    await wait(150);
    const loaded = await window.foryou.load();
    if (Math.abs((loaded.state.split || 0.5) - st.split) > 0.01) fail('分栏没存');
    if (Math.abs((loaded.state.zoom || 1) - st.zoom) > 0.01) fail('字号没存');
    if (loaded.state.selected !== st.sel) fail('选中项没存');
    return '分栏 / 字号 / 选中项都在';
  });

  return out;
})();
