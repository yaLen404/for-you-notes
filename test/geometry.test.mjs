import test from 'node:test';
import assert from 'node:assert';

import * as G from '../src/js/geometry.js';

const rect = (x, y, w, h) => ({ x, y, w, h });

test('连线两端只能是四边中点', () => {
  const a = rect(0, 0, 200, 60);
  const b = rect(400, 260, 180, 70);
  for (const shape of [G.SHAPE_CURVE, G.SHAPE_LINE]) {
    const path = G.linkPath(a, b, shape);
    assert.ok(G.isSideMidpoint(a, path.start), '起点不在中点');
    assert.ok(G.isSideMidpoint(b, path.end), '终点不在中点');
  }
});

test('任意缩放下两端都贴在边框上', () => {
  const a = rect(-120, -30, 200, 60);
  const b = rect(260, 180, 180, 70);
  for (const zoom of [0.25, 0.5, 1, 1.7, 2.6]) {
    for (const cam of [[0, 0], [-40, 15]]) {
      const path = G.linkPath(a, b, G.SHAPE_CURVE);
      const sr = (r) => rect((r.x + cam[0]) * zoom + 600, (r.y + cam[1]) * zoom + 400,
        r.w * zoom, r.h * zoom);
      const toS = (p) => [(p[0] + cam[0]) * zoom + 600, (p[1] + cam[1]) * zoom + 400];
      assert.ok(G.onBorder(sr(a), toS(path.start), 0.01), `起点 zoom=${zoom}`);
      assert.ok(G.onBorder(sr(b), toS(path.end), 0.01), `终点 zoom=${zoom}`);
    }
  }
});

test('命中测试：折线距离', () => {
  const path = G.linkPath(rect(0, 0, 200, 60), rect(600, 0, 200, 60), G.SHAPE_LINE);
  const pts = [path.start, path.end];
  assert.ok(G.polylineDistance(pts, 400, 30) < 1);
  assert.ok(G.polylineDistance(pts, 400, 200) > 100);
});

test('面对方向：主方向决定用哪条边', () => {
  assert.deepEqual(G.facingSides(rect(0, 0, 100, 40), rect(400, 0, 100, 40)),
    [G.RIGHT, G.LEFT]);
  assert.deepEqual(G.facingSides(rect(0, 0, 100, 40), rect(0, 400, 100, 40)),
    [G.BOTTOM, G.TOP]);
  assert.deepEqual(G.facingSides(rect(400, 0, 100, 40), rect(0, 0, 100, 40)),
    [G.LEFT, G.RIGHT]);
});

test('接口定死：给了 sides 就不按几何走', () => {
  const a = rect(0, 0, 200, 100);
  const b = rect(600, 0, 200, 100); // 正常情况下会自动选 right/left
  const auto = G.linkPath(a, b, G.SHAPE_LINE);
  assert.deepEqual(auto.start, [200, 50]);
  assert.deepEqual(auto.end, [600, 50]);

  const pinned = G.linkPath(a, b, G.SHAPE_LINE, { from: G.BOTTOM, to: G.TOP });
  assert.deepEqual(pinned.start, [100, 100]); // a 的下边中点
  assert.deepEqual(pinned.end, [700, 0]);     // b 的上边中点

  // 端点仍然只在四边中点上，且贴在边框
  assert.ok(G.isSideMidpoint(a, pinned.start));
  assert.ok(G.isSideMidpoint(b, pinned.end));
  assert.ok(G.onBorder(a, pinned.start, 0.01));
  assert.ok(G.onBorder(b, pinned.end, 0.01));
});

test('侧边判定按矩形间隙：一交叉就翻边', () => {
  const a = rect(0, 0, 200, 100);
  // 左右并排
  assert.deepEqual(G.facingSides(a, rect(300, 0, 200, 100)), [G.RIGHT, G.LEFT]);
  // 水平方向还贴着（间隙 60），垂直已经拉开（间隙 80）→ 底下那一侧
  assert.deepEqual(G.facingSides(a, rect(-260, 180, 200, 100)), [G.BOTTOM, G.TOP]);
  // 换回左右：垂直方向重叠，水平有间隙
  assert.deepEqual(G.facingSides(a, rect(-260, 30, 200, 40)), [G.LEFT, G.RIGHT]);
  // 正上方
  assert.deepEqual(G.facingSides(a, rect(0, -300, 200, 100)), [G.TOP, G.BOTTOM]);
});
