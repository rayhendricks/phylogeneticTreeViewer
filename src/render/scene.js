/* Scene builder: turns a tree + settings + datasets into a flat list of drawing primitives.
   The same scene is painted on a canvas (interactive view) and serialised to SVG (export).

   Primitive kinds:
     p  path      { d, box, fill?, stroke?, lw?, dash?, alpha? }
     t  text      { x, y, rot, text, size, bold, italic, anchor, fill, alpha?, box }
     i  image     { url, x, y, w, h, rot, box }            (centered at x, y)
     a  alignment { x, y, w, h, rows: [seq|null], len, scheme, box }
     g  gradient  { x, y, w, h, stops, box }                (legend color bar)
*/
import * as Tree from '../core/tree.js';
import { computeLayout, equalAngle, niceStep } from '../core/layout.js';
import { safeColor, paletteColor, ramp, RAMPS } from './color.js';
import { Path, DEG, polar, shapePath, DOMAIN_SHAPES, labelBox } from './geom.js';

export const SELECTION_COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#17becf'];
const BRANCH_CHUNK = 400;

export const fmtNum = v => {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : String(+v.toPrecision(4));
};
const maxOf = (arr, init = -Infinity) => arr.reduce((m, v) => (v > m ? v : m), init);
const minOf = (arr, init = Infinity) => arr.reduce((m, v) => (v < m ? v : m), init);

