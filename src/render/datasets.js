/* Dataset renderers. Each draws into the scene through the context G built in scene.js
   (geometry helpers, primitive emitters, layout). Covers every iTOL dataset type. */
import * as Tree from '../core/tree.js';
import { parseTrees } from '../io/newick.js';
import { computeLayout } from '../core/layout.js';
import { safeColor, paletteColor, ramp, RAMPS, contrastText } from './color.js';
import { Path, polar, shapePath, glyph, DOMAIN_SHAPES } from './geom.js';
import { consensus } from './residues.js';
import { fmtNum, maxOf, minOf, parseTags } from './util.js';

const EXTERNAL = new Set(['colorstrip', 'simplebar', 'heatmap', 'binary', 'shapes', 'domains', 'arrows', 'alignment', 'boxplot', 'linechart']);

export function isAligned(ds) {
  if (EXTERNAL.has(ds.type)) return true;
  if (ds.type === 'multibar') return !(ds.opts && ds.opts.onBranch);
  if (ds.type === 'text') return ds.rows.some(r => !(r.position >= 0));
  if (ds.type === 'pie' || ds.type === 'image' || ds.type === 'symbol') return ds.rows.some(r => r.position < 0);
  return false;
}

function valueFn(ds, G) {
  const map = G.leafMap(ds);
  return f => {
    if (!f.collapsed) return map.get(f.n.name);
    for (const l of Tree.leaves(f.n)) { const v = map.get(l.name); if (v) return v; }
    return undefined;
  };
}

function pie(G, cx, cy, r, values, fields, polarArea = false) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !(r > 0)) return;
  const vmax = maxOf(values, 0);
  let a = -90;
  values.forEach((v, i) => {
    const sweep = polarArea ? 360 / values.length : v / total * 360;
    const rr = polarArea ? r * Math.sqrt(v / (vmax || 1)) : r;
    if (v > 0 && rr > 0) {
      const c = safeColor((fields[i] || {}).color, paletteColor(i));
      const p = new Path();
      if (sweep >= 359.99) p.circle(cx, cy, rr);
      else {
        const [x0, y0] = polar(rr, a), [x1, y1] = polar(rr, a + sweep);
        p.M(cx, cy).L(cx + x0, cy + y0);
        p.d += `A${rr},${rr} 0 ${sweep > 180 ? 1 : 0} 1 ${Math.round((cx + x1) * 100) / 100},${Math.round((cy + y1) * 100) / 100}Z`;
        p.ext(cx - rr, cy - rr); p.ext(cx + rr, cy + rr);
      }
      G.P(p, { fill: c, stroke: G.th.bg, lw: 0.5 });
    }
    a += sweep;
  });
}

function image(G, url, cx, cy, size, rot) {
  if (!(size > 0)) return;
  const h = size / 2;
  G.prims.push({ k: 'i', url, x: cx, y: cy, w: size, h: size, rot: rot || 0, box: [cx - h * 1.42, cy - h * 1.42, cx + h * 1.42, cy + h * 1.42] });
}

const fieldLegend = (ds, shape = 1) => ds.legend || { title: ds.label, items: (ds.fields || []).map((fd, i) => ({ color: safeColor(fd.color, paletteColor(i)), label: fd.label, shape: fd.shape || shape })) };

// Vertical (rectangular) or circular scale lines across a dataset column: DATASET_SCALE.
function scaleLines(G, ds, X) {
  const sc = ds.common && ds.common.scale;
  if (!sc || !sc.length) return;
  for (const line of sc) {
    const x = X(line.value);
    if (!isFinite(x)) continue;
    const c = line.color || G.th.guide;
    G.P(G.axisPath(x), { stroke: c, lw: line.width || 1, dash: line.dashed ? [4, 3] : null }, G.back);
    if (G.rect) G.T(x, G.ny * G.rowH - G.rowH / 2 + 8, 0, line.label || fmtNum(line.value), { size: G.headerFs * 0.85 * (line.labelScale || 1), fill: c === G.th.guide ? G.th.muted : c, anchor: 'middle' });
  }
}

function cellText(G, x, y, text, size, bg, color, auto) {
  G.T(x, y, 0, text, { size, fill: color || (auto && bg ? contrastText(bg) : G.th.text), anchor: 'middle' });
}

