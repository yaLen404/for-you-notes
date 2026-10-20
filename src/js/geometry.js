/** 画板几何：四边中点锚点、二次贝塞尔、箭头、命中测试。
 *
 * 契约（历史对话里定死的）：
 *  · 连线两端只能落在卡片的四个边中点；
 *  · 不论缩放到多少，箭头尖端都贴在边框上。
 * 做法：锚点在世界坐标里就定义在边框上，渲染只做一次相似变换。
 */

export const TOP = 'top';
export const RIGHT = 'right';
export const BOTTOM = 'bottom';
export const LEFT = 'left';
export const SIDES = [TOP, RIGHT, BOTTOM, LEFT];
export const SHAPE_CURVE = 'curve';
export const SHAPE_LINE = 'line';
export const ARROW_SOLID = 'solid';
export const ARROW_HOLLOW = 'hollow';
export const ARROW_NONE = 'none';

export function rect(x, y, w, h) {
  return { x, y, w, h };
}

export const cx = (r) => r.x + r.w / 2;
export const cy = (r) => r.y + r.h / 2;
export const right = (r) => r.x + r.w;
export const bottom = (r) => r.y + r.h;

export function anchor(r, side) {
  switch (side) {
    case TOP: return [cx(r), r.y];
    case BOTTOM: return [cx(r), bottom(r)];
    case LEFT: return [r.x, cy(r)];
    default: return [right(r), cy(r)];
  }
}

/** 两张卡片互相面对的那条边。
 *
 * 用**矩形间隙**判定，而不是"中心点谁更偏"：只要两个框还是左右并排
 * （水平间隙 ≥ 垂直间隙）就走左右边，一交叉立刻翻成上下边。
 * 中心点判定的问题是斜着放时要拖很久才翻边，看起来像"接口不会变"。
 */
export function facingSides(a, b) {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX >= gapY) {
    return b.x + b.w / 2 >= a.x + a.w / 2 ? [RIGHT, LEFT] : [LEFT, RIGHT];
  }
  return b.y + b.h / 2 >= a.y + a.h / 2 ? [BOTTOM, TOP] : [TOP, BOTTOM];
}

export function unit(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? [0, -1] : [dx / len, dy / len];
}

export function quadAt(p0, c, p2, t) {
  const mt = 1 - t;
  return [
    mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p2[0],
    mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p2[1],
  ];
}

/** 一条连线的几何。
 *
 * sides 给定（{from, to}）时**用定死的接口**：连接时选好哪条边就一直用那条边，
 * 卡片移动、改尺寸都不换（这是需求：接口要定死）。
 * 没给 sides 时才按当前几何算一对。
 */
export function linkPath(a, b, shape = SHAPE_LINE, sides = null) {
  const [autoA, autoB] = facingSides(a, b);
  const sideA = sides && sides.from ? sides.from : autoA;
  const sideB = sides && sides.to ? sides.to : autoB;
  const start = anchor(a, sideA);
  const end = anchor(b, sideB);
  if (shape === SHAPE_LINE) {
    return {
      start, end, ctrl: null, sideA, sideB, shape,
      d: `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`,
      endDir: unit(end[0] - start[0], end[1] - start[1]),
      mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
    };
  }
  const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const k = Math.max(14, Math.min(78, len * 0.16));
  const [ux, uy] = unit(end[0] - start[0], end[1] - start[1]);
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const ctrl = [mid[0] - uy * k, mid[1] + ux * k];
  return {
    start, end, ctrl, sideA, sideB, shape,
    d: `M ${start[0]} ${start[1]} Q ${ctrl[0]} ${ctrl[1]} ${end[0]} ${end[1]}`,
    endDir: unit(end[0] - ctrl[0], end[1] - ctrl[1]),
    mid: quadAt(start, ctrl, end, 0.5),
  };
}

export function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const seg2 = vx * vx + vy * vy;
  if (seg2 <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * vx + (py - ay) * vy) / seg2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 采样二次贝塞尔，用于连线的命中测试 */
export function sampleCurve(start, ctrl, end, n = 16) {
  const pts = [];
  for (let i = 0; i < n; i += 1) pts.push(quadAt(start, ctrl, end, i / (n - 1)));
  return pts;
}

export function polylineDistance(points, px, py) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const d = pointSegDist(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

export function onBorder(r, p, tol = 0.75) {
  const [x, y] = p;
  if (x < r.x - tol || x > right(r) + tol || y < r.y - tol || y > bottom(r) + tol) return false;
  return Math.abs(x - r.x) <= tol || Math.abs(x - right(r)) <= tol ||
         Math.abs(y - r.y) <= tol || Math.abs(y - bottom(r)) <= tol;
}

export function isSideMidpoint(r, p, tol = 0.75) {
  return SIDES.some((s) => {
    const a = anchor(r, s);
    return Math.hypot(a[0] - p[0], a[1] - p[1]) <= tol;
  });
}