// Map leaf name -> row for an aligned dataset. Clade ids (A|B, internal names) fan out to leaves.
export function leafMap(ds, index) {
  const map = new Map(), leafRows = [];
  for (const row of ds.rows) {
    const node = Tree.resolveSpec(index, row.id);
    if (!node) continue;
    if (!node.children.length) { leafRows.push([node.name, row]); continue; }
    for (const l of Tree.leaves(node)) if (!map.has(l.name)) map.set(l.name, row);
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

const ALIGNED = new Set(['colorstrip', 'simplebar', 'multibar', 'heatmap', 'binary', 'shapes', 'text', 'domains', 'alignment', 'boxplot', 'linechart']);

export function buildScene(m, opt = {}) {
  const s = m.settings, th = opt.theme, measure = m.measure;
  const font = s.fontFamily;
  const L = computeLayout(m.root, s);
  const mode = s.mode;
  const circ = mode === 'circular', unr = mode === 'unrooted', rect = !circ && !unr;
  const n = L.tips.length;
  const rowH = s.spacing;
  const sx = s.treeWidth / L.maxX;
  const lw = s.lineWidth;
  const full = s.arc >= 359.5;
  const da = s.arc / (full ? n : Math.max(n - 1, 1));
  const ang = y => s.rotation + (full ? y + 0.5 : y) * da;
  const rad = x => s.innerRadius + x * sx;
  let usx = 1;

  if (unr) {
    usx = s.treeWidth / equalAngle(L);
    for (const f of L.infos) { f.px = f.ux * usx; f.py = f.uy * usx; f.a = f.ua; }
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
    if (mode === 'rectangular') return p.V(f.py).H(f.px);
    if (!circ) return p.L(f.px, f.py);
    return p.arc(q.r, q.a, f.a).L(f.px, f.py);
  }

  const prims = [];
  const P = (path, style) => { prims.push({ k: 'p', d: path.d, box: path.box, ...style }); };
  const textBox = (x, y, rot, anchor, w, h) => {
    if (!rot) { const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x; return [x0, y - h / 2, x0 + w, y + h / 2]; }
    const dir = anchor === 'end' ? -1 : 1;
    const ex = x + dir * w * Math.cos(rot * DEG), ey = y + dir * w * Math.sin(rot * DEG);
    return [Math.min(x, ex) - h / 2, Math.min(y, ey) - h / 2, Math.max(x, ex) + h / 2, Math.max(y, ey) + h / 2];
  };
  // Text reading outward along angle a (flipped on the left half so it is never upside down).
  function T(x, y, a, text, attrs) {
    const size = attrs.size;
    const w = measure(text, size, attrs.bold, attrs.italic, font);
    let rot = 0, anchor = attrs.anchor || 'start';
    if (a) { const flip = Math.cos(a * DEG) < 0; rot = flip ? a + 180 : a; if (flip) anchor = anchor === 'start' ? 'end' : 'start'; }
    if (attrs.rot != null) { rot = attrs.rot; }
    const prim = { k: 't', x, y, rot, text: String(text), anchor, ...attrs, box: textBox(x, y, rot, anchor, w, size * 1.2) };
    prim.anchor = anchor; prim.rot = rot;
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

  // --- automatic branch coloring ---
  const legendBlocks = [];
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
    const val = by === 'support' ? f => f.n.support : by === 'length' ? f => f.n.length
      : f => { const v = f.n.attrs && f.n.attrs[by.slice(5)]; return v == null ? null : parseFloat(v); };
    const vals = L.infos.filter(f => f.parent).map(val).filter(v => v != null && isFinite(v));
    if (vals.length) {
      const lo = minOf(vals), hi = maxOf(vals);
      const stops = (RAMPS[s.branchRamp] || RAMPS.Viridis).slice();
      if (s.branchRampReverse) stops.reverse();
      const fn = ramp(stops);
      for (const f of L.infos) {
        const v = val(f);
        if (f.parent && v != null && isFinite(v)) autoColor.set(f, fn(hi > lo ? (v - lo) / (hi - lo) : 0.5));
      }
      const title = by === 'support' ? 'Branch support' : by === 'length' ? 'Branch length' : by.slice(5);
      legendBlocks.push({ title, gradient: { stops: [0, 0.25, 0.5, 0.75, 1].map(fn), min: lo, max: hi } });
    }
  }
  const branchColorOf = f => (f.n.style && f.n.style.branchColor && safeColor(f.n.style.branchColor)) || autoColor.get(f) || null;

  // --- labels (measured first: ranges and datasets depend on their extent) ---
  const labels = [];
  let labelsEnd = rect ? L.maxX * sx : circ ? rad(L.maxX) : 0;
  const gap = 4 + (s.nodeDots ? 3 : 0);
  if (s.showLeafLabels) {
    for (const f of L.tips) {
      const li = labelInfo(f, s);
      if (!li.text) continue;
      li.w = measure(li.text, li.size, li.bold, li.italic, font);
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

  // --- clade ranges ---
  if (!unr) {
    const rangeLegend = new Map();
    const op = s.rangeOpacity * (th.rangeScale || 1);
    for (const f of L.infos) {
      const st = f.n.style;
      if (!st || !st.range) continue;
      const c = safeColor(st.range, '#ddd');
      if (st.rangeLabel) rangeLegend.set(c + '\u0000' + st.rangeLabel, { color: c, label: st.rangeLabel, shape: 1 });
      const p = new Path();
      if (rect) {
        const x0 = f.parent ? f.px - Math.min(6, (f.px - f.parent.px) / 2) : f.px - 6;
        p.rect(x0, (f.ymin - 0.5) * rowH, labelsEnd + 6 - x0, (f.ymax - f.ymin + 1) * rowH);
      } else {
        p.sector(Math.max(0, f.r - 6), labelsEnd + 6, ang(f.ymin - 0.5), ang(f.ymax + 0.5));
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

  // --- branches: grouped by style, chunked so the painter can cull off-screen parts ---
  const groups = new Map();
  for (const f of L.infos) {
    if (!f.parent) continue;
    const st = f.n.style || {};
    const style = {
      stroke: branchColorOf(f) || th.branch,
      lw: st.branchWidth ? lw * st.branchWidth : lw,
      dash: st.branchDashed ? [4, 3] : null,
      alpha: dim && !hitPath.has(f) ? 0.2 : 1,
    };
    const key = `${style.stroke}|${style.lw}|${!!style.dash}|${style.alpha}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { style, paths: [new Path()] });
    let p = g.paths[g.paths.length - 1];
    if (p.n >= BRANCH_CHUNK) g.paths.push(p = new Path());
    branchPath(f, p);
  }
  for (const g of groups.values()) for (const p of g.paths) P(p, { ...g.style, cap: 'square' });

  // --- collapsed clades ---
  for (const f of L.tips) {
    if (!f.collapsed) continue;
    let pts;
    if (rect) {
      const h = Math.max(3, rowH * 0.42), xe = f.cx * sx;
      pts = [[f.px, f.py], [xe, f.py - h], [xe, f.py + h]];
    } else if (circ) {
      pts = [[f.px, f.py], polar(rad(f.cx), f.a - da * 0.42), polar(rad(f.cx), f.a + da * 0.42)];
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

  // --- node dots and support ---
  if (s.nodeDots) {
    const tipsP = new Path(), innerP = new Path();
    const rr = Math.max(1.5, lw * 1.4);
    for (const f of L.infos) (f.tip ? tipsP : innerP).circle(f.px, f.py, rr);
    if (innerP.n) P(innerP, { fill: th.branch });
    if (tipsP.n) P(tipsP, { fill: th.tip });
  }
  if (s.support !== 'none') {
    const maxSup = maxOf(L.infos.map(f => (f.n.support == null ? 0 : f.n.support)), 0);
    const scale = maxSup > 1 ? 100 : 1;
    const fsz = Math.max(6, s.fontSize * 0.75);
    const on = new Path(), off = new Path();
    for (const f of L.infos) {
      const v = f.n.support;
      if (f.tip || !f.parent || v == null) continue;
      const ok = v >= s.supportMin * (scale === 1 ? 0.01 : 1);
      if (s.support === 'text') {
        if (ok) T(rect ? f.px - 3 : f.px + 3, f.py - fsz * 0.7, 0, fmtNum(v), { size: fsz, fill: th.muted, anchor: rect ? 'end' : 'start' });
      } else {
        (ok ? on : off).circle(f.px, f.py, 1.5 + 3.5 * Math.min(1, v / scale));
      }
    }
    if (on.n) P(on, { fill: th.support, stroke: th.support, lw: 0.8 });
    if (off.n) P(off, { stroke: th.support, lw: 0.8 });
  }

  if (s.showBranchLengths) {
    const fsz = Math.max(6, s.fontSize * 0.7);
    for (const f of L.infos) {
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
    const t = T(li.x, li.y, li.a, li.text, {
      size: li.size, bold: li.bold || li.hit, italic: li.italic, fill, alpha: dim && !li.hit ? 0.3 : 1, id: li.f.n.id,
    });
    labelHits.push([li.f.n.id, t.box]);
  }

  // --- aligned datasets ---
  let offset = labelsEnd + 10;
  const datasets = (m.datasets || []).filter(d => d.visible !== false);
  const aligned = unr ? [] : datasets.filter(d => ALIGNED.has(d.type) || ((d.type === 'pie' || d.type === 'image') && d.rows.some(r => r.position < 0)));
  const headerFs = Math.min(12, Math.max(7, s.fontSize * 0.9));
  // Row-local coordinates: u along the dataset axis, v across the row slot in [-0.5, 0.5].
  // In circular mode the slot is capped so glyphs stay readable at large radii.
  const capPx = Math.max(12, s.fontSize * 1.8);
  const slotPx = u => (rect ? rowH : Math.max(0.5, Math.min(u * da * DEG, capPx)));
  const loc = (u, v, f) => (rect ? [u, f.py + v * rowH] : polar(u, f.a + v * (u > 0 ? slotPx(u) / (u * DEG) : da)));
  const header = (x, text) => {
    T(x, -rowH / 2 - 4, 0, text, { size: headerFs, fill: th.text, rot: -55 });
  };
  const axisPath = d0 => {
    const p = new Path();
    if (rect) return p.M(d0, -rowH / 2).V((n - 0.5) * rowH);
    p.M(...polar(d0, ang(-0.5)));
    return p.arc(d0, ang(-0.5), ang(n - 0.5));
  };
  const cellHits = [];

  for (const ds of aligned) {
    const map = leafMap(ds, m.index);
    const value = f => {
      if (!f.collapsed) return map.get(f.n.name);
      for (const l of Tree.leaves(f.n)) { const v = map.get(l.name); if (v) return v; }
      return undefined;
    };
    let w = ds.width || 20;
    const d0 = offset;
    const color = safeColor(ds.color, '#4e79a7');

    if (ds.type === 'colorstrip') {
      const byColor = new Map();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const c = safeColor(row.color, '#ccc');
        if (!byColor.has(c)) byColor.set(c, new Path());
        const p = byColor.get(c);
        if (rect) p.rect(d0, f.py - rowH / 2, w, rowH); else p.sector(d0, d0 + w, f.a - da / 2, f.a + da / 2);
      }
      for (const [c, p] of byColor) P(p, { fill: c });
      const leg = new Map();
      for (const row of ds.rows) if (!leg.has(row.color)) leg.set(row.color, row.label || row.color);
      if (rect) header(d0 + w / 2, ds.label);
      legendBlocks.push(ds.legend || { title: ds.label, items: [...leg].slice(0, 40).map(([c, l]) => ({ color: safeColor(c, '#ccc'), label: l, shape: 1 })) });
    } else if (ds.type === 'simplebar' || ds.type === 'multibar') {
      const multi = ds.type === 'multibar';
      const tot = row => (multi ? row.values.reduce((a, b) => a + Math.max(0, b || 0), 0) : Math.max(0, row.value));
      const max = maxOf(ds.rows.map(tot), 1e-12);
      P(axisPath(d0), { stroke: th.guide, lw: 1 });
      const fieldPaths = new Map();
      const get = c => { if (!fieldPaths.has(c)) fieldPaths.set(c, new Path()); return fieldPaths.get(c); };
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        if (!multi) {
          const len = Math.max(0, row.value) / max * w;
          if (len > 0) appendBand(get(color), d0, d0 + len, f, 0.72);
        } else {
          let acc = d0;
          row.values.forEach((v, i) => {
            const len = Math.max(0, v || 0) / max * w;
            if (len <= 0) return;
            appendBand(get(safeColor((ds.fields[i] || {}).color, paletteColor(i))), acc, acc + len, f, 0.72);
            acc += len;
          });
        }
      }
      for (const [c, p] of fieldPaths) P(p, { fill: c });
      if (rect) header(d0 + w / 2, `${ds.label} (max ${fmtNum(max)})`);
      legendBlocks.push(ds.legend || (multi
        ? { title: ds.label, items: ds.fields.map((fd, i) => ({ color: safeColor(fd.color, paletteColor(i)), label: fd.label, shape: 1 })) }
        : { title: ds.label, items: [{ color, label: `max ${fmtNum(max)}`, shape: 1 }] }));
    } else if (ds.type === 'heatmap') {
      const nF = maxOf(ds.rows.map(r => r.values.length), Math.max(1, (ds.fields || []).length));
      const o = ds.opts || {};
      const all = ds.rows.flatMap(r => r.values).filter(v => v != null && isFinite(v));
      const min = o.min != null ? o.min : minOf(all);
      const max = o.max != null ? o.max : maxOf(all);
      const fn = ramp((o.stops && o.stops.length ? o.stops : RAMPS.Viridis).map(c => safeColor(c, '#888')));
      const cell = w / nF;
      const byColor = new Map();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        row.values.forEach((v, i) => {
          if (v == null || !isFinite(v)) return;
          const c = fn(max > min ? (v - min) / (max - min) : 0.5);
          if (!byColor.has(c)) byColor.set(c, new Path());
          appendBand(byColor.get(c), d0 + i * cell, d0 + (i + 1) * cell, f, 1);
        });
      }
      for (const [c, p] of byColor) P(p, { fill: c });
      if (rect) {
        if (nF > 1) (ds.fields || []).forEach((fd, i) => header(d0 + (i + 0.5) * cell, fd.label));
        else header(d0 + w / 2, ds.label);
      }
      if (all.length) legendBlocks.push({ title: ds.label, gradient: { stops: [0, 0.25, 0.5, 0.75, 1].map(fn), min, max } });
    } else if (ds.type === 'binary' || ds.type === 'shapes') {
      const nF = Math.max(1, (ds.fields || []).length);
      const cell = w / nF;
      const vmax = ds.type === 'shapes' ? maxOf(ds.rows.flatMap(r => r.values), 1e-12) : 1;
      const byField = ds.fields.map(() => ({ fill: new Path(), line: new Path() }));
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        row.values.forEach((v, i) => {
          const fd = ds.fields[i];
          if (!fd) return;
          const u = d0 + (i + 0.5) * cell;
          const base = Math.max(2, Math.min(cell, slotPx(u)) * 0.75);
          let size, filled;
          if (ds.type === 'binary') { if (v !== 1 && v !== 0) return; size = base; filled = v === 1; }
          else { if (!(v > 0)) return; size = base * Math.sqrt(v / vmax); filled = ds.opts.filled !== false; }
          const [cx, cy] = loc(u, 0, f);
          const sh = shapePath(ds.type === 'binary' ? fd.shape || 2 : ds.opts.shape, cx, cy, size, filled ? byField[i].fill : byField[i].line);
          if (sh.strokeOnly && filled) shapePath(6, cx, cy, size, byField[i].line);
        });
      }
      byField.forEach((g, i) => {
        const c = safeColor(ds.fields[i].color, '#333');
        if (g.fill.n) P(g.fill, { fill: c });
        if (g.line.n) P(g.line, { stroke: c, lw: 1 });
      });
      if (rect) ds.fields.forEach((fd, i) => header(d0 + (i + 0.5) * cell, fd.label));
      legendBlocks.push(ds.legend || { title: ds.label, items: ds.fields.map(fd => ({ color: safeColor(fd.color, '#333'), label: fd.label, shape: ds.type === 'binary' ? fd.shape || 2 : ds.opts.shape })) });
    } else if (ds.type === 'text') {
      let maxW = 0;
      for (const f of L.tips) {
        const row = value(f);
        if (!row || !row.label) continue;
        const size = s.fontSize * (row.size || 1);
        const bold = /bold/.test(row.style || ''), italic = /italic/.test(row.style || '');
        maxW = Math.max(maxW, measure(row.label, size, bold, italic, font));
        const [x, y] = loc(d0 + 2, 0, f);
        T(x, y, rect ? 0 : f.a, row.label, { size, bold, italic, fill: safeColor(row.color, th.text) });
      }
      w = ds.width || maxW + 6;
      if (rect) header(d0 + 4, ds.label);
    } else if (ds.type === 'domains') {
      const maxLen = maxOf(ds.rows.map(r => r.length), 1);
      const o = ds.opts || {};
      const back = new Path();
      const byColor = new Map();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const len = row.length / maxLen * w;
        const bh = (o.backboneHeight || 2) / 2;
        appendQuad(back, f, d0, d0 + len, -bh / slotPx(d0 + len / 2), bh / slotPx(d0 + len / 2));
        for (const dm of row.domains) {
          const shapeKey = DOMAIN_SHAPES[dm.shape] ? dm.shape : 'RE';
          if (dm.shape === 'GP') continue;
          const u0 = d0 + dm.start / maxLen * w, u1 = d0 + dm.end / maxLen * w;
          const c = safeColor(dm.color, '#888');
          if (!byColor.has(c)) byColor.set(c, new Path());
          byColor.get(c).poly(DOMAIN_SHAPES[shapeKey].map(([u, v]) => loc(u0 + u * (u1 - u0), v * 0.38, f)));
          if (rect && dm.label && u1 - u0 > 14) {
            const fs = Math.min(rowH * 0.55, s.fontSize * 0.8);
            const tw = measure(dm.label, fs, false, false, font);
            if (tw < u1 - u0 - 2) T((u0 + u1) / 2, f.py, 0, dm.label, { size: fs, fill: '#ffffff', anchor: 'middle' });
          }
        }
      }
      if (back.n) P(back, { fill: safeColor(o.backbone, '#aaa') });
      for (const [c, p] of byColor) P(p, { fill: c, stroke: 'rgba(0,0,0,0.35)', lw: 0.5 });
      if (rect) header(d0 + w / 2, ds.label);
      const leg = new Map();
      for (const r of ds.rows) for (const dm of r.domains) if (dm.label && !leg.has(dm.label)) leg.set(dm.label, safeColor(dm.color, '#888'));
      if (leg.size) legendBlocks.push(ds.legend || { title: ds.label, items: [...leg].slice(0, 40).map(([l, c]) => ({ color: c, label: l, shape: 1 })) });
    } else if (ds.type === 'alignment') {
      const len = maxOf(ds.rows.map(r => r.seq.length), 0);
      const cell = (ds.opts && ds.opts.cell) || 4;
      w = len * cell;
      if (rect && len) {
        const seqs = L.tips.map(f => { const r = value(f); return r ? r.seq : null; });
        prims.push({ k: 'a', x: d0, y: -rowH / 2, w, h: n * rowH, rows: seqs, len, scheme: (ds.opts && ds.opts.scheme) || 'auto',
          box: [d0, -rowH / 2, d0 + w, (n - 0.5) * rowH] });
        header(d0 + 4, `${ds.label} (${len} columns)`);
      } else {
        w = 0;
      }
    } else if (ds.type === 'boxplot') {
      const lo = minOf(ds.rows.map(r => Math.min(r.min, ...r.extremes))), hi = maxOf(ds.rows.map(r => Math.max(r.max, ...r.extremes)));
      const X = v => d0 + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * w;
      const lines = new Path(), boxes = new Path(), dots = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        appendLine(lines, f, X(row.min), X(row.max), 0);
        appendLine(lines, f, X(row.min), X(row.min), 0.25, -0.25);
        appendLine(lines, f, X(row.max), X(row.max), 0.25, -0.25);
        boxes.poly([loc(X(row.q1), -0.32, f), loc(X(row.q3), -0.32, f), loc(X(row.q3), 0.32, f), loc(X(row.q1), 0.32, f)]);
        appendLine(lines, f, X(row.median), X(row.median), -0.32, 0.32);
        for (const e of row.extremes) { const [x, y] = loc(X(e), 0, f); dots.circle(x, y, Math.max(0.8, Math.min(2.5, slotPx(X(e)) * 0.12))); }
      }
      P(axisPath(d0), { stroke: th.guide, lw: 1 });
      P(boxes, { fill: color, alpha: 0.55 });
      P(boxes, { stroke: th.text, lw: 0.8 });
      P(lines, { stroke: th.text, lw: 0.8 });
      if (dots.n) P(dots, { stroke: th.text, lw: 0.6 });
      if (rect) header(d0 + w / 2, `${ds.label} (${fmtNum(lo)} – ${fmtNum(hi)})`);
    } else if (ds.type === 'linechart') {
      const pts = ds.rows.flatMap(r => r.points);
      const x0 = minOf(pts.map(q => q[0])), x1 = maxOf(pts.map(q => q[0]));
      const y0 = minOf(pts.map(q => q[1])), y1 = maxOf(pts.map(q => q[1]));
      const p = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        row.points.slice().sort((a, b) => a[0] - b[0]).forEach(([x, y], i) => {
          const u = d0 + (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5) * w;
          const v = 0.4 - (y1 > y0 ? (y - y0) / (y1 - y0) : 0.5) * 0.8;
          const q = loc(u, v, f);
          if (i) p.L(...q); else p.M(...q);
        });
      }
      P(axisPath(d0), { stroke: th.guide, lw: 1 });
      P(p, { stroke: color, lw: Math.max(0.6, lw * 0.8) });
      if (rect) header(d0 + w / 2, ds.label);
    } else if (ds.type === 'pie') {
      w = ds.width || 30;
      const maxR = maxOf(ds.rows.map(r => r.radius), 1);
      for (const f of L.tips) {
        const row = value(f);
        if (!row || row.position >= 0) continue;
        const r = Math.min(w / 2, slotPx(d0 + w / 2) / 2) * Math.sqrt(row.radius / maxR);
        const [cx, cy] = loc(d0 + w / 2, 0, f);
        pie(cx, cy, r, row.values, ds.fields);
      }
      legendBlocks.push(ds.legend || { title: ds.label, items: ds.fields.map((fd, i) => ({ color: safeColor(fd.color, paletteColor(i)), label: fd.label, shape: 2 })) });
    } else if (ds.type === 'image') {
      w = ds.width || 40;
      for (const f of L.tips) {
        const row = value(f);
        if (!row || row.position >= 0) continue;
        const size = Math.min(w, slotPx(d0 + w / 2) * 0.95) * (row.size || 1);
        const [cx, cy] = loc(d0 + w / 2 + row.dx, 0, f);
        image(row.url, cx, cy + row.dy, size, row.rotation);
      }
    }
    cellHits.push([d0, d0 + w]);
    offset += w + s.datasetGap;
  }
  const datasetsEnd = Math.max(labelsEnd, offset - s.datasetGap);

  function appendBand(p, o0, o1, f, frac) {
    if (rect) { const h = rowH * frac; p.rect(o0, f.py - h / 2, o1 - o0, h); }
    else p.sector(o0, o1, f.a - da * frac / 2, f.a + da * frac / 2);
  }
  function appendQuad(p, f, u0, u1, v0, v1) { p.poly([loc(u0, v0, f), loc(u1, v0, f), loc(u1, v1, f), loc(u0, v1, f)]); }
  function appendLine(p, f, u0, u1, v0, v1 = v0) { p.M(...loc(u0, v0, f)).L(...loc(u1, v1, f)); }
  function pie(cx, cy, r, values, fields) {
    const total = values.reduce((a, b) => a + b, 0);
    if (!(total > 0) || !(r > 0)) return;
    let a = -90;
    values.forEach((v, i) => {
      if (!(v > 0)) return;
      const c = safeColor((fields[i] || {}).color, paletteColor(i));
      const sweep = v / total * 360;
      const p = new Path();
      if (sweep >= 359.99) p.circle(cx, cy, r);
      else {
        const [x0, y0] = polar(r, a), [x1, y1] = polar(r, a + sweep);
        p.M(cx, cy).L(cx + x0, cy + y0);
        p.d += `A${r},${r} 0 ${sweep > 180 ? 1 : 0} 1 ${Math.round((cx + x1) * 100) / 100},${Math.round((cy + y1) * 100) / 100}Z`;
        p.ext(cx - r, cy - r); p.ext(cx + r, cy + r);
      }
      P(p, { fill: c, stroke: th.bg, lw: 0.5 });
      a += sweep;
    });
  }
  function image(url, cx, cy, size, rot) {
    if (!(size > 0)) return;
    const h = size / 2;
    prims.push({ k: 'i', url, x: cx, y: cy, w: size, h: size, rot: rot || 0, box: [cx - h * 1.42, cy - h * 1.42, cx + h * 1.42, cy + h * 1.42] });
  }

  // --- datasets placed on nodes (symbols, internal pies and images) ---
  const nodePoint = (f, position) => {
    if (!f.parent || !(position >= 0 && position < 1)) return [f.px, f.py];
    const q = rect ? [f.parent.px, f.py] : circ ? polar(f.parent.r, f.a) : [f.parent.px, f.parent.py];
    return [q[0] + (f.px - q[0]) * position, q[1] + (f.py - q[1]) * position];
  };
  for (const ds of datasets) {
    if (ds.type === 'symbol') {
      const maxSize = maxOf(ds.rows.map(r => r.size), 1);
      for (const row of ds.rows) {
        const node = Tree.resolveSpec(m.index, row.id);
        const f = node && infoOf.get(node);
        if (!f) continue;
        const [x, y] = nodePoint(f, row.position);
        const sh = shapePath(row.shape, x, y, Math.max(2, (row.size / maxSize) * (ds.maxSize || 10)));
        const c = safeColor(row.color, '#888');
        P(sh.path, row.filled && !sh.strokeOnly ? { fill: c } : { stroke: c, lw: 1 });
      }
      if (ds.legend) legendBlocks.push(ds.legend);
    } else if (ds.type === 'pie' || ds.type === 'image') {
      const maxR = maxOf(ds.rows.map(r => r.radius || 1), 1);
      for (const row of ds.rows) {
        if (!(row.position >= 0)) continue;
        const node = Tree.resolveSpec(m.index, row.id);
        const f = node && infoOf.get(node);
        if (!f) continue;
        const [x, y] = nodePoint(f, row.position);
        if (ds.type === 'pie') pie(x, y, Math.max(2, (ds.width || 30) / 2 * Math.sqrt(row.radius / maxR)), row.values, ds.fields);
        else image(row.url, x + row.dx, y + row.dy, (ds.width || 40) * (row.size || 1), row.rotation);
      }
      if (unr && ds.type === 'pie') legendBlocks.push({ title: ds.label, items: ds.fields.map((fd, i) => ({ color: safeColor(fd.color, paletteColor(i)), label: fd.label, shape: 2 })) });
    }
  }

  // --- connections between leaves ---
  for (const ds of datasets) {
    if (ds.type !== 'connection') continue;
    const maxW = maxOf(ds.rows.map(r => r.width), 1);
    for (const row of ds.rows) {
      const a = Tree.resolveSpec(m.index, row.id), b = Tree.resolveSpec(m.index, row.to);
      const fa = a && visibleInfo(a), fb = b && visibleInfo(b);
      if (!fa || !fb || fa === fb) continue;
      const p = new Path();
      if (rect) {
        const x0 = datasetsEnd + 8, h = Math.min(400, Math.abs(fa.py - fb.py) * 0.45 + 10);
        p.M(x0, fa.py).C(x0 + h, fa.py, x0 + h, fb.py, x0, fb.py);
      } else if (circ) {
        const r0 = rad(L.maxX) + 2;
        const pa = polar(r0, fa.a), pb = polar(r0, fb.a);
        const k = 0.25;
        p.M(...pa).C(pa[0] * k, pa[1] * k, pb[0] * k, pb[1] * k, ...pb);
      } else {
        const [ax, ay] = endPoint(fa), [bx, by] = endPoint(fb);
        p.M(ax, ay).C(ax * 0.5, ay * 0.5, bx * 0.5, by * 0.5, bx, by);
      }
      P(p, { stroke: safeColor(row.color, '#e15759'), lw: Math.max(0.5, row.width / maxW * 3), dash: row.dashed ? [5, 4] : null, alpha: 0.75 });
    }
  }

  // --- bounds: union of everything drawn so far ---
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  const ext = (x, y) => { if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y; };
  for (const p of prims) { ext(p.box[0], p.box[1]); ext(p.box[2], p.box[3]); }
  if (!prims.length) { ext(-10, -10); ext(10, 10); }
  bMinX -= 6; bMinY -= 6; bMaxX += 6; bMaxY += 6;

  // --- scale bar ---
  if (s.showScale && L.useLen) {
    const unit = unr ? usx : sx;
    const step = niceStep((s.treeWidth / unit) / 5);
    const len = step * unit;
    const x0 = bMinX + 8, y0 = bMaxY + 18;
    P(new Path().M(x0, y0 - 4).V(y0).H(x0 + len).V(y0 - 4), { stroke: th.text, lw: 1.2 });
    T(x0 + len / 2, y0 + 10, 0, fmtNum(step), { size: 11, fill: th.text, anchor: 'middle' });
    ext(x0, y0 + 18);
  }

  // --- legend ---
  if (s.showLegend && legendBlocks.length) {
    const scale = Math.max(1, Math.min(6, Math.max(bMaxX - bMinX, bMaxY - bMinY) / 1400));
    const size = blk => {
      let h = blk.title ? 18 : 0, w = blk.title ? measure(blk.title, 12, true, false, font) : 0;
      if (blk.gradient) { h += 30; w = Math.max(w, 120); }
      for (const it of blk.items || []) { h += 16; w = Math.max(w, 18 + measure(String(it.label), 11, false, false, font)); }
      return [w * scale, h * scale];
    };
    const drawBlock = (blk, X, Y) => {
      const k = scale;
      let y = Y;
      if (blk.title) { T(X, y + 6 * k, 0, blk.title, { size: 12 * k, bold: true, fill: th.text }); y += 18 * k; }
      if (blk.gradient) {
        const g = blk.gradient;
        prims.push({ k: 'g', x: X, y, w: 120 * k, h: 12 * k, stops: g.stops, box: [X, y, X + 120 * k, y + 12 * k] });
        T(X, y + 20 * k, 0, fmtNum(g.min), { size: 10 * k, fill: th.text });
        T(X + 120 * k, y + 20 * k, 0, fmtNum(g.max), { size: 10 * k, fill: th.text, anchor: 'end' });
        y += 30 * k;
      }
      for (const it of blk.items || []) {
        const sh = shapePath(it.shape || 1, X + 6 * k, y + 6 * k, 10 * k);
        P(sh.path, sh.strokeOnly ? { stroke: it.color, lw: 1.5 * k } : { fill: it.color });
        T(X + 18 * k, y + 6 * k, 0, String(it.label), { size: 11 * k, fill: th.text });
        y += 16 * k;
      }
    };
    const sized = legendBlocks.map(b => ({ b, wh: size(b) }));
    if (opt.legendBelow) {
      const x0 = bMinX + 8, maxX = Math.max(bMaxX, x0 + 300 * scale);
      let x = x0, y = bMaxY + 24 * scale, rowMax = 0;
      for (const { b, wh } of sized) {
        if (x > x0 && x + wh[0] > maxX) { x = x0; y += rowMax + 12 * scale; rowMax = 0; }
        drawBlock(b, x, y);
        x += wh[0] + 24 * scale;
        rowMax = Math.max(rowMax, wh[1]);
      }
      ext(x0, y + rowMax);
    } else {
      const x = bMaxX + 30 * scale;
      let y = bMinY + 6, w = 0;
      for (const { b, wh } of sized) { drawBlock(b, x, y); y += wh[1] + 10 * scale; w = Math.max(w, wh[0]); }
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
    rows: { mode, rect, circ, rowH, da, ang0: s.rotation, full, n, tips: L.tips.map(f => f.n.id), treeEnd: rect ? L.maxX * sx : rad(L.maxX), cells: cellHits },
    overlay,
    font,
  };
}