// Returns the width used.
export function drawAligned(ds, d0, G) {
  const { s, th, rect, L, rowH, P, T } = G;
  const c = ds.common || {};
  const value = valueFn(ds, G);
  const color = safeColor(ds.color, '#4e79a7');
  let w = ds.width || 20;
  const fs = Math.max(5, s.fontSize * 0.7 * (c.labelSizeFactor || 1));
  const hf = Math.max(0.05, Math.min(1, 0.72 * (c.heightFactor || 1)));

  switch (ds.type) {
    case 'colorstrip': {
      const o = ds.opts || {};
      const byColor = new Map(), border = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const col = safeColor(row.color, '#ccc');
        if (!byColor.has(col)) byColor.set(col, new Path());
        G.band(byColor.get(col), d0, d0 + w, f, f.slot);
        if (c.borderWidth > 0 && o.completeBorder) G.band(border, d0, d0 + w, f, f.slot);
        if (o.showLabels && row.label && rect) cellText(G, d0 + w / 2, f.py, row.label, fs * (o.labelSize || 1), col, o.labelColor, o.labelAuto);
      }
      for (const [col, p] of byColor) P(p, { fill: col });
      if (c.borderWidth > 0) {
        if (!o.completeBorder) { border.M(...G.loc(d0, -0.5, L.tips[0] || { py: 0, a: 0 })); P(G.axisPath(d0), { stroke: c.borderColor, lw: c.borderWidth }); P(G.axisPath(d0 + w), { stroke: c.borderColor, lw: c.borderWidth }); }
        else P(border, { stroke: c.borderColor, lw: c.borderWidth });
      }
      if (rect) G.header(d0 + w / 2, ds.label);
      const leg = new Map();
      for (const row of ds.rows) if (!leg.has(row.color)) leg.set(row.color, row.label || row.color);
      G.legend(ds.legend || { title: ds.label, items: [...leg].slice(0, 40).map(([col, l]) => ({ color: safeColor(col, '#ccc'), label: l, shape: 1 })) });
      return w;
    }

    case 'simplebar': {
      const tv = v => (c.logScale ? (v > 0 ? Math.log10(v) : 0) : v);
      const zero = tv((ds.opts && ds.opts.barZero) || 0);
      const vals = ds.rows.map(r => tv(r.value));
      const lo = Math.min(zero, minOf(vals, zero)), hi = Math.max(zero, maxOf(vals, zero));
      const X = v => d0 + (hi > lo ? (tv(v) - lo) / (hi - lo) : 0) * w;
      const Xt = t => d0 + (hi > lo ? (t - lo) / (hi - lo) : 0) * w;
      const bars = new Path(), borders = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const a = Xt(zero), b = X(row.value);
        if (Math.abs(b - a) < 0.01) continue;
        G.band(bars, Math.min(a, b), Math.max(a, b), f, hf);
        if (c.borderWidth > 0) G.band(borders, Math.min(a, b), Math.max(a, b), f, hf);
        if (c.showValue && rect) {
          const txt = row.label && ds.itol && ds.itol.SHOW_LABELS && ds.itol.SHOW_LABELS[0] === '1' ? row.label : fmtNum(row.value);
          const inside = /inside/.test(c.labelPosition || '');
          T(inside ? b - 2 : b + 3, f.py, 0, txt, { size: fs, fill: c.labelColor || (inside ? contrastText(color) : th.text), anchor: inside ? 'end' : 'start' });
        }
      }
      P(G.axisPath(Xt(zero)), { stroke: th.guide, lw: 1 });
      scaleLines(G, ds, X);
      P(bars, { fill: color });
      if (borders.n) P(borders, { stroke: c.borderColor, lw: c.borderWidth });
      if (rect) G.header(d0 + w / 2, `${ds.label} (${c.logScale ? 'log, ' : ''}max ${fmtNum(maxOf(ds.rows.map(r => r.value)))})`);
      G.legend(ds.legend || { title: ds.label, items: [{ color, label: `max ${fmtNum(maxOf(ds.rows.map(r => r.value)))}`, shape: 1 }] });
      return w;
    }

    case 'multibar': {
      const o = ds.opts || {};
      const nF = Math.max(1, ds.fields.length);
      const tv = v => (c.logScale ? (v > 0 ? Math.log10(v + 1) : 0) : Math.max(0, v || 0));
      const fieldPaths = ds.fields.map(() => new Path());
      const fcolor = i => safeColor((ds.fields[i] || {}).color, paletteColor(i));
      if (o.alignFields) {
        const cw = w / nF;
        const maxF = ds.fields.map((_, i) => maxOf(ds.rows.map(r => tv(r.values[i])), 1e-12));
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          row.values.forEach((v, i) => {
            const len = tv(v) / maxF[i] * cw * 0.92;
            if (len > 0 && fieldPaths[i]) G.band(fieldPaths[i], d0 + i * cw, d0 + i * cw + len, f, hf);
            if (c.showValue && rect && len > 0) T(d0 + i * cw + len + 2, f.py, 0, fmtNum(v), { size: fs * 0.9, fill: c.labelColor || th.text });
          });
        }
        for (let i = 0; i < nF; i++) P(G.axisPath(d0 + i * cw), { stroke: th.guide, lw: 1 });
        if (rect) ds.fields.forEach((fd, i) => G.header(d0 + (i + 0.5) * cw, fd.label));
      } else if (o.sideStacked) {
        const max = maxOf(ds.rows.flatMap(r => r.values.map(tv)), 1e-12);
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          const sub = hf / nF;
          row.values.forEach((v, i) => {
            const len = tv(v) / max * w;
            if (len <= 0 || !fieldPaths[i]) return;
            const vc = -hf / 2 + (i + 0.5) * sub;
            G.quad(fieldPaths[i], f, d0, d0 + len, vc - sub * 0.45 * f.slot, vc + sub * 0.45 * f.slot);
          });
        }
        P(G.axisPath(d0), { stroke: th.guide, lw: 1 });
        if (rect) G.header(d0 + w / 2, ds.label);
      } else {
        const max = maxOf(ds.rows.map(r => r.values.reduce((a, v) => a + tv(v), 0)), 1e-12);
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          let acc = d0;
          row.values.forEach((v, i) => {
            const len = tv(v) / max * w;
            if (len <= 0 || !fieldPaths[i]) return;
            G.band(fieldPaths[i], acc, acc + len, f, hf);
            if (c.showValue && rect && len > fs * 1.5) cellText(G, acc + len / 2, f.py, fmtNum(v), fs * 0.85, fcolor(i), c.labelColor, true);
            acc += len;
          });
        }
        P(G.axisPath(d0), { stroke: th.guide, lw: 1 });
        scaleLines(G, ds, v => d0 + v / max * w);
        if (rect) G.header(d0 + w / 2, `${ds.label} (max ${fmtNum(max)})`);
      }
      fieldPaths.forEach((p, i) => { if (p.n) P(p, { fill: fcolor(i), ...(c.borderWidth > 0 ? { stroke: c.borderColor, lw: c.borderWidth } : {}) }); });
      G.legend(fieldLegend(ds));
      return w;
    }

    case 'heatmap': {
      const o = ds.opts || {};
      const nF = maxOf(ds.rows.map(r => r.values.length), Math.max(1, (ds.fields || []).length));
      // Optional normalisation by rows (each node) or columns (each field).
      const rowsN = new Map();
      const norm = (vals) => {
        const xs = vals.filter(v => v != null && isFinite(v));
        if (!xs.length) return vals;
        const mn = minOf(xs), mx = maxOf(xs), mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
        const [A, B] = o.normRange && o.normRange.length === 2 ? o.normRange : [0, 1];
        return vals.map(v => (v == null || !isFinite(v) ? v
          : o.normType === 'mean' ? (mx > mn ? (v - mean) / (mx - mn) : 0)
            : o.normType === 'scaling' ? (v - mean) / sd
              : A + (mx > mn ? (v - mn) * (B - A) / (mx - mn) : 0)));
      };
      if (o.normalize === 'rows') for (const r of ds.rows) rowsN.set(r, norm(r.values));
      else if (o.normalize === 'columns') {
        const cols = Array.from({ length: nF }, (_, i) => norm(ds.rows.map(r => r.values[i])));
        ds.rows.forEach((r, j) => rowsN.set(r, cols.map(col => col[j])));
      }
      const shown = r => rowsN.get(r) || r.values;
      const all = ds.rows.flatMap(shown).filter(v => v != null && isFinite(v));
      const min = !o.normalize && o.min != null ? o.min : minOf(all);
      const max = !o.normalize && o.max != null ? o.max : maxOf(all);
      const fn = ramp((o.stops && o.stops.length ? o.stops : RAMPS.Viridis).map(col => safeColor(col, '#888')));
      const cell = w / nF;
      const byColor = new Map(), borders = new Path();
      const add = (col, f, i) => { if (!byColor.has(col)) byColor.set(col, new Path()); G.band(byColor.get(col), d0 + i * cell, d0 + (i + 1) * cell, f, f.slot); };
      const fmtVal = v => (o.sci ? Number(v).toExponential(o.roundValues != null ? o.roundValues : 1) : o.roundValues != null ? Number(v).toFixed(o.roundValues) : fmtNum(v));
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const vals = shown(row);
        for (let i = 0; i < nF; i++) {
          const v = vals[i];
          if (v == null || !isFinite(v)) { if (o.nanColor) add(o.nanColor, f, i); continue; }
          const col = fn(max > min ? (v - min) / (max - min) : 0.5);
          add(col, f, i);
          if (c.borderWidth > 0) G.band(borders, d0 + i * cell, d0 + (i + 1) * cell, f, f.slot);
          if (o.displayValues && rect && cell > fs * 1.2) {
            const dv = o.displayValues === 'normalized' ? v : row.values[i];
            cellText(G, d0 + (i + 0.5) * cell, f.py, fmtVal(dv), Math.min(fs, cell * 0.35), col, c.labelColor, true);
          }
        }
      }
      for (const [col, p] of byColor) P(p, { fill: col });
      if (borders.n) P(borders, { stroke: c.borderColor, lw: c.borderWidth });
      if (rect) {
        if (nF > 1) (ds.fields || []).forEach((fd, i) => G.header(d0 + (i + 0.5) * cell, fd.label));
        else G.header(d0 + w / 2, ds.label);
      }
      if (all.length) G.legend(ds.legend || { title: ds.label + (o.normalize ? ` (normalized by ${o.normalize})` : ''), gradient: { stops: [0, 0.25, 0.5, 0.75, 1].map(fn), min, max } });
      return w;
    }

    case 'binary':
    case 'shapes': {
      const nF = Math.max(1, (ds.fields || []).length);
      const cell = w / nF;
      const vmax = ds.type === 'shapes' ? maxOf(ds.rows.flatMap(r => r.values), 1e-12) : 1;
      const byField = ds.fields.map(() => ({ fill: new Path(), line: new Path() }));
      const grid = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (c.horizontalGrid && row) G.line(grid, f, d0, d0 + w, 0);
        if (!row) continue;
        row.values.forEach((v, i) => {
          const fd = ds.fields[i];
          if (!fd) return;
          const u = d0 + (i + 0.5) * cell;
          const base = Math.max(2, Math.min(cell, G.slotPx(u)) * 0.75);
          let size, filled;
          if (ds.type === 'binary') { if (v !== 1 && v !== 0) return; size = base; filled = v === 1; }
          else { if (!(v > 0)) return; size = base * Math.sqrt(v / vmax); filled = ds.opts.filled !== false; }
          const [cx, cy] = G.loc(u, 0, f);
          const sh = glyph(ds.type === 'binary' ? fd.shape || 2 : ds.opts.shape, cx, cy, size, filled ? byField[i].fill : byField[i].line);
          if (sh.strokeOnly && filled) glyph(6, cx, cy, size, byField[i].line);
          if (ds.type === 'shapes' && c.showValue && rect) T(cx, cy - size / 2 - fs * 0.6, 0, fmtNum(v), { size: fs * 0.8, fill: c.labelColor || th.text, anchor: 'middle' });
        });
      }
      if (c.verticalGrid) for (let i = 0; i < nF; i++) grid.d += G.axisPath(d0 + (i + 0.5) * cell).d;
      if (grid.d) P(grid, { stroke: c.gridColor || th.guide, lw: c.gridWidth || 1, dash: c.dashedLines === false ? null : [2, 2] }, G.back);
      byField.forEach((g, i) => {
        const col = safeColor(ds.fields[i].color, '#333');
        if (g.fill.n) P(g.fill, { fill: col });
        if (g.line.n) P(g.line, { stroke: col, lw: 1 });
      });
      if (rect) ds.fields.forEach((fd, i) => G.header(d0 + (i + 0.5) * cell, fd.label));
      G.legend(ds.legend || { title: ds.label, items: ds.fields.map(fd => ({ color: safeColor(fd.color, '#333'), label: fd.label, shape: ds.type === 'binary' ? fd.shape || 2 : ds.opts.shape })) });
      return w;
    }

    case 'text': {
      let maxW = 0;
      const sf = (ds.opts && ds.opts.sizeFactor) || 1;
      for (const f of L.tips) {
        const row = value(f);
        if (!row || !row.label || row.position >= 0) continue;
        const size = s.fontSize * (row.size || 1) * sf;
        const bold = /bold/.test(row.style || ''), italic = /italic/.test(row.style || '');
        const [x, y] = G.loc(d0 + 2, 0, f);
        const fill = safeColor(row.color, th.text);
        const runs = parseTags(row.label);
        const a = rect ? 0 : f.a;
        const prim = runs ? G.R(x, y, a, runs, { size, fill }) : T(x, y, a, row.label, { size, bold, italic, fill, ...(rect && row.rotation ? { rot: row.rotation } : {}) });
        maxW = Math.max(maxW, runs ? prim.w : G.measure(row.label, size, bold, italic, G.font));
      }
      w = ds.width || maxW + 6;
      if (rect) G.header(d0 + 4, ds.label);
      return w;
    }

    case 'domains': {
      const o = ds.opts || {};
      const maxLen = maxOf(ds.rows.map(r => r.length), 1);
      const X = v => d0 + v / maxLen * w;
      const back = new Path();
      const byColor = new Map();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const len = X(row.length) - d0;
        const bh = (o.backboneHeight || 2) / 2;
        G.quad(back, f, d0, d0 + len, -bh / G.slotPx(d0 + len / 2), bh / G.slotPx(d0 + len / 2));
        for (const dm of row.domains) {
          if (dm.shape === 'GP') continue;
          const shapeKey = DOMAIN_SHAPES[dm.shape] ? dm.shape : 'RE';
          const u0 = X(dm.start), u1 = X(dm.end);
          const col = safeColor(dm.color, '#888');
          if (!byColor.has(col)) byColor.set(col, new Path());
          byColor.get(col).poly(DOMAIN_SHAPES[shapeKey].map(([u, v]) => G.loc(u0 + u * (u1 - u0), v * 0.38 * hf / 0.72, f)));
          if (rect && o.showLabels !== false && dm.label && u1 - u0 > 14) {
            const lfs = Math.min(rowH * 0.55, s.fontSize * 0.8);
            if (G.measure(dm.label, lfs, false, false, G.font) < u1 - u0 - 2) T((u0 + u1) / 2, f.py, 0, dm.label, { size: lfs, fill: contrastText(col), anchor: 'middle' });
          }
        }
      }
      if (back.n) P(back, { fill: safeColor(o.backbone, '#aaa') });
      for (const [col, p] of byColor) P(p, { fill: col, stroke: c.borderWidth > 0 ? c.borderColor : 'rgba(0,0,0,0.35)', lw: c.borderWidth > 0 ? c.borderWidth : 0.5 });
      scaleLines(G, ds, X);
      if (rect) G.header(d0 + w / 2, ds.label);
      const leg = new Map();
      for (const r of ds.rows) for (const dm of r.domains) if (dm.label && !leg.has(dm.label)) leg.set(dm.label, [safeColor(dm.color, '#888'), dm.shape]);
      if (leg.size) G.legend(ds.legend || { title: ds.label, items: [...leg].slice(0, 40).map(([l, [col, sh]]) => ({ color: col, label: l, shape: DOMAIN_SHAPES[sh] ? sh : 1 })) });
      return w;
    }

    case 'arrows': {
      const o = ds.opts || {};
      const maxLen = maxOf(ds.rows.map(r => r.length), 1);
      const X = v => d0 + v / maxLen * w;
      const back = new Path();
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        const bh = (o.backboneHeight || 2) / 2 / G.slotPx(d0 + w / 2);
        G.quad(back, f, d0, X(row.length), -bh, bh);
        for (const ar of row.arrows) {
          let x0 = X(Math.min(ar.start, ar.end)), x1 = X(Math.max(ar.start, ar.end));
          const H = 0.45 * hf / 0.72 * (ar.hf || 1), B = H * (ar.bhf || 1);
          const maxHead = (x1 - x0) / 2;
          const hl = Math.min(Math.abs(ar.headL), maxHead), hr = Math.min(Math.abs(ar.headR), maxHead);
          const pts = [];
          // left end (bottom -> top)
          if (ar.headL > 0) pts.push([x0 + hl, B], [x0 + hl, H], [x0, 0], [x0 + hl, -H], [x0 + hl, -B]);
          else if (ar.headL < 0) pts.push([x0, B], [x0 + hl, 0], [x0, -B]);
          else pts.push([x0, B], [x0, -B]);
          // right end (top -> bottom)
          if (ar.headR > 0) pts.push([x1 - hr, -B], [x1 - hr, -H], [x1, 0], [x1 - hr, H], [x1 - hr, B]);
          else if (ar.headR < 0) pts.push([x1, -B], [x1 - hr, 0], [x1, B]);
          else pts.push([x1, -B], [x1, B]);
          const poly = new Path().poly(pts.map(([u, v]) => G.loc(u, v, f)));
          const [gx0, gy0] = G.loc(x0, 0, f), [gx1, gy1] = G.loc(x1, 0, f);
          P(poly, ar.c0 !== ar.c1
            ? { fill: 'grad', grad: { x0: gx0, y0: gy0, x1: gx1, y1: gy1, stops: [ar.c0, ar.c1] }, ...(c.borderWidth > 0 ? { stroke: c.borderColor, lw: c.borderWidth } : {}) }
            : { fill: ar.c0, ...(c.borderWidth > 0 ? { stroke: c.borderColor, lw: c.borderWidth } : {}) });
          for (const mk of ar.marks) {
            const m0 = X(mk.start), m1 = Math.max(X(mk.end), m0 + 0.5);
            P(G.quad(new Path(), f, m0, m1, -B, B), { fill: mk.color });
          }
          if (rect && o.showLabels !== false && ar.label) {
            const lfs = Math.min(rowH * 0.5, s.fontSize * 0.75 * (c.labelSizeFactor || 1));
            const tw = G.measure(ar.label, lfs, false, false, G.font);
            if (o.labelsOnTop || tw > x1 - x0) T((x0 + x1) / 2, f.py - H * rowH - lfs * 0.6, 0, ar.label, { size: lfs, fill: th.text, anchor: 'middle' });
            else T((x0 + x1) / 2, f.py, 0, ar.label, { size: lfs, fill: ar.labelColor || contrastText(ar.c0), anchor: 'middle' });
          }
        }
      }
      if (back.n) P(back, { fill: safeColor(o.backbone, '#aaa') }, G.back);
      scaleLines(G, ds, X);
      if (rect) G.header(d0 + w / 2, ds.label);
      if (ds.legend) G.legend(ds.legend);
      return w;
    }

    case 'alignment': {
      if (!rect) return 0;
      const o = ds.opts || {};
      const crop = sq => (o.start || o.end ? sq.slice(Math.max(0, (o.start || 1) - 1), o.end || sq.length) : sq);
      let seqs = L.tips.map(f => { const r = value(f); return r ? crop(r.seq) : null; });
      const len = maxOf(seqs.map(q => (q ? q.length : 0)), 0);
      if (!len) return 0;
      const cellW = o.cell || 4;
      w = len * cellW;
      const refs = new Set((o.references || []).map(id => { const nd = Tree.resolveSpec(G.index, id); return nd && nd.name; }).filter(Boolean));
      const cons = (o.consensus || o.conservation || o.highlight === 'consensus') ? consensus(seqs, o.threshold || 50, o.ignoreGaps) : null;
      if (o.highlight) {
        const same = o.disagreements ? (a, b) => a !== b : (a, b) => a === b;
        let ref = null;
        seqs = seqs.map((sq, i) => {
          if (!sq) return sq;
          const name = L.tips[i].n.name;
          if (o.highlight === 'reference') {
            if (refs.has(name)) { ref = sq; return sq; }
            if (!ref) return sq;
          }
          const base = o.highlight === 'reference' ? ref : cons.consensus;
          let outS = '';
          for (let k = 0; k < sq.length; k++) outS += same(sq[k], base[k]) && sq[k] !== '-' ? '.' : sq[k];
          return outS;
        });
      }
      const scheme = o.customSchemes && o.customSchemes[o.scheme] ? o.customSchemes[o.scheme] : o.scheme || 'auto';
      const ys = L.tips.map(f => f.py);
      const uniform = ys.every((y, i) => i === 0 || Math.abs(y - ys[i - 1] - rowH) < 1e-6);
      const y0 = minOf(ys) - rowH / 2, y1 = maxOf(ys) + rowH / 2;
      G.prims.push({ k: 'a', x: d0, w, rowH, ys, rows: seqs, len, scheme, uniform, box: [d0, y0, d0 + w, y1] });
      if (o.markReferences && refs.size) {
        const box = new Path();
        L.tips.forEach((f, i) => { if (refs.has(f.n.name) && seqs[i]) box.rect(d0, f.py - rowH / 2, w, rowH); });
        if (box.n) P(box, { stroke: o.refBorder || '#000', lw: 1.5, ...(o.refFill ? { fill: o.refFill, alpha: 0.9 } : {}) });
      }
      let yb = y1 + 4;
      if (cons && o.consensus) {
        G.prims.push({ k: 'a', x: d0, w, rowH, ys: [yb + rowH / 2], rows: [cons.consensus.slice(0, len)], len, scheme, uniform: true, box: [d0, yb, d0 + w, yb + rowH] });
        T(d0 - 4, yb + rowH / 2, 0, 'Consensus', { size: G.headerFs * 0.8, fill: th.muted, anchor: 'end' });
        yb += rowH + 4;
      }
      if (cons && o.conservation) {
        const bars = new Path(), hMax = rowH * 2;
        cons.conservation.slice(0, len).forEach((v, k) => { if (v > 0) bars.rect(d0 + k * cellW, yb + hMax * (1 - v), cellW, hMax * v); });
        P(bars, { fill: '#6b7686' });
        T(d0 - 4, yb + hMax / 2, 0, 'Conservation', { size: G.headerFs * 0.8, fill: th.muted, anchor: 'end' });
      }
      G.header(d0 + 4, `${ds.label} (${len} columns)`);
      return w;
    }

    case 'boxplot': {
      const lo = minOf(ds.rows.map(r => Math.min(r.min, ...r.extremes))), hi = maxOf(ds.rows.map(r => Math.max(r.max, ...r.extremes)));
      const X = v => d0 + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * w;
      const lines = new Path(), boxes = new Path(), dots = new Path();
      const hh = 0.32 * hf / 0.72;
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        G.line(lines, f, X(row.min), X(row.max), 0);
        G.line(lines, f, X(row.min), X(row.min), hh * 0.8, -hh * 0.8);
        G.line(lines, f, X(row.max), X(row.max), hh * 0.8, -hh * 0.8);
        boxes.poly([G.loc(X(row.q1), -hh, f), G.loc(X(row.q3), -hh, f), G.loc(X(row.q3), hh, f), G.loc(X(row.q1), hh, f)]);
        G.line(lines, f, X(row.median), X(row.median), -hh, hh);
        for (const e of row.extremes) {
          const [x, y] = G.loc(X(e), 0, f), r = Math.max(0.8, Math.min(2.5, G.slotPx(X(e)) * 0.12));
          dots.M(x - r, y - r).L(x + r, y + r).M(x - r, y + r).L(x + r, y - r);
        }
      }
      P(G.axisPath(d0), { stroke: th.guide, lw: 1 });
      scaleLines(G, ds, X);
      P(boxes, { fill: color, alpha: 0.55 });
      P(boxes, { stroke: c.borderWidth > 0 ? c.borderColor : th.text, lw: c.borderWidth > 0 ? c.borderWidth : 0.8 });
      P(lines, { stroke: th.text, lw: 0.8 });
      if (dots.n) P(dots, { stroke: th.text, lw: 0.8 });
      if (rect) G.header(d0 + w / 2, `${ds.label} (${fmtNum(lo)} – ${fmtNum(hi)})`);
      if (ds.legend) G.legend(ds.legend);
      return w;
    }

    case 'linechart': {
      const o = ds.opts || {};
      const pts = ds.rows.flatMap(r => r.points);
      const x0 = minOf(pts.map(q => q[0])), x1 = maxOf(pts.map(q => q[0]));
      const y0 = minOf(pts.map(q => q[1])), y1 = maxOf(pts.map(q => q[1]));
      const U = x => d0 + (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5) * w;
      const V = y => 0.4 * hf / 0.72 - (y1 > y0 ? (y - y0) / (y1 - y0) : 0.5) * 0.8 * hf / 0.72;
      const lineColor = o.lineColor || color, dotColor = o.dotColor || color;
      const colorAt = y => { if (!o.lineColors) return null; for (const lc of o.lineColors) if (y <= lc.value) return lc.color; return o.lineColors[o.lineColors.length - 1].color; };
      const segs = new Map(), dots = new Map(), grid = new Path();
      const seg = col => { if (!segs.has(col)) segs.set(col, new Path()); return segs.get(col); };
      const dot = col => { if (!dots.has(col)) dots.set(col, new Path()); return dots.get(col); };
      for (const f of L.tips) {
        const row = value(f);
        if (!row) continue;
        for (const ax of o.axisX || []) if (ax >= y0 && ax <= y1) G.line(grid, f, d0, d0 + w, V(ax));
        for (const ax of o.axisY || []) if (ax >= x0 && ax <= x1) G.line(grid, f, U(ax), U(ax), V(y0), V(y1));
        const sorted = row.points.slice().sort((a, b) => a[0] - b[0]);
        sorted.forEach(([x, y], i) => {
          const q = G.loc(U(x), V(y), f);
          const col = colorAt(y);
          if (o.line !== false && i) { const pq = G.loc(U(sorted[i - 1][0]), V(sorted[i - 1][1]), f); seg(col || lineColor).M(...pq).L(...q); }
          if (o.dots !== false) dot(col || dotColor).circle(q[0], q[1], Math.max(0.5, (o.dotSize || 2) / 2));
        });
      }
      if (grid.n) P(grid, { stroke: th.guide, lw: 0.6 }, G.back);
      P(G.axisPath(d0), { stroke: th.guide, lw: 1 });
      for (const [col, p] of segs) P(p, { stroke: col, lw: o.lineWidth || Math.max(0.6, G.lw * 0.8) });
      for (const [col, p] of dots) P(p, { fill: col });
      if (rect) G.header(d0 + w / 2, ds.label);
      if (ds.legend) G.legend(ds.legend);
      return w;
    }

    case 'pie': {
      w = ds.width || 30;
      const maxR = maxOf(ds.rows.map(r => r.radius), 1);
      for (const f of L.tips) {
        const row = value(f);
        if (!row || row.position >= 0) continue;
        const r = Math.min(w / 2, G.slotPx(d0 + w / 2) / 2 * f.slot) * Math.sqrt(row.radius / maxR);
        const [cx, cy] = G.loc(d0 + w / 2, 0, f);
        pie(G, cx, cy, r, row.values, ds.fields, ds.opts && ds.opts.polar);
      }
      G.legend(fieldLegend(ds, 2));
      return w;
    }

    case 'image': {
      w = ds.width || 40;
      for (const f of L.tips) {
        const row = value(f);
        if (!row || row.position >= 0) continue;
        const size = Math.min(w, G.slotPx(d0 + w / 2) * 0.95 * f.slot) * (row.size || 1);
        const [cx, cy] = G.loc(d0 + w / 2 + row.dx, 0, f);
        image(G, row.url, cx, cy + row.dy, size, row.rotation);
      }
      return w;
    }

    case 'symbol': {
      // External symbol columns: position -1 is the first column, -2 the second, ...
      const ext = ds.rows.filter(r => r.position < 0);
      const cols = maxOf(ext.map(r => Math.round(-r.position)), 1);
      const maxSize = maxOf(ext.map(r => r.size), 1);
      const cell = (ds.maxSize || 10) + 4;
      w = cols * cell;
      const byStyle = new Map();
      for (const row of ext) {
        for (const node of Tree.resolveSpecs(G.index, row.id)) {
          const f = G.visibleInfo(node);
          if (!f || !f.tip) continue;
          const u = d0 + (Math.round(-row.position) - 0.5) * cell;
          const [x, y] = G.loc(u, 0, f);
          const col = safeColor(row.color, '#888');
          const key = col + (row.filled ? 'f' : 's');
          if (!byStyle.has(key)) byStyle.set(key, { col, filled: row.filled, p: new Path() });
          glyph(row.shape, x, y, Math.max(2, Math.min(G.slotPx(u), cell) * 0.9 * Math.sqrt(row.size / maxSize)), byStyle.get(key).p);
        }
      }
      for (const { col, filled, p } of byStyle.values()) P(p, filled ? { fill: col } : { stroke: col, lw: 1 });
      if (ds.legend) G.legend(ds.legend);
      return w;
    }
  }
  return 0;
}

