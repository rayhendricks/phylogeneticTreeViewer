/* Scene builder: turns a tree + settings + datasets into a flat list of drawing primitives.
   The same scene is painted on a canvas (interactive view) and serialised to SVG (export).

   Primitive kinds:
     p  path      { d, box, fill?, stroke?, lw?, dash?, alpha?, cap?, grad? }   fill/stroke 'grad' uses grad {x0,y0,x1,y1,stops}
     t  text      { x, y, rot, text, size, bold, italic, anchor, fill, font?, outline?, alpha?, box }
     r  rich text { x, y, rot, anchor, w, size, runs: [{ text, w, size, bold, italic, color, dx, dy, font }], box }
     i  image     { url, x, y, w, h, rot, box }            (centered at x, y)
     a  alignment { x, w, rowH, ys, rows: [seq|null], len, scheme, uniform, box }
     g  gradient  { x, y, w, h, stops, box }                (legend color bar)
*/
import * as Tree from '../core/tree.js';
import { computeLayout, equalAngle, equalDaylight, niceStep } from '../core/layout.js';
import { safeColor, ramp, RAMPS } from './color.js';
import { Path, DEG, polar, shapePath, labelBox, glyph } from './geom.js';
import { fmtNum, maxOf, minOf, parseTags } from './util.js';
import { drawAligned, drawOnTree, drawRange, drawTimescale, drawConnections, drawTanglegram, isAligned } from './datasets.js';

export const SELECTION_COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#17becf'];
const BRANCH_CHUNK = 400;

export { fmtNum, parseTags };

// Map leaf name -> row for an aligned dataset. Clade ids (A|B, internal names, CONTAINS==) fan out to leaves.
export function leafMap(ds, index) {
  const map = new Map(), leafRows = [];
  for (const row of ds.rows) {
    if (row.id == null) continue;
    for (const node of Tree.resolveSpecs(index, row.id)) {
      if (!node.children.length) { leafRows.push([node.name, row]); continue; }
      for (const l of Tree.leaves(node)) if (!map.has(l.name)) map.set(l.name, row);
    }
  }
  for (const [name, row] of leafRows) map.set(name, row);
  return map;
}

function labelInfo(f, s) {
  const n = f.n, st = n.style || {};
  let text = st.displayName || n.name || '';
  if (f.collapsed) text = (text ? text + ' ' : '') + `(${f.leafCount})`;
  const ls = st.labelStyle || '';
  return {
    text, size: s.fontSize * (st.labelSize || 1), bold: ls.includes('bold'),
    italic: s.italic || ls.includes('italic'), color: st.labelColor || null, bg: st.labelBg || null,
  };
}

// MULTI_STYLE rules -> runs for a label, or null when the rules do not apply.
function multiStyleRuns(text, rules) {
  if (!rules || !text) return null;
  if (rules.include && !text.includes(rules.include)) return null;
  if (rules.exclude && text.includes(rules.exclude)) return null;
  const parts = text.split(rules.separator || ' ');
  if (rules.partsRequired && parts.length !== rules.partsRequired) return null;
  return parts.map((t, i) => {
    const r = rules.parts[i + 1] || {};
    return {
      text: t + (i < parts.length - 1 ? (rules.separator || ' ') : ''), bold: /bold/.test(r.style || ''), italic: /italic/.test(r.style || ''),
      position: r.position || 'normal', color: r.color || null, sizeFactor: r.size || 1, font: r.font || null, dx: r.dx || 0, dy: r.dy || 0,
    };
  });
}

const DASH = { dashed: [5, 4], dotted: [1, 3] };

