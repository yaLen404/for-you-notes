import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import storeModule from '../main/store.js';

const { Store, normalizeState } = storeModule;

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-test-')), 'data');
}

function sample() {
  const state = normalizeState({}, {});
  const notes = {
    n1: { id: 'n1', title: '甲', content: '见 [[乙]]', color: '#fb464c',
      created: 1, updated: 1, graph: state.graphs[0].id, links: [] },
    n2: { id: 'n2', title: '乙', content: '', color: '',
      created: 2, updated: 2, graph: state.graphs[0].id,
      links: [{ id: 'n1', shape: 'line', arrow: 'none' }] },
  };
  return { state, notes };
}

test('存盘 / 读盘往返', () => {
  const dir = tmpDir();
  const { state, notes } = sample();
  const store = new Store(dir);
  store.saveAll(state, notes);
  const again = new Store(dir).load();
  assert.deepEqual(Object.keys(again.notes).sort(), ['n1', 'n2']);
  assert.equal(again.notes.n2.links[0].shape, 'line');
  assert.equal(again.notes.n2.links[0].arrow, 'none');
});

test('写入不留临时文件', () => {
  const dir = tmpDir();
  const { state, notes } = sample();
  const store = new Store(dir);
  store.saveAll(state, notes);
  const files = fs.readdirSync(path.join(dir, 'notes'));
  assert.ok(files.every((f) => !f.startsWith('.tmp-')));
});

test('备份去重 + 只留最近 30 份', () => {
  const dir = tmpDir();
  const { state, notes } = sample();
  const store = new Store(dir);
  const first = store.backup(state, notes, 'test', true);
  assert.ok(first && fs.existsSync(first));
  assert.equal(store.backup(state, notes, 'test', false), null);
  for (let i = 0; i < 40; i += 1) {
    notes.n1.content = 'x' + i;
    store.backup(state, notes, 'test', true);
  }
  assert.ok(store.backups().length <= 30, store.backups().length);
});

test('旧数据目录迁移（只复制不删）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-legacy-'));
  const legacy = path.join(base, 'legacy');
  fs.mkdirSync(path.join(legacy, 'notes'), { recursive: true });
  const { notes } = sample();
  fs.writeFileSync(path.join(legacy, 'notes', 'n1.json'), JSON.stringify(notes.n1));

  const store = new Store(path.join(base, 'new'));
  assert.equal(store.migrateLegacy(legacy), true);
  assert.ok(fs.existsSync(path.join(legacy, 'notes', 'n1.json')), '旧目录不能被删');
  const again = new Store(path.join(base, 'new')).load();
  assert.ok(again.notes.n1);
});

test('兼容旧的 links 字符串数组', () => {
  const dir = tmpDir();
  const { state, notes } = sample();
  notes.n1.links = ['n2'];
  const store = new Store(dir);
  store.saveAll(state, notes);
  const again = new Store(dir).load();
  assert.deepEqual(again.notes.n1.links, [{ id: 'n2', shape: 'line', arrow: 'solid', width: 2, arrowSize: 6 }]);
});

test('状态里保留"右栏上次看的笔记"', () => {
  const state = normalizeState({
    graph_id: 'g1',
    graphs: [{ id: 'g1', last_note: 'n1' }],
  }, {});
  assert.equal(state.graphs[0].last_note, 'n1');
  // 没有这个字段时给 null，不炸
  const plain = normalizeState({ graph_id: 'g2', graphs: [{ id: 'g2' }] }, {});
  assert.equal(plain.graphs[0].last_note, null);
});