// Datasets drawn on the tree itself: branch symbols, internal pies/images/text labels.
export function drawOnTree(ds, G) {
  const { P, T, th } = G;
  const each = (row, fn) => { for (const node of Tree.resolveSpecs(G.index, row.id)) { const f = G.infoOf.get(node); if (f) fn(f); } };
  if (ds.type === 'symbol') {
    const rows = ds.rows.filter(r => r.position >= 0);
    const maxSize = maxOf(rows.map(r => r.size), 1);
    for (const row of rows) {
      each(row, f => {
        const [x, y] = G.nodePoint(f, row.position);
        const size = Math.max(2, (row.size / maxSize) * (ds.maxSize || 10));
        const sh = glyph(row.shape, x, y, size);
        const col = safeColor(row.color, '#888');
        if (ds.opts && ds.opts.gradient && row.filled && !sh.strokeOnly) P(sh.path, { fill: 'grad', grad: { x0: x - size / 2, y0: y - size / 2, x1: x + size / 2, y1: y + size / 2, stops: ['#ffffff', col] } });
        else P(sh.path, row.filled && !sh.strokeOnly ? { fill: col } : { stroke: col, lw: 1, dash: sh.dash || null });
      });
    }
    if (ds.legend && !isAligned(ds)) G.legend(ds.legend);
  } else if (ds.type === 'pie' || ds.type === 'image') {
    const maxR = maxOf(ds.rows.map(r => r.radius || 1), 1);
    for (const row of ds.rows) {
      if (!(row.position >= 0)) continue;
      each(row, f => {
        const [x, y] = G.nodePoint(f, row.position);
        if (ds.type === 'pie') pie(G, x, y, Math.max(2, (ds.width || 30) / 2 * Math.sqrt(row.radius / maxR)), row.values, ds.fields, ds.opts && ds.opts.polar);
        else image(G, row.url, x + row.dx, y + row.dy, (ds.width || 40) * (row.size || 1), row.rotation);
      });
    }
    if (ds.type === 'pie' && (G.unr || !isAligned(ds))) G.legend(fieldLegend(ds, 2));
  } else if (ds.type === 'text') {
    const sf = (ds.opts && ds.opts.sizeFactor) || 1;
    for (const row of ds.rows) {
      if (!(row.position >= 0) || !row.label) continue;
      each(row, f => {
        const [x, y] = G.nodePoint(f, row.position);
        const size = G.s.fontSize * (row.size || 1) * sf;
        const fill = safeColor(row.color, th.text);
        const runs = parseTags(row.label);
        const dy = ds.opts && ds.opts.below ? size * 0.7 : -size * 0.7;
        if (runs) G.R(x, y + dy, 0, runs, { size, fill, anchor: 'middle', rot: row.rotation || 0 });
        else T(x, y + dy, 0, row.label, { size, fill, bold: /bold/.test(row.style || ''), italic: /italic/.test(row.style || ''), anchor: 'middle', rot: row.rotation || 0 });
      });
    }
  }
}