export function buildScene(m, opt = {}) {
  const s = m.settings, th = opt.theme, measure = m.measure;
  const font = s.fontFamily;
  const L = computeLayout(m.root, s);
  const mode = s.mode;
  const circ = mode === 'circular', unr = mode === 'unrooted', rect = !circ && !unr;
  const n = L.tips.length, ny = L.ny;
  const rowH = s.spacing;
  const sx = s.treeWidth / L.maxX;
  const lw = s.lineWidth;
  const full = s.arc >= 359.5;
  const da = s.arc / (full ? ny : Math.max(ny - 1, 1));
  const ang = y => s.rotation + (full ? y + 0.5 : y) * da;
  const rad = x => s.innerRadius + x * sx;
  let usx = 1;

  if (unr) {
    equalAngle(L);
    if (s.daylight > 0) equalDaylight(L, Math.min(5, s.daylight));
    let maxR = 0;
    for (const f of L.infos) maxR = Math.max(maxR, Math.hypot(f.ux, f.uy) + (f.collapsed ? f.cx - f.x : 0));
    usx = s.treeWidth / (maxR || 1);
    for (const f of L.infos) { f.px = f.ux * usx; f.py = f.uy * usx; f.a = f.ua || 0; }
  } else {
    for (const f of L.infos) {
      if (rect) { f.px = f.x * sx; f.py = f.y * rowH; }
      else { f.a = ang(f.y); f.r = rad(f.x); [f.px, f.py] = polar(f.r, f.a); }
    }
  }
  const tipEnd = f => (f.collapsed ? f.cx : f.x);
  const endPoint = f => {
    if (rect) return [tipEnd(f) * sx, f.py];
    if (circ) return polar(rad(tipEnd(f)), f.a);
    const d = (tipEnd(f) - f.x) * usx;
    return [f.px + d * Math.cos(f.a * DEG), f.py + d * Math.sin(f.a * DEG)];
  };

  function branchPath(f, p) {
    const q = f.parent;
    if (!q) return p;
    p.M(q.px, q.py);
    if (mode === 'rectangular') {
      if (s.curved) {
        const dx = f.px - q.px, r = Math.min(Math.abs(dx), Math.abs(f.py - q.py)) * 0.9;
        return p.C(q.px, q.py + (f.py - q.py) * 0.6, q.px + r * 0.1, f.py, q.px + r, f.py).H(f.px);
      }
      return p.V(f.py).H(f.px);
    }
    if (!circ) return p.L(f.px, f.py);
    if (s.curved) {
      const c1 = polar(q.r, f.a), mid = polar(q.r + (f.r - q.r) * 0.35, f.a);
      return p.C(c1[0], c1[1], c1[0], c1[1], mid[0], mid[1]).L(f.px, f.py);
    }
    return p.arc(q.r, q.a, f.a).L(f.px, f.py);
  }

  const prims = [], back = [];
  const P = (path, style, into = prims) => { into.push({ k: 'p', d: path.d, box: path.box, ...style }); };
  const textBox = (x, y, rot, anchor, w, h) => {
    if (!rot) { const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x; return [x0, y - h / 2, x0 + w, y + h / 2]; }
    const dir = anchor === 'end' ? -1 : anchor === 'middle' ? 0 : 1;
    const c = Math.cos(rot * DEG), sn = Math.sin(rot * DEG);
    const ax = anchor === 'middle' ? x - w / 2 * c : x, ay = anchor === 'middle' ? y - w / 2 * sn : y;
    const ex = ax + (dir || 1) * w * c, ey = ay + (dir || 1) * w * sn;
    return [Math.min(ax, ex) - h / 2, Math.min(ay, ey) - h / 2, Math.max(ax, ex) + h / 2, Math.max(ay, ey) + h / 2];
  };
  // Rotation/anchor for text reading outward along angle a (flipped on the left half so it is never upside down).
  const orient = (a, anchor) => {
    if (!a) return { rot: 0, anchor };
    const flip = Math.cos(a * DEG) < 0;
    return { rot: flip ? a + 180 : a, anchor: flip ? (anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : anchor) : anchor };
  };
  function T(x, y, a, text, attrs) {
    const size = attrs.size;
    const w = measure(text, size, attrs.bold, attrs.italic, attrs.font || font);
    let { rot, anchor } = orient(a, attrs.anchor || 'start');
    if (attrs.rot != null) rot = attrs.rot;
    const prim = { k: 't', ...attrs, x, y, rot, anchor, text: String(text), box: textBox(x, y, rot, anchor, w, size * 1.2) };
    prims.push(prim);
    return prim;
  }
  // Rich text from runs {text, bold, italic, color, sizeFactor, position, font, dx, dy}.
  function R(x, y, a, runs, attrs) {
    const base = attrs.size;
    let w = 0;
    const out = runs.map(r => {
      const size = base * (r.sizeFactor || 1) * (r.position === 'normal' ? 1 : 0.7);
      const rw = measure(r.text, size, r.bold, r.italic, r.font || font);
      const dy = (r.dy || 0) + (r.position === 'superscript' ? -base * 0.35 : r.position === 'subscript' ? base * 0.3 : 0);
      w += rw;
      return { text: r.text, w: rw, size, bold: r.bold, italic: r.italic, color: r.color || attrs.fill, font: r.font, dx: r.dx || 0, dy };
    });
    let { rot, anchor } = orient(a, attrs.anchor || 'start');
    if (attrs.rot != null) rot = attrs.rot;
    const prim = { k: 'r', x, y, rot, anchor, w, size: base, runs: out, alpha: attrs.alpha, id: attrs.id, box: textBox(x, y, rot, anchor, w, base * 1.4) };
    prims.push(prim);
    return prim;
  }

  // --- search context ---
  const hits = m.hits || new Set();
  const infoOf = new Map(L.infos.map(f => [f.n, f]));
  const visibleInfo = node => {
    for (let c = node; c; c = c.parent) { const f = infoOf.get(c); if (f) return f; }
    return null;
  };
  const hitInfos = new Set(), hitPath = new Set();
  for (const id of hits) {
    const node = m.index.byId.get(id);
    const f = node && visibleInfo(node);
    if (!f) continue;
    hitInfos.add(f);
    for (let c = f; c; c = c.parent) hitPath.add(c);
  }
  const dim = hits.size > 0 && s.dimNonHits;

  // --- node metadata sources ---
  const legendBlocks = [];
  const metaRaw = (f, src) => {
    if (src === 'support') return f.n.support;
    if (src === 'length') return f.n.length;
    if (src && src.startsWith('attr:')) { const v = f.n.attrs && f.n.attrs[src.slice(5)]; return v == null ? null : v; }
    return null;
  };
  const metaNum = (f, src) => { const v = metaRaw(f, src); const x = typeof v === 'number' ? v : parseFloat(v); return isFinite(x) ? x : null; };
  const range = src => { const vals = L.infos.filter(f => f.parent).map(f => metaNum(f, src)).filter(v => v != null); return vals.length ? [minOf(vals), maxOf(vals)] : null; };

  // --- automatic branch coloring ---
  const autoColor = new Map();
  const by = s.branchColorBy || 'none';
  if (by.startsWith('cat:')) {
    const ds = (m.datasets || []).find(d => d.id === by.slice(4));
    if (ds && ds.type === 'colorstrip') {
      const map = leafMap(ds, m.index);
      for (let i = L.infos.length - 1; i >= 0; i--) {
        const f = L.infos[i];
        let c = null;
        if (f.tip) {
          const names = f.collapsed ? Tree.leaves(f.n).map(l => l.name) : [f.n.name];
          const cs = new Set(names.map(nm => (map.get(nm) || {}).color || null));
          c = cs.size === 1 ? [...cs][0] : null;
        } else {
          const cs = new Set(f.kids.map(k => autoColor.get(k) || null));
          c = cs.size === 1 ? [...cs][0] : null;
        }
        if (c) autoColor.set(f, safeColor(c));
      }
    }
  } else if (by !== 'none') {
    const rg = range(by);
    if (rg) {
      const [lo, hi] = rg;
      const stops = (RAMPS[s.branchRamp] || RAMPS.Viridis).slice();
      if (s.branchRampReverse) stops.reverse();
      const fn = ramp(stops);
      for (const f of L.infos) {
        const v = metaNum(f, by);
        if (f.parent && v != null) autoColor.set(f, fn(hi > lo ? (v - lo) / (hi - lo) : 0.5));
      }
      const title = by === 'support' ? 'Branch support' : by === 'length' ? 'Branch length' : by.slice(5);
      legendBlocks.push({ title, gradient: { stops: [0, 0.25, 0.5, 0.75, 1].map(fn), min: lo, max: hi } });
    }
  }
  const branchColorOf = f => (f.n.style && f.n.style.branchColor && safeColor(f.n.style.branchColor)) || autoColor.get(f) || null;

  // --- branch widths from metadata ---
  const wBy = s.branchWidthBy || 'none';
  const wRange = wBy !== 'none' ? range(wBy) : null;
  const branchWidthOf = f => {
    const st = f.n.style || {};
    if (wRange) {
      const v = metaNum(f, wBy);
      if (v != null) {
        const [lo, hi] = wRange;
        return s.widthMin + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (s.widthMax - s.widthMin);
      }
    }
    return st.branchWidth ? lw * st.branchWidth : lw;
  };

  // --- labels (measured first: ranges and datasets depend on their extent) ---
  const labels = [];
  let labelsEnd = rect ? L.maxX * sx : circ ? rad(L.maxX) : 0;
  const gap = 4 + (s.nodeDots ? (s.nodeSize || 3) / 2 + 1 : 0);
  if (s.showLeafLabels) {
    for (const f of L.tips) {
      const li = labelInfo(f, s);
      if (!li.text) continue;
      li.runs = multiStyleRuns(li.text, s.multiStyle) || parseTags(li.text);
      li.w = li.runs
        ? li.runs.reduce((a, r) => a + measure(r.text, li.size * (r.sizeFactor || 1) * (r.position === 'normal' ? 1 : 0.7), r.bold || li.bold, r.italic || li.italic, r.font || font), 0)
        : measure(li.text, li.size, li.bold, li.italic, font);
      const ep = endPoint(f);
      if (rect) {
        li.x = (s.alignLabels ? L.maxX * sx : ep[0]) + gap; li.y = f.py; li.a = 0;
        li.guide = s.alignLabels && ep[0] < L.maxX * sx - 1 ? [ep, [li.x - gap, li.y]] : null;
        labelsEnd = Math.max(labelsEnd, li.x + li.w);
      } else if (circ) {
        const rl = (s.alignLabels ? rad(L.maxX) : rad(tipEnd(f))) + gap;
        [li.x, li.y] = polar(rl, f.a); li.a = f.a;
        li.guide = s.alignLabels && rad(tipEnd(f)) < rad(L.maxX) - 1 ? [ep, polar(rad(L.maxX), f.a)] : null;
        labelsEnd = Math.max(labelsEnd, rl + li.w);
      } else {
        li.x = ep[0] + gap * Math.cos(f.a * DEG); li.y = ep[1] + gap * Math.sin(f.a * DEG); li.a = f.a || 1e-6;
      }
      li.f = f;
      li.hit = hitInfos.has(f);
      labels.push(li);
    }
  }

  // --- internal scale grid ---
  if (s.scaleGrid && L.useLen && !unr) {
    const step = niceStep(L.maxX / 6);
    const age = s.scaleAxis === 'age';
    const factor = s.timeFactor || 1;
    const grid = new Path();
    const fsz = Math.max(7, s.fontSize * 0.75);
    for (let k = 0; k * step <= L.maxX * 1.0001; k++) {
      const x = age ? L.maxX - k * step : k * step;
      const label = fmtNum((age ? k * step : x) * factor + (age ? 0 : 0));
      if (rect) {
        grid.M(x * sx, -rowH / 2).V((ny - 0.5) * rowH);
        T(x * sx, (ny - 0.5) * rowH + fsz, 0, label, { size: fsz, fill: th.muted, anchor: 'middle' });
      } else {
        const r = rad(x);
        if (r <= 0) continue;
        grid.M(...polar(r, ang(-0.5))).arc(r, ang(-0.5), ang(ny - 0.5));
        const [tx, ty] = polar(r, ang(-0.5) - 2);
        T(tx, ty, 0, label, { size: fsz, fill: th.muted, anchor: 'middle' });
      }
    }
    P(grid, { stroke: th.guide, lw: 0.8, dash: [3, 3] }, back);
  }

  // --- clade ranges (TREE_COLORS 'range') ---
  if (!unr) {
    const rangeLegend = new Map();
    const op = s.rangeOpacity * (th.rangeScale || 1);
    for (const f of L.infos) {
      const st = f.n.style;
      if (!st || !st.range) continue;
      const c = safeColor(st.range, '#ddd');
      if (st.rangeLabel) rangeLegend.set(c + '\u0000' + st.rangeLabel, { color: c, label: st.rangeLabel, shape: 1 });
      const p = new Path();
      const y0 = f.ymin - (f.tip ? f.slot / 2 : 0.5), y1 = f.ymax + (f.tip ? f.slot / 2 : 0.5);
      if (rect) {
        const x0 = f.parent ? f.px - Math.min(6, (f.px - f.parent.px) / 2) : f.px - 6;
        p.rect(x0, y0 * rowH, labelsEnd + 6 - x0, (y1 - y0) * rowH);
      } else {
        p.sector(Math.max(0, f.r - 6), labelsEnd + 6, ang(y0), ang(y1));
      }
      P(p, { fill: c, alpha: op });
    }
    if (rangeLegend.size) legendBlocks.push({ title: 'Clades', items: [...rangeLegend.values()] });
  }

  // --- label backgrounds and alignment guides ---
  const guides = new Path();
  for (const li of labels) {
    const bg = li.hit ? th.hit : li.bg ? safeColor(li.bg) : null;
    if (bg) {
      const flip = li.a && Math.cos(li.a * DEG) < 0;
      const rot = li.a ? (flip ? li.a + 180 : li.a) : 0;
      P(new Path().poly(labelBox(li.x, li.y, rot, flip, li.w, li.size * 1.25)), { fill: bg });
    }
    if (li.guide) guides.M(...li.guide[0]).L(...li.guide[1]);
  }
  if (guides.n) P(guides, { stroke: th.guide, lw: Math.max(0.5, lw * 0.6), dash: [2, 2] });

  // --- HPD / range metadata bars ---
  if (s.rangeMeta && s.rangeMeta !== 'none' && L.useLen) {
    const key = s.rangeMeta;
    const bars = new Path();
    const isHeight = /height|age/i.test(key);
    const treeH = L.maxX;
    for (const f of L.infos) {
      const raw = f.n.attrs && f.n.attrs[key];
      if (!raw) continue;
      const nums = String(raw).replace(/[{}]/g, '').split(/[,;\s]+/).map(parseFloat).filter(isFinite);
      if (nums.length < 2) continue;
      let x0, x1;
      if (isHeight) { x0 = treeH - Math.max(nums[0], nums[1]); x1 = treeH - Math.min(nums[0], nums[1]); }
      else if (f.parent) { x0 = f.parent.x + Math.min(nums[0], nums[1]); x1 = f.parent.x + Math.max(nums[0], nums[1]); }
      else continue;
      const hh = Math.max(2, rowH * 0.25);
      if (rect) bars.rect(x0 * sx, f.py - hh, Math.max(0.5, (x1 - x0) * sx), hh * 2);
      else if (circ) bars.sector(rad(x0), rad(x1), f.a - Math.min(da * 0.3, 2), f.a + Math.min(da * 0.3, 2));
    }
    if (bars.n) P(bars, { fill: s.rangeMetaColor || '#4e79a7', alpha: 0.35 }, back);
  }

  // --- branches: grouped by style, chunked so the painter can cull off-screen parts ---
  const groups = new Map();
  const gradientBranches = [];
  for (const f of L.infos) {
    if (!f.parent) continue;
    const st = f.n.style || {};
    const style = {
      stroke: branchColorOf(f) || th.branch,
      lw: branchWidthOf(f),
      dash: st.branchDashed ? [4, 3] : null,
      alpha: dim && !hitPath.has(f) ? 0.2 : 1,
    };
    if (s.branchGradient) {
      const pc = branchColorOf(f.parent) || th.branch;
      if (pc !== style.stroke) { gradientBranches.push({ f, style, pc }); continue; }
    }
    const key = `${style.stroke}|${style.lw}|${!!style.dash}|${style.alpha}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { style, paths: [new Path()] });
    let p = g.paths[g.paths.length - 1];
    if (p.n >= BRANCH_CHUNK) g.paths.push(p = new Path());
    branchPath(f, p);
  }
  for (const g of groups.values()) for (const p of g.paths) P(p, { ...g.style, cap: 'square' });
  for (const { f, style, pc } of gradientBranches) {
    const p = branchPath(f, new Path());
    P(p, { ...style, stroke: 'grad', cap: 'square', grad: { x0: f.parent.px, y0: f.parent.py, x1: f.px, y1: f.py, stops: [pc, style.stroke] } });
  }

  // Truncated branches get a "//" break mark half way.
  const breaks = new Path();
  for (const f of L.infos) {
    if (!f.truncated || !f.parent) continue;
    let mx, my, a;
    if (rect) { mx = (f.parent.px + f.px) / 2; my = f.py; a = 0; }
    else if (circ) { [mx, my] = polar((f.parent.r + f.r) / 2, f.a); a = f.a; }
    else { mx = (f.parent.px + f.px) / 2; my = (f.parent.py + f.py) / 2; a = f.a; }
    const h = Math.max(4, rowH * 0.35), c = Math.cos((a + 70) * DEG), sn = Math.sin((a + 70) * DEG);
    const ox = 2.5 * Math.cos(a * DEG), oy = 2.5 * Math.sin(a * DEG);
    for (const k of [-1, 1]) breaks.M(mx + k * ox - c * h, my + k * oy - sn * h).L(mx + k * ox + c * h, my + k * oy + sn * h);
  }
  if (breaks.n) { P(breaks, { stroke: th.bg, lw: lw * 3 }); P(breaks, { stroke: th.branch, lw: Math.max(0.8, lw * 0.8) }); }

  // --- collapsed clades ---
  for (const f of L.tips) {
    if (!f.collapsed) continue;
    let pts;
    if (rect) {
      const h = Math.max(3, rowH * 0.42 * f.slot), xe = f.cx * sx;
      pts = [[f.px, f.py], [xe, f.py - h], [xe, f.py + h]];
    } else if (circ) {
      pts = [[f.px, f.py], polar(rad(f.cx), f.a - da * 0.42 * f.slot), polar(rad(f.cx), f.a + da * 0.42 * f.slot)];
    } else {
      const d = Math.max((f.cx - f.x) * usx, 8);
      pts = [[f.px, f.py], [f.px + d * Math.cos((f.a - 8) * DEG), f.py + d * Math.sin((f.a - 8) * DEG)],
        [f.px + d * Math.cos((f.a + 8) * DEG), f.py + d * Math.sin((f.a + 8) * DEG)]];
    }
    const c = branchColorOf(f) || th.branch;
    const p = new Path().poly(pts);
    P(p, { fill: c, alpha: 0.25 });
    P(p, { stroke: c, lw });
  }

  // --- node symbols and support / metadata display ---
  if (s.nodeDots) {
    const tipsP = new Path(), innerP = new Path();
    const size = s.nodeSize || Math.max(3, lw * 2.8);
    for (const f of L.infos) shapePath(s.nodeShape || 2, f.px, f.py, f.tip ? size : size * 0.85, f.tip ? tipsP : innerP);
    if (innerP.n) P(innerP, { fill: th.branch });
    if (tipsP.n) P(tipsP, { fill: th.tip });
  }
  if (s.support !== 'none') {
    const src = s.supportSource || 'support';
    const rg = range(src) || [0, 1];
    const scale = src === 'support' ? (rg[1] > 1 ? 100 : 1) : null;
    const fsz = Math.max(6, s.fontSize * 0.75);
    const on = new Path(), off = new Path();
    for (const f of L.infos) {
      if (f.tip || !f.parent) continue;
      const raw = metaRaw(f, src);
      if (raw == null || raw === '') continue;
      const v = metaNum(f, src);
      const ok = v == null || (scale ? v >= s.supportMin * (scale === 1 ? 0.01 : 1) : v >= s.supportMin);
      if (s.support === 'text') {
        if (ok) T(rect ? f.px - 3 : f.px + 3, f.py - fsz * 0.7, 0, v != null ? fmtNum(v) : String(raw), { size: fsz, fill: th.muted, anchor: rect ? 'end' : 'start' });
      } else if (v != null) {
        const t = scale ? Math.min(1, v / scale) : rg[1] > rg[0] ? (v - rg[0]) / (rg[1] - rg[0]) : 1;
        shapePath(s.supportShape || 2, f.px, f.py, 2 * (1.5 + 3.5 * t), ok ? on : off);
      }
    }
    if (on.n) P(on, { fill: th.support, stroke: th.support, lw: 0.8 });
    if (off.n) P(off, { stroke: th.support, lw: 0.8 });
  }

  if (s.showBranchLengths) {
    const fsz = Math.max(6, s.fontSize * 0.7);
    const asAge = s.branchLengthMode === 'age' && L.useLen;
    for (const f of L.infos) {
      if (asAge) {
        if (f.tip) continue;
        T(rect ? f.px - 3 : f.px + 3, f.py + fsz * 0.8, 0, fmtNum((L.maxX - f.x) * (s.timeFactor || 1)), { size: fsz, fill: th.muted, anchor: rect ? 'end' : 'start' });
        continue;
      }
      if (!f.parent || f.n.length == null) continue;
      let x, y;
      if (rect) { x = (f.parent.px + f.px) / 2; y = f.py - fsz * 0.6; }
      else if (circ) [x, y] = polar((f.parent.r + f.r) / 2, f.a);
      else { x = (f.parent.px + f.px) / 2; y = (f.parent.py + f.py) / 2; }
      T(x, y, 0, fmtNum(f.n.length), { size: fsz, fill: th.muted, anchor: 'middle' });
    }
  }

  if (s.showInternalLabels) {
    const fsz = Math.max(6, s.fontSize * 0.8);
    for (const f of L.infos) {
      const txt = (f.n.style && f.n.style.displayName) || f.n.name;
      if (f.tip || !txt) continue;
      T(rect ? f.px - 3 : f.px + 3, f.py + fsz * 0.7, 0, txt, { size: fsz, fill: th.muted, anchor: rect ? 'end' : 'start', id: f.n.id });
    }
  }

  const labelHits = [];
  for (const li of labels) {
    const fill = li.color ? safeColor(li.color, th.text) : th.text;
    const attrs = { size: li.size, bold: li.bold || li.hit, italic: li.italic, fill, alpha: dim && !li.hit ? 0.3 : 1, id: li.f.n.id };
    const t = li.runs
      ? R(li.x, li.y, li.a, li.runs.map(r => ({ ...r, bold: r.bold || attrs.bold, italic: r.italic || li.italic })), attrs)
      : T(li.x, li.y, li.a, li.text, attrs);
    labelHits.push([li.f.n.id, t.box]);
  }

  // --- datasets ---
  const datasets = (m.datasets || []).filter(d => d.visible !== false);
  const headerFs = Math.min(12, Math.max(7, s.fontSize * 0.9));
  // Row-local coordinates: u along the dataset axis, v across the row slot in [-0.5, 0.5].
  // In circular mode the slot is capped so glyphs stay readable at large radii.
  const capPx = Math.max(12, s.fontSize * 1.8);
  const slotPx = u => (rect ? rowH : Math.max(0.5, Math.min(u * da * DEG, capPx)));
  const loc = (u, v, f) => (rect ? [u, f.py + v * rowH] : polar(u, f.a + v * (u > 0 ? slotPx(u) / (u * DEG) : da)));
  const G = {
    s, th, measure, font, rect, circ, unr, L, n, ny, rowH, da, sx, rad, ang, loc, slotPx, P, T, R, prims, back,
    index: m.index, infoOf, visibleInfo, endPoint, tipEnd, labelsEnd, labels, legend: b => legendBlocks.push(b),
    headerFs, lw, full,
    header(x, text) { T(x, -rowH / 2 - 4, 0, text, { size: headerFs, fill: th.text, rot: -55 }); },
    band(p, o0, o1, f, frac) {
      if (rect) { const h = rowH * frac; p.rect(o0, f.py - h / 2, o1 - o0, h); }
      else p.sector(o0, o1, f.a - da * frac / 2, f.a + da * frac / 2);
      return p;
    },
    quad(p, f, u0, u1, v0, v1) { return p.poly([loc(u0, v0, f), loc(u1, v0, f), loc(u1, v1, f), loc(u0, v1, f)]); },
    line(p, f, u0, u1, v0, v1 = v0) { return p.M(...loc(u0, v0, f)).L(...loc(u1, v1, f)); },
    axisPath(d0) {
      const p = new Path();
      if (rect) return p.M(d0, -rowH / 2).V((ny - 0.5) * rowH);
      p.M(...polar(d0, ang(-0.5)));
      return p.arc(d0, ang(-0.5), ang(ny - 0.5));
    },
    nodePoint(f, position) {
      if (!f.parent || !(position >= 0 && position < 1)) return [f.px, f.py];
      const q = rect ? [f.parent.px, f.py] : circ ? polar(f.parent.r, f.a) : [f.parent.px, f.parent.py];
      return [q[0] + (f.px - q[0]) * position, q[1] + (f.py - q[1]) * position];
    },
    leafMap: ds => leafMap(ds, m.index),
    dash: style => DASH[style] || null,
  };

  let offset = labelsEnd + 10;
  const cellHits = [];
  if (!unr) {
    for (const ds of datasets) {
      if (!isAligned(ds)) continue;
      const margin = (ds.common && ds.common.margin) || 0;
      offset += margin;
      const w = drawAligned(ds, offset, G);
      cellHits.push([offset, offset + w]);
      offset += w + s.datasetGap;
    }
  }
  G.datasetsEnd = Math.max(labelsEnd, offset - s.datasetGap);
  for (const ds of datasets) if (ds.type === 'range') drawRange(ds, G);
  for (const ds of datasets) drawOnTree(ds, G);
  for (const ds of datasets) if (ds.type === 'timescale') drawTimescale(ds, G);
  for (const ds of datasets) if (ds.type === 'connection') drawConnections(ds, G);
  for (const ds of datasets) if (ds.type === 'tanglegram' && rect) drawTanglegram(ds, G);

  // Things drawn behind the tree go first.
  if (back.length) prims.unshift(...back);

  // --- bounds: union of everything drawn so far ---
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  const ext = (x, y) => { if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y; };
  for (const p of prims) { if (isFinite(p.box[0])) { ext(p.box[0], p.box[1]); ext(p.box[2], p.box[3]); } }
  if (!isFinite(bMinX)) { ext(-10, -10); ext(10, 10); }
  bMinX -= 6; bMinY -= 6; bMaxX += 6; bMaxY += 6;

  // --- scale bar ---
  if (s.showScale && L.useLen) {
    const unit = unr ? usx : sx;
    const step = niceStep((s.treeWidth / unit) / 5);
    const len = step * unit;
    const x0 = bMinX + 8, y0 = bMaxY + 18;
    P(new Path().M(x0, y0 - 4).V(y0).H(x0 + len).V(y0 - 4), { stroke: th.text, lw: 1.2 });
    T(x0 + len / 2, y0 + 10, 0, fmtNum(step * (s.timeFactor || 1)), { size: 11, fill: th.text, anchor: 'middle' });
    ext(x0, y0 + 18);
  }

  // --- legend ---
  const blocks = legendBlocks.filter(b => b && b.visible !== false);
  if (s.showLegend && blocks.length) {
    const auto = Math.max(1, Math.min(6, Math.max(bMaxX - bMinX, bMaxY - bMinY) / 1400));
    const size = blk => {
      const k = auto * (blk.scale || 1);
      let h = blk.title ? 18 : 0, w = blk.title ? measure(blk.title, 12, true, false, font) : 0;
      if (blk.gradient) { h += 30; w = Math.max(w, 120); }
      const items = blk.items || [];
      if (blk.horizontal) {
        h += items.length ? 16 : 0;
        w = Math.max(w, items.reduce((a, it) => a + 26 + measure(String(it.label), 11, false, false, font), 0));
      } else {
        for (const it of items) { h += 16; w = Math.max(w, 18 + measure(String(it.label), 11, false, false, font)); }
      }
      return [w * k, h * k];
    };
    const drawBlock = (blk, X, Y) => {
      const k = auto * (blk.scale || 1);
      let y = Y;
      if (blk.title) { T(X, y + 6 * k, 0, blk.title, { size: 12 * k, bold: true, fill: th.text }); y += 18 * k; }
      if (blk.gradient) {
        const g = blk.gradient;
        prims.push({ k: 'g', x: X, y, w: 120 * k, h: 12 * k, stops: g.stops, box: [X, y, X + 120 * k, y + 12 * k] });
        T(X, y + 20 * k, 0, fmtNum(g.min), { size: 10 * k, fill: th.text });
        T(X + 120 * k, y + 20 * k, 0, fmtNum(g.max), { size: 10 * k, fill: th.text, anchor: 'end' });
        y += 30 * k;
      }
      let x = X;
      for (const it of blk.items || []) {
        const gs = 10 * k * (it.scale == null ? 1 : it.scale);
        const sh = glyph(it.shape || 1, x + 6 * k, y + 6 * k, gs);
        P(sh.path, sh.strokeOnly || it.invert ? { stroke: it.color, lw: 1.5 * k, dash: sh.dash || null } : { fill: it.color });
        const t = T(x + 18 * k, y + 6 * k, 0, String(it.label), { size: 11 * k, fill: th.text });
        if (blk.horizontal) x = t.box[2] + 8 * k; else y += 16 * k;
      }
    };
    const sized = blocks.map(b => ({ b, wh: size(b) }));
    if (opt.legendBelow) {
      const x0 = bMinX + 8, maxX = Math.max(bMaxX, x0 + 300 * auto);
      let x = x0, y = bMaxY + 24 * auto, rowMax = 0;
      for (const { b, wh } of sized) {
        if (x > x0 && x + wh[0] > maxX) { x = x0; y += rowMax + 12 * auto; rowMax = 0; }
        drawBlock(b, x, y);
        x += wh[0] + 24 * auto;
        rowMax = Math.max(rowMax, wh[1]);
      }
      ext(x0, y + rowMax);
    } else {
      const x = bMaxX + 30 * auto;
      let y = bMinY + 6, w = 0;
      for (const { b, wh } of sized) { drawBlock(b, x, y); y += wh[1] + 10 * auto; w = Math.max(w, wh[0]); }
      ext(x + w + 10, y);
    }
  }

  // Overlay builder for the current selection (kept separate so selecting does not rebuild the scene).
  function overlay(selection, bg) {
    const out = [];
    const sel = [];
    selection.forEach((id, i) => {
      const node = m.index.byId.get(id);
      const f = node && visibleInfo(node);
      if (f) sel.push({ f, color: SELECTION_COLORS[i % SELECTION_COLORS.length] });
    });
    for (const { f, color } of sel) {
      const p = new Path();
      for (let c = f; c.parent; c = c.parent) branchPath(c, p);
      if (p.n) out.push({ k: 'p', d: p.d, box: p.box, stroke: color, lw: lw + 2.5, alpha: 0.85, cap: 'round' });
    }
    for (const { f, color } of sel) {
      const p = new Path().circle(f.px, f.py, 4);
      out.push({ k: 'p', d: p.d, box: p.box, fill: color, stroke: bg, lw: 1.5 });
    }
    if (sel.length >= 2) {
      const mr = Tree.mrca(sel.map(x => x.f.n));
      const f = mr && visibleInfo(mr);
      if (f) {
        const ring = new Path().circle(f.px, f.py, 7), dot = new Path().circle(f.px, f.py, 3);
        out.push({ k: 'p', d: ring.d, box: ring.box, stroke: '#9333ea', lw: 2.5 });
        out.push({ k: 'p', d: dot.d, box: dot.box, fill: '#9333ea' });
      }
    }
    return out;
  }

  return {
    prims,
    bounds: { x: bMinX, y: bMinY, w: bMaxX - bMinX, h: bMaxY - bMinY },
    points: L.infos.map(f => [f.n.id, f.px, f.py]),
    labels: labelHits,
    rows: { mode, rect, circ, rowH, da, ang0: s.rotation, full, n, tips: L.tips.map(f => f.n.id), tipYs: L.tips.map(f => f.y), treeEnd: rect ? L.maxX * sx : rad(L.maxX), cells: cellHits },
    overlay,
    font,
  };
}
