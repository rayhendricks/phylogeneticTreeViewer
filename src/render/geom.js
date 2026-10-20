/* Geometry helpers: an SVG path builder that tracks its bounding box, and shape generators. */

export const DEG = Math.PI / 180;
export const r2 = v => Math.round(v * 100) / 100;
export const polar = (r, a) => [r * Math.cos(a * DEG), r * Math.sin(a * DEG)];

export class Path {
  constructor() { this.d = ''; this.x0 = Infinity; this.y0 = Infinity; this.x1 = -Infinity; this.y1 = -Infinity; this.n = 0; }
  ext(x, y) {
    if (x < this.x0) this.x0 = x; if (x > this.x1) this.x1 = x;
    if (y < this.y0) this.y0 = y; if (y > this.y1) this.y1 = y;
  }
  M(x, y) { this.d += `M${r2(x)},${r2(y)}`; this.ext(x, y); this.cx = x; this.cy = y; this.n++; return this; }
  L(x, y) { this.d += `L${r2(x)},${r2(y)}`; this.ext(x, y); this.cx = x; this.cy = y; return this; }
  H(x) { this.d += `H${r2(x)}`; this.ext(x, this.cy); this.cx = x; return this; }
  V(y) { this.d += `V${r2(y)}`; this.ext(this.cx, y); this.cy = y; return this; }
  Z() { this.d += 'Z'; return this; }
  C(x1, y1, x2, y2, x, y) {
    this.d += `C${r2(x1)},${r2(y1)} ${r2(x2)},${r2(y2)} ${r2(x)},${r2(y)}`;
    this.ext(x1, y1); this.ext(x2, y2); this.ext(x, y); this.cx = x; this.cy = y; return this;
  }
  // Arc around the origin at radius r from angle a0 (current point) to a1, in degrees.
  arc(r, a0, a1) {
    const [x, y] = polar(r, a1);
    if (r <= 0 || Math.abs(a1 - a0) < 1e-9) return this.L(x, y);
    if (Math.abs(a1 - a0) >= 359.99) {
      const mid = a0 + (a1 - a0) / 2;
      return this.arc(r, a0, mid).arc(r, mid, a1);
    }
    this.d += `A${r2(r)},${r2(r)} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${r2(x)},${r2(y)}`;
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    for (let q = Math.ceil(lo / 90) * 90; q <= hi; q += 90) this.ext(...polar(r, q));
    this.ext(x, y); this.cx = x; this.cy = y;
    return this;
  }
  circle(cx, cy, r) {
    this.d += `M${r2(cx - r)},${r2(cy)}a${r2(r)},${r2(r)} 0 1 0 ${r2(2 * r)},0a${r2(r)},${r2(r)} 0 1 0 ${r2(-2 * r)},0Z`;
    this.ext(cx - r, cy - r); this.ext(cx + r, cy + r); this.n++;
    return this;
  }
  rect(x, y, w, h) { return this.M(x, y).H(x + w).V(y + h).H(x).Z(); }
  poly(pts) { pts.forEach((p, i) => (i ? this.L(p[0], p[1]) : this.M(p[0], p[1]))); return this.Z(); }
  sector(r0, r1, a0, a1) {
    this.M(...polar(r0, a0)).L(...polar(r1, a0)).arc(r1, a0, a1).L(...polar(r0, a1));
    if (r0 > 0) this.arc(r0, a1, a0);
    return this.Z();
  }
  get box() { return [this.x0, this.y0, this.x1, this.y1]; }
}