// DATASET_RANGE: boxes behind clades/labels, or brackets beside the datasets.
export function drawRange(ds, G) {
  const { rect, circ, unr, rowH, sx, L, P, T, th } = G;
  if (unr) return;
  const o = ds.opts || {};
  const legend = [];
  for (const row of ds.rows) {
    const a = Tree.resolveSpecs(G.index, row.id), b = Tree.resolveSpec(G.index, row.to);
    const ranges = /^CONTAINS==/.test(row.id) ? a.map(x => [x, x]) : a.length && b ? [[a[0], b]] : [];
    for (const [na, nb] of ranges) {
      const fa = G.visibleInfo(na), fb = G.visibleInfo(nb);
      if (!fa || !fb) continue;
      const top = Tree.mrca([na, nb]);
      const ft = G.visibleInfo(top) || fa;
      const y0 = Math.min(fa.ymin, fb.ymin) - 0.5, y1 = Math.max(fa.ymax, fb.ymax) + 0.5;
      const fill = row.fill, line = row.line;
      if (row.label) legend.push({ color: fill || line || ds.color, label: row.label, shape: 1 });
      if (o.rangeType === 'bracket') {
        const x = G.datasetsEnd + (o.bracketShift || 50) / 2;
        const sz = o.bracketSize || 20, p = new Path();
        const col = line || fill || th.text;
        if (rect) {
          const ya = y0 * rowH + 2, yb = y1 * rowH - 2;
          if (o.bracketStyle === 'curved') p.M(x - sz / 2, ya).C(x, ya, x, ya, x, ya + sz / 2).L(x, yb - sz / 2).C(x, yb, x, yb, x - sz / 2, yb);
          else if (o.bracketStyle === 'none') p.M(x, ya).L(x, yb);
          else p.M(x - sz / 2, ya).H(x).V(yb).H(x - sz / 2);
          if (o.showLabels && row.label) T(x + 6, (ya + yb) / 2, 0, row.label, { size: G.s.fontSize * (row.labelSize || 1) * (o.labelSize || 1), fill: row.labelColor || col, bold: /bold/.test(row.labelStyle), italic: /italic/.test(row.labelStyle) });
        } else {
          const r = G.datasetsEnd + (o.bracketShift || 50) / 2, a0 = G.ang(y0) + 0.5, a1 = G.ang(y1) - 0.5;
          p.M(...polar(r - (o.bracketStyle === 'none' ? 0 : sz / 2), a0)).L(...polar(r, a0)).arc(r, a0, a1).L(...polar(r - (o.bracketStyle === 'none' ? 0 : sz / 2), a1));
          if (o.showLabels && row.label) { const am = (a0 + a1) / 2; const [tx, ty] = polar(r + 6, am); T(tx, ty, am, row.label, { size: G.s.fontSize * (row.labelSize || 1), fill: row.labelColor || col }); }
        }
        P(p, { stroke: col, lw: row.lineWidth || 1.5, dash: G.dash(row.lineStyle) });
        continue;
      }
      // Box
      const cover = o.cover || 'clade';
      const treeEnd = rect ? L.maxX * sx : G.rad(L.maxX);
      let x0 = cover === 'tree' ? (rect ? -6 : 0) : cover === 'label' ? treeEnd + 2 : (rect ? ft.px - 4 : Math.max(0, ft.r - 4));
      let x1 = o.coverDatasets ? G.datasetsEnd + 4 : (cover === 'label' || o.coverLabels || cover !== 'clade' || true) && (o.coverLabels || cover === 'label') ? G.labelsEnd + 4 : treeEnd + 4;
      if (cover === 'tree' && !o.coverLabels && !o.coverDatasets) x1 = treeEnd + 4;
      const p = new Path();
      if (rect) p.rect(x0, y0 * rowH, x1 - x0, (y1 - y0) * rowH);
      else p.sector(x0, x1, G.ang(y0), G.ang(y1));
      const style = {};
      if (fill) Object.assign(style, row.gradient
        ? { fill: 'grad', grad: rect ? { x0, y0: 0, x1, y1: 0, stops: [fill, row.gradient] } : { x0: 0, y0: 0, x1: polar(x1, G.ang((y0 + y1) / 2))[0], y1: polar(x1, G.ang((y0 + y1) / 2))[1], stops: [fill, row.gradient] } }
        : { fill });
      if (line) Object.assign(style, { stroke: line, lw: row.lineWidth || 1, dash: G.dash(row.lineStyle) });
      if (style.fill || style.stroke) P(p, style, G.back);
      if (o.showLabels && row.label) {
        const size = G.s.fontSize * (row.labelSize || 1) * (o.labelSize || 1);
        const pos = o.labelPosition || 'center-center';
        if (rect) {
          const [vy, hx] = pos.split('-');
          const ly = vy === 'top' ? y0 * rowH + size : vy === 'bottom' ? y1 * rowH - size * 0.8 : (y0 + y1) / 2 * rowH;
          const lx = hx === 'left' ? x0 + 4 : hx === 'right' ? x1 - 4 : (x0 + x1) / 2;
          T(lx, ly, 0, row.label, { size, fill: row.labelColor || th.text, bold: /bold/.test(row.labelStyle), italic: /italic/.test(row.labelStyle), anchor: hx === 'left' ? 'start' : hx === 'right' ? 'end' : 'middle', ...(o.labelsVertical ? { rot: -90 } : {}) });
        } else {
          const am = G.ang((y0 + y1) / 2), [lx, ly] = polar(x1 - 4, am);
          T(lx, ly, am, row.label, { size, fill: row.labelColor || th.text, anchor: 'end', bold: /bold/.test(row.labelStyle) });
        }
      }
    }
  }
  G.legend(ds.legend || (legend.length ? { title: ds.label, items: legend } : null));
}

