import test from 'node:test';
import assert from 'node:assert';

import { Workspace } from '../src/js/workspace.js';
import { normalizeState } from '../main/store.js';

function makeWorkspace() {
  const state = normalizeState({}, {});
  return new Workspace(state, {});
}

test('画布连接与正文链接取并集', () => {
  const ws = makeWorkspace();
  const a = ws.createNote({ title: 'A', content: '见 [[B]]' });
  const b = ws.createNote({ title: 'B' });
  const c = ws.createNote({ title: 'C' });
  ws.addLink(a.id, c.id);
  assert.deepEqual(new Set(ws.outgoing(a).keys()), new Set([b.id, c.id]));
  assert.deepEqual(ws.missingTitles(a), []);
});

test('图片嵌入不算笔记链接', () => {
  const ws = makeWorkspace();
  const a = ws.createNote({ title: 'A', content: '看图 ![[img-1.png]] 和 [[B]]' });
  const b = ws.createNote({ title: 'B' });
  assert.deepEqual([...ws.outgoing(a).keys()], [b.id]);
  assert.deepEqual(ws.missingTitles(a), []);
});

test('缺失的链接会被点名', () => {
  const ws = makeWorkspace();
  const a = ws.createNote({ title: 'A', content: '见 [[还没写]]' });
  assert.deepEqual(ws.missingTitles(a), ['还没写']);
});

test('改标题级联更新别处的 [[链接]]', () => {
  const ws = makeWorkspace();
  const a = ws.createNote({ title: '旧' });
  const b = ws.createNote({ title: 'B', content: '参见 [[旧]]' });
  ws.renameNote(a.id, '新');
  assert.match(b.content, /\[\[新\]\]/);
  assert.doesNotMatch(b.content, /\[\[旧\]\]/);
});

test('删笔记：清掉属性连接，保留正文链接', () => {
  const ws = makeWorkspace();
  const a = ws.createNote({ title: 'A', content: '看 [[B]]' });
  const b = ws.createNote({ title: 'B' });
  ws.addLink(a.id, b.id);
  ws.deleteNote(b.id);
  assert.equal(a.links.length, 0);
  assert.match(a.content, /\[\[B\]\]/);
});

test('撤销 / 重做', () => {
  const ws = makeWorkspace();
  ws.pushUndo();
  const n = ws.createNote({ title: 'X' });
  assert.equal(ws.notesOf().length, 1);
  ws.undo();
  assert.equal(ws.notesOf().length, 0);
  ws.redo();
  assert.equal(ws.notesOf().length, 1);
  assert.ok(ws.notes[n.id]);
});

test('孤岛统计', () => {
  const ws = makeWorkspace();
  ws.createNote({ title: 'A', content: '[[B]]' });
  ws.createNote({ title: 'B' });
  ws.createNote({ title: '孤' });
  assert.deepEqual(ws.islands().map((n) => n.title), ['孤']);
});

test('多图隔离', () => {
  const ws = makeWorkspace();
  ws.createNote({ title: 'A' });
  const g2 = ws.addGraph('第二张');
  assert.equal(ws.notesOf().length, 0);
  ws.createNote({ title: 'B' });
  ws.switchGraph(ws.graphs()[0].id);
  assert.deepEqual(ws.notesOf().map((n) => n.title), ['A']);
  assert.ok(g2.id);
});

test('标题自动编号', () => {
  const ws = makeWorkspace();
  const a = ws.createNote();
  const b = ws.createNote();
  assert.equal(a.title, '新笔记');
  assert.equal(b.title, '新笔记 2');
});
