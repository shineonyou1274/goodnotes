// 획(stroke) 기하: 압력에 따른 두께, 외곽선 Path2D, 영역 계산, 지우개 판정, 도형 인식
// 획의 점은 [x, y, 압력, x, y, 압력, ...] 형태의 Float32Array로 저장한다.

const pathCache = new WeakMap();
const boundsCache = new WeakMap();

export function radiusAt(item, p) {
  if (item.constant) return item.width / 2;
  // 압력 0.5일 때 기본 두께, 0~1 범위에서 0.4배~1.6배
  return (item.width * (0.4 + 1.2 * p)) / 2;
}

function signedArea(xs, ys) {
  let a = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return a;
}

// 원(각 점)과 원 사이를 잇는 사다리꼴을 합쳐서 매끄러운 가변 두께 획을 만든다.
// 모든 도형을 같은 방향(시계 방향)으로 그려서 nonzero 채우기가 합집합이 되도록 한다.
function buildVariablePath(item) {
  const pts = item.pts;
  const n = pts.length / 3;
  const path = new Path2D();
  const rs = new Float32Array(n);
  for (let i = 0; i < n; i++) rs[i] = radiusAt(item, pts[i * 3 + 2]);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], r = rs[i];
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2, false);
  }
  const xs = [0, 0, 0, 0], ys = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 3], ay = pts[i * 3 + 1], bx = pts[i * 3 + 3], by = pts[i * 3 + 4];
    const r1 = rs[i], r2 = rs[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len <= Math.abs(r1 - r2) + 1e-4) continue; // 한 원이 다른 원을 덮음
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const s = (r1 - r2) / len;
    const c = Math.sqrt(Math.max(0, 1 - s * s));
    const m1x = ux * s + nx * c, m1y = uy * s + ny * c;
    const m2x = ux * s - nx * c, m2y = uy * s - ny * c;
    xs[0] = ax + r1 * m1x; ys[0] = ay + r1 * m1y;
    xs[1] = bx + r2 * m1x; ys[1] = by + r2 * m1y;
    xs[2] = bx + r2 * m2x; ys[2] = by + r2 * m2y;
    xs[3] = ax + r1 * m2x; ys[3] = ay + r1 * m2y;
    if (signedArea(xs, ys) < 0) {
      path.moveTo(xs[3], ys[3]); path.lineTo(xs[2], ys[2]); path.lineTo(xs[1], ys[1]); path.lineTo(xs[0], ys[0]);
    } else {
      path.moveTo(xs[0], ys[0]); path.lineTo(xs[1], ys[1]); path.lineTo(xs[2], ys[2]); path.lineTo(xs[3], ys[3]);
    }
    path.closePath();
  }
  return path;
}

function buildPolyline(item) {
  const pts = item.pts;
  const path = new Path2D();
  path.moveTo(pts[0], pts[1]);
  if (pts.length === 3) path.lineTo(pts[0] + 0.01, pts[1]);
  for (let i = 3; i < pts.length; i += 3) path.lineTo(pts[i], pts[i + 1]);
  if (item.closed) path.closePath();
  return path;
}

export function isPolylineStroke(item) {
  return item.tool === 'highlighter' || item.constant;
}

export function strokePath(item) {
  let p = pathCache.get(item);
  if (!p) {
    p = isPolylineStroke(item) ? buildPolyline(item) : buildVariablePath(item);
    pathCache.set(item, p);
  }
  return p;
}

export function drawStroke(ctx, item) {
  const path = strokePath(item);
  if (item.tool === 'highlighter') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();
  } else if (item.constant) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else {
    ctx.fillStyle = item.color;
    ctx.fill(path);
  }
}