// DATASET_TIMESCALE: colored time bands below (or above, or behind) the tree.
export function drawTimescale(ds, G) {
  const { rect, circ, rowH, sx, L, P, T, th } = G;
  if (!L.useLen || !ds.rows.length) return;
  const o = ds.opts || {};
  const H = L.maxX;
  const maxVal = maxOf(ds.rows.map(r => Math.max(r.start, r.end)), 1);
  const factor = o.autoScale ? maxVal / H : (o.scaling || 1);
  const X = v => H - v / factor;
  const height = o.height || 24;
  const yTop = o.above ? -rowH / 2 - height - 40 : (G.ny - 0.5) * rowH + 30;
  for (const r of ds.rows) {
    const xa = Math.max(0, X(Math.max(r.start, r.end))), xb = Math.min(H, X(Math.min(r.start, r.end)));
    if (!(xb > xa)) continue;
    const fill = r.gradient ? 'grad' : r.fill;
    if (rect) {
      const x0 = xa * sx, x1 = xb * sx;
      const grad = { x0, y0: 0, x1, y1: 0, stops: [r.fill, r.gradient || r.fill] };
      if (o.coverTree) P(new Path().rect(x0, -rowH / 2, x1 - x0, G.ny * rowH), { fill, grad, alpha: 0.18 }, G.back);
      if (o.showRanges !== false) {
        P(new Path().rect(x0, yTop, x1 - x0, height), { fill, grad, stroke: th.bg, lw: 0.5 });
        if (o.showRangeLabels !== false && r.label) {
          const size = Math.min(o.rangeLabelSize || 12, height * 0.6);
          if (G.measure(r.label, size, false, false, G.font) < x1 - x0 - 2) T((x0 + x1) / 2, yTop + height / 2, 0, r.label, { size, fill: contrastText(r.fill), anchor: 'middle', bold: /bold/.test(r.style), italic: /italic/.test(r.style) });
        }
      }
      if (o.showValues !== false) T(x0, yTop + height + 9, 0, fmtNum(Math.max(r.start, r.end)), { size: G.headerFs * 0.8, fill: th.muted, anchor: 'middle' });
    } else if (circ) {
      const a0 = G.ang(-0.5), a1 = G.ang(G.ny - 0.5);
      const ra = G.rad(xa), rb = G.rad(xb);
      P(new Path().sector(Math.max(0, ra), rb, a0, a1), { fill: r.fill, alpha: o.coverTree ? 0.18 : 0.12 }, G.back);
      if (r.label) { const [tx, ty] = polar((ra + rb) / 2, a0 - 3); T(tx, ty, 0, r.label, { size: G.headerFs * 0.85, fill: th.muted, anchor: 'middle' }); }
    }
  }
  if (rect && o.showValues !== false) T(H * sx, yTop + height + 9, 0, '0', { size: G.headerFs * 0.8, fill: th.muted, anchor: 'middle' });
}