// iTOL shape codes: 1 square, 2 circle, 3 star, 4 right triangle, 5 left triangle, 6 check mark.
// Returns { path, strokeOnly }.
export function shapePath(code, cx, cy, size, p = new Path()) {
  const h = size / 2;
  switch (+code) {
    case 1: p.rect(cx - h, cy - h, size, size); break;
    case 3: {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? h * 0.45 : h, a = -90 + i * 36;
        pts.push([cx + r * Math.cos(a * DEG), cy + r * Math.sin(a * DEG)]);
      }
      p.poly(pts); break;
    }
    case 4: p.poly([[cx - h, cy - h], [cx + h, cy], [cx - h, cy + h]]); break;
    case 5: p.poly([[cx + h, cy - h], [cx - h, cy], [cx + h, cy + h]]); break;
    case 6: p.M(cx - h, cy).L(cx - h * 0.2, cy + h * 0.8).L(cx + h, cy - h); return { path: p, strokeOnly: true };
    default: p.circle(cx, cy, h);
  }
  return { path: p, strokeOnly: false };
}

// Protein domain outlines in unit space: u in [0,1] along the protein, v in [-1,1] across.
const ELLIPSE = Array.from({ length: 20 }, (_, i) => {
  const t = (i / 20) * 2 * Math.PI;
  return [0.5 + 0.5 * Math.cos(t), Math.sin(t)];
});
export const DOMAIN_SHAPES = {
  RE: [[0, -1], [1, -1], [1, 1], [0, 1]],
  EL: ELLIPSE,
  DI: [[0, 0], [0.5, -1], [1, 0], [0.5, 1]],
  HH: [[0, 0], [0.15, -1], [0.85, -1], [1, 0], [0.85, 1], [0.15, 1]],
  HV: [[0, -0.5], [0.5, -1], [1, -0.5], [1, 0.5], [0.5, 1], [0, 0.5]],
  TR: [[0, -1], [1, 0], [0, 1]],
  TL: [[1, -1], [0, 0], [1, 1]],
  PR: [[0, -1], [0.7, -1], [1, 0], [0.7, 1], [0, 1]],
  PL: [[1, -1], [0.3, -1], [0, 0], [0.3, 1], [1, 1]],
  PU: [[0, 1], [0, -0.4], [0.5, -1], [1, -0.4], [1, 1]],
  PD: [[0, -1], [0, 0.4], [0.5, 1], [1, 0.4], [1, -1]],
  OC: [[0, -0.4], [0.3, -1], [0.7, -1], [1, -0.4], [1, 0.4], [0.7, 1], [0.3, 1], [0, 0.4]],
};

// Corners of a text label's background box, for rotated labels.
export function labelBox(x, y, rot, flipEnd, w, h) {
  const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
  const x0 = flipEnd ? -w + 2 : -2, x1 = flipEnd ? 2 : w + 2;
  return [[x0, -h / 2], [x1, -h / 2], [x1, h / 2], [x0, h / 2]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

// Any iTOL legend/symbol code: 1-6 symbols, 7-9 lines (solid, dashed, dotted), 10-12 arrows, or a domain code.
// Returns { path, strokeOnly, dash }.
export function glyph(code, cx, cy, size, p = new Path()) {
  const h = size / 2;
  if (typeof code === 'string' && !/^\d+$/.test(code)) {
    const pts = DOMAIN_SHAPES[code] || DOMAIN_SHAPES.RE;
    p.poly(pts.map(([u, v]) => [cx - h + u * size, cy + v * h * 0.8]));
    return { path: p, strokeOnly: false };
  }
  const c = +code;
  if (c >= 7 && c <= 9) {
    p.M(cx - h, cy).L(cx + h, cy);
    return { path: p, strokeOnly: true, dash: c === 8 ? [size / 4, size / 6] : c === 9 ? [1, size / 6] : null };
  }
  if (c >= 10 && c <= 12) {
    const a = h * 0.6;
    p.M(cx - h, cy).L(cx + h, cy);
    if (c === 10 || c === 12) p.M(cx - h + a, cy - a).L(cx - h, cy).L(cx - h + a, cy + a);
    if (c === 11 || c === 12) p.M(cx + h - a, cy - a).L(cx + h, cy).L(cx + h - a, cy + a);
    return { path: p, strokeOnly: true };
  }
  return shapePath(c, cx, cy, size, p);
}