// 그리는 중인 획을 조금씩 이어 그릴 때 사용 (불투명 펜 전용)
export function drawStrokeSegment(ctx, item, from) {
  const pts = item.pts;
  const n = pts.length / 3;
  const start = Math.max(0, from - 1);
  const sub = { width: item.width, constant: item.constant, pts: pts.subarray(start * 3, n * 3) };
  if (sub.pts.length === 0) return;
  ctx.fillStyle = item.color;
  if (item.constant) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(buildPolyline(sub));
  } else {
    ctx.fill(buildVariablePath(sub));
  }
}

export function itemBounds(item) {
  let b = boundsCache.get(item);
  if (b) return b;
  if (item.type === 'stroke') {
    const pts = item.pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const r = item.tool === 'highlighter' ? item.width / 2 : radiusAt(item, pts[i + 2]);
      if (r > maxR) maxR = r;
    }
    b = { x: minX - maxR, y: minY - maxR, w: maxX - minX + 2 * maxR, h: maxY - minY + 2 * maxR };
  } else if (item.type === 'text') {
    b = { x: item.x, y: item.y, w: item.w, h: item.h || item.size * 1.4 };
  } else {
    b = { x: item.x, y: item.y, w: item.w, h: item.h };
  }
  boundsCache.set(item, b);
  return b;
}

export function setBounds(item, b) { boundsCache.set(item, b); }

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

function strokeHalfWidth(item, p) {
  return item.tool === 'highlighter' ? item.width / 2 : radiusAt(item, p);
}

export function strokeHitsCircle(item, cx, cy, r) {
  const b = itemBounds(item);
  if (cx + r < b.x || cx - r > b.x + b.w || cy + r < b.y || cy - r > b.y + b.h) return false;
  const pts = item.pts;
  const n = pts.length / 3;
  if (n === 1) {
    const rr = r + strokeHalfWidth(item, pts[2]);
    return (pts[0] - cx) ** 2 + (pts[1] - cy) ** 2 <= rr * rr;
  }
  for (let i = 0; i < n - 1; i++) {
    const rr = r + strokeHalfWidth(item, pts[i * 3 + 2]);
    if (distToSegSq(cx, cy, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 3], pts[i * 3 + 4]) <= rr * rr) return true;
  }
  return false;
}

// 부분 지우개: 원 안에 들어간 부분을 잘라내고 남은 조각들을 새 획으로 돌려준다.
// 맞지 않으면 null을 돌려준다.
export function eraseFromStroke(item, cx, cy, r, newId) {
  if (!strokeHitsCircle(item, cx, cy, r)) return null;
  const pts = item.pts;
  const n = pts.length / 3;
  const step = Math.max(r / 3, 0.75);
  // 점 사이를 촘촘하게 채운다
  const dense = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], p = pts[i * 3 + 2];
    if (i > 0) {
      const px = pts[i * 3 - 3], py = pts[i * 3 - 2], pp = pts[i * 3 - 1];
      const d = Math.hypot(x - px, y - py);
      const k = Math.floor(d / step);
      for (let j = 1; j < k; j++) {
        const t = j / k;
        dense.push(px + (x - px) * t, py + (y - py) * t, pp + (p - pp) * t);
      }
    }
    dense.push(x, y, p);
  }
  const pieces = [];
  let cur = [];
  for (let i = 0; i < dense.length; i += 3) {
    const x = dense[i], y = dense[i + 1];
    const rr = r + strokeHalfWidth(item, dense[i + 2]) * 0.5;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) {
      if (cur.length) { pieces.push(cur); cur = []; }
    } else {
      cur.push(x, y, dense[i + 2]);
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces
    .filter((pc) => pc.length >= 6)
    .map((pc) => ({ ...item, id: newId(), pts: new Float32Array(pc), closed: false }));
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function itemInLasso(item, poly) {
  if (item.type === 'stroke') {
    const pts = item.pts;
    let inside = 0, total = 0;
    const stride = Math.max(1, Math.floor(pts.length / 3 / 60)) * 3;
    for (let i = 0; i < pts.length; i += stride) {
      total++;
      if (pointInPolygon(pts[i], pts[i + 1], poly)) inside++;
    }
    return total > 0 && inside / total >= 0.5;
  }
  const b = itemBounds(item);
  return pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, poly);
}