// DATASET_CONNECTION: lines/curves between nodes, optional arrows and loops.
export function drawConnections(ds, G) {
  const { rect, circ, P } = G;
  const o = ds.opts || {};
  const maxW = maxOf(ds.rows.map(r => r.width), 1);
  const labelPoint = f => {
    if (rect) return [G.datasetsEnd + 8, f.py];
    if (circ) return polar(G.rad(G.L.maxX) + 2, f.a);
    return G.endPoint(f);
  };
  for (const row of ds.rows) {
    const a = Tree.resolveSpec(G.index, row.id), b = Tree.resolveSpec(G.index, row.to);
    const fa = a && G.visibleInfo(a), fb = b && G.visibleInfo(b);
    if (!fa || !fb) continue;
    const lwid = Math.max(0.5, row.width / maxW * Math.min(o.maxWidth || 10, 6));
    const style = { stroke: safeColor(row.color, '#e15759'), lw: lwid, dash: G.dash(row.style) || (row.dashed ? [5, 4] : null), alpha: 0.85, cap: 'round' };
    const p = new Path();
    const align = o.alignToLabels || (rect && !o.curve);
    const pa = align ? labelPoint(fa) : [fa.px, fa.py], pb = align ? labelPoint(fb) : [fb.px, fb.py];
    let tangentEnd;
    if (fa === fb) {
      const r = Math.max(4, (o.loopSize || 100) / 10);
      p.circle(pa[0] + (rect ? r : 0), pa[1], r);
      P(p, style);
      continue;
    }
    if (rect && align) {
      const h = Math.min(400, Math.abs(pa[1] - pb[1]) * 0.45 + 10);
      p.M(...pa).C(pa[0] + h, pa[1], pb[0] + h, pb[1], ...pb);
      tangentEnd = [pb[0] + h, pb[1]];
    } else if ((circ || G.unr) && (o.centerCurves || align)) {
      const k = 0.25;
      p.M(...pa).C(pa[0] * k, pa[1] * k, pb[0] * k, pb[1] * k, ...pb);
      tangentEnd = [pb[0] * k, pb[1] * k];
    } else if (o.curve) {
      const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2, dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      const t = Math.tan(o.curve * Math.PI / 180) / 2;
      const cx = mx - dy * t, cy = my + dx * t;
      p.M(...pa).C(cx, cy, cx, cy, ...pb);
      tangentEnd = [cx, cy];
    } else {
      p.M(...pa).L(...pb);
      tangentEnd = pa;
    }
    P(p, style);
    if (o.arrows) {
      const ang = Math.atan2(pb[1] - tangentEnd[1], pb[0] - tangentEnd[0]);
      const sz = Math.max(4, Math.min(o.arrowSize || 20, 14)) * Math.max(0.6, lwid / 2);
      const head = new Path().poly([pb, [pb[0] - sz * Math.cos(ang - 0.4), pb[1] - sz * Math.sin(ang - 0.4)], [pb[0] - sz * Math.cos(ang + 0.4), pb[1] - sz * Math.sin(ang + 0.4)]]);
      P(head, { fill: style.stroke, alpha: 0.9 });
    }
  }
  if (ds.legend) G.legend(ds.legend);
}

// DATASET_TANGLEGRAM: a second tree mirrored on the right, linked to matching leaves.
const tangleCache = new Map();
export function drawTanglegram(ds, G) {
  const { rowH, L, P, T, th, s } = G;
  const o = ds.opts || {};
  let root = tangleCache.get(o.tree);
  if (!root) {
    try { root = parseTrees(o.tree)[0].root; } catch (e) { return; }
    tangleCache.set(o.tree, root);
  }
  const L2 = computeLayout(root, { branchLengths: s.branchLengths });
  const sx2 = s.treeWidth * 0.8 / L2.maxX;
  const offY = (G.ny - L2.ny) / 2 * rowH;
  const fs = s.fontSize * 0.95;
  const styleMap = new Map(), strips = [];
  for (const r of ds.rows) {
    if (r.kind === 'style') styleMap.set(r.id, r.fields);
    else if (r.kind === 'colorstrip') strips.push({ col: parseInt(r.id, 10) || 1, id: r.fields[0], color: safeColor(r.fields[1], '#ccc') });
  }
  const stripW = 14, nStrips = maxOf(strips.map(x => x.col), 0);
  const labW = o.showLabels ? maxOf(L2.tips.map(f => G.measure(f.n.name || '', fs, false, s.italic, G.font)), 0) + 8 : 0;
  const xc = G.datasetsEnd + (o.gap || 200);
  const tipsX = xc + nStrips * stripW + labW + 6;
  const X = x => tipsX + (L2.maxX - x) * sx2;
  for (const f of L2.infos) { f.px = X(f.x); f.py = f.y * rowH + offY; }
  const byColor = new Map();
  const nodeStyle = f => { const st = styleMap.get(f.n.name); return st && /branch/i.test(st[0]) ? safeColor(st[2], null) : null; };
  for (const f of L2.infos) {
    if (!f.parent) continue;
    const col = nodeStyle(f) || th.branch;
    if (!byColor.has(col)) byColor.set(col, new Path());
    byColor.get(col).M(f.parent.px, f.parent.py).V(f.py).H(f.px);
  }
  for (const [col, p] of byColor) P(p, { stroke: col, lw: G.lw, cap: 'square' });
  const byName = new Map(L2.tips.map(f => [f.n.name, f]));
  for (const f of L2.tips) {
    if (o.showLabels && f.n.name) {
      const st = styleMap.get(f.n.name);
      const col = st && /label/i.test(st[0]) ? safeColor(st[2], th.text) : th.text;
      T(f.px - 4, f.py, 0, f.n.name, { size: fs, fill: col, italic: s.italic, anchor: 'end' });
    }
  }
  for (const sp of strips) {
    const f = byName.get(sp.id);
    if (f) P(new Path().rect(xc + (sp.col - 1) * stripW, f.py - rowH / 2, stripW, rowH), { fill: sp.color });
  }
  // Connections: matching names plus explicit 'connect' rows.
  const conns = [];
  for (const f of L.tips) { const g = byName.get(f.n.name); if (g) conns.push([f, g, null]); }
  for (const r of ds.rows) {
    if (r.kind !== 'connect') continue;
    const a = Tree.resolveSpec(G.index, r.id), fa = a && G.visibleInfo(a), g = byName.get(r.fields[0]);
    if (fa && g) conns.push([fa, g, r.fields]);
  }
  const x0 = G.datasetsEnd + 6, x1 = xc - 4;
  for (const [f, g, fields] of conns) {
    const p = new Path().M(x0, f.py).C(x0 + (x1 - x0) / 2, f.py, x0 + (x1 - x0) / 2, g.py, x1, g.py);
    const width = fields ? parseFloat(fields[1]) || o.connWidth : o.connWidth;
    P(p, { stroke: fields ? safeColor(fields[2], o.connColor) : o.connColor, lw: Math.min(o.maxWidth || 3, width || 1), dash: G.dash(fields ? (fields[3] || '').toLowerCase() : o.connStyle), alpha: 0.85 });
  }
}