// 이동·확대 변환을 적용한 새 항목을 만든다 (원본은 바꾸지 않는다)
export function transformItem(item, dx, dy, s = 1, ox = 0, oy = 0) {
  const tx = (x) => ox + (x - ox) * s + dx;
  const ty = (y) => oy + (y - oy) * s + dy;
  if (item.type === 'stroke') {
    const pts = new Float32Array(item.pts.length);
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = tx(item.pts[i]);
      pts[i + 1] = ty(item.pts[i + 1]);
      pts[i + 2] = item.pts[i + 2];
    }
    return { ...item, pts, width: item.width * s };
  }
  if (item.type === 'text') {
    return { ...item, x: tx(item.x), y: ty(item.y), w: item.w * s, size: item.size * s, h: item.h ? item.h * s : item.h };
  }
  return { ...item, x: tx(item.x), y: ty(item.y), w: item.w * s, h: item.h * s };
}

export function unionBounds(items) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const b = itemBounds(it);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ---------- 도형 인식 ---------- */

function simplify(points, tol) {
  // Douglas–Peucker. points: [[x,y],...]
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegSq(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// 획을 직선·원·사각형·삼각형 등으로 바꿔 준다. 인식하지 못하면 null.
export function recognizeShape(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 3) pts.push([flat[i], flat[i + 1]]);
  if (pts.length < 3) return null;
  let len = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i) len += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX, h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < 12) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);

  // 직선
  let maxDev = 0;
  for (const [x, y] of pts) maxDev = Math.max(maxDev, Math.sqrt(distToSegSq(x, y, first[0], first[1], last[0], last[1])));
  if (gap > 0.8 * len && maxDev < Math.max(6, gap * 0.06)) {
    let [x1, y1] = first, [x2, y2] = last;
    // 수평·수직에 가까우면 맞춰 준다
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(ang - snap) < 0.07) {
      const L = Math.hypot(x2 - x1, y2 - y1);
      x2 = x1 + Math.cos(snap) * L; y2 = y1 + Math.sin(snap) * L;
    }
    return { kind: 'line', points: [[x1, y1], [x2, y2]], closed: false };
  }

  const closed = gap < Math.max(0.25 * diag, 18);
  if (!closed) {
    const poly = simplify(pts, diag * 0.06);
    if (poly.length <= 4 && poly.length >= 3) return { kind: 'polyline', points: poly, closed: false };
    return null;
  }

  // 타원 오차
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2 || 1, ry = h / 2 || 1;
  let ellErr = 0;
  for (const [x, y] of pts) ellErr += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  ellErr /= pts.length;

  const ring = pts.slice();
  ring.push(first);
  let poly = simplify(ring, diag * 0.07);
  if (poly.length > 1) {
    const a = poly[0], b = poly[poly.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < diag * 0.15) poly = poly.slice(0, -1);
  }
  // 거의 일직선인 꼭짓점 제거
  if (poly.length > 3) {
    poly = poly.filter((p, i) => {
      const a = poly[(i - 1 + poly.length) % poly.length], c = poly[(i + 1) % poly.length];
      const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [c[0] - p[0], c[1] - p[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
      return cos < 0.94;
    });
  }

  if (ellErr < 0.09 || (poly.length > 5 && ellErr < 0.2)) {
    const out = [];
    const N = 72;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    return { kind: 'ellipse', points: out, closed: true };
  }
  if (poly.length === 4) {
    // 축에 거의 맞는 사각형은 반듯하게
    const axis = poly.every((p, i) => {
      const q = poly[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
      return ang < 0.15 || ang > Math.PI / 2 - 0.15;
    });
    if (axis) return { kind: 'rect', points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], closed: true };
    return { kind: 'polygon', points: poly, closed: true };
  }
  if (poly.length === 3 || poly.length === 5) return { kind: 'polygon', points: poly, closed: true };
  return null;
}
