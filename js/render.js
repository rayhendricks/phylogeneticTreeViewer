/* SVG scene renderer. Produces an SVG markup string plus scene bounds. */
(function (global) {
  'use strict';
  const PTV = global.PTV || (global.PTV = {});
  const T = () => PTV.Tree;
  const A = () => PTV.Annotations;

  const DEG = Math.PI / 180;
  const SELECTION_COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#17becf'];
  const r2 = v => Math.round(v * 100) / 100;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const polar = (r, a) => [r * Math.cos(a * DEG), r * Math.sin(a * DEG)];
  const pt = p => `${r2(p[0])},${r2(p[1])}`;
  const maxOf = (arr, init = -Infinity) => arr.reduce((m, v) => (v > m ? v : m), init);
  const minOf = (arr, init = Infinity) => arr.reduce((m, v) => (v < m ? v : m), init);
  const fmtNum = v => {
    if (v == null || !isFinite(v)) return '';
    const a = Math.abs(v);
    return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : String(+v.toPrecision(4));
  };

  function sectorD(r0, r1, a0, a1) {
    if (a1 - a0 >= 359.99) return sectorD(r0, r1, a0, a0 + 180) + sectorD(r0, r1, a0 + 180, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    const p0 = polar(r0, a0), p1 = polar(r1, a0), p2 = polar(r1, a1), p3 = polar(r0, a1);
    return `M${pt(p0)}L${pt(p1)}A${r2(r1)},${r2(r1)} 0 ${large} 1 ${pt(p2)}L${pt(p3)}` +
      (r0 > 0 ? `A${r2(r0)},${r2(r0)} 0 ${large} 0 ${pt(p0)}` : '') + 'Z';
  }

  // iTOL shape codes: 1 square, 2 circle, 3 star, 4 right triangle, 5 left triangle, 6 check mark.
  function shape(code, cx, cy, size, color, filled) {
    const h = size / 2;
    const paint = filled ? `fill="${color}" stroke="${color}"` : `fill="none" stroke="${color}"`;
    switch (+code) {
      case 1: return `<rect x="${r2(cx - h)}" y="${r2(cy - h)}" width="${r2(size)}" height="${r2(size)}" ${paint}/>`;
      case 3: {
        const pts = [];
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? h * 0.45 : h, a = -90 + i * 36;
          pts.push(pt([cx + r * Math.cos(a * DEG), cy + r * Math.sin(a * DEG)]));
        }
        return `<polygon points="${pts.join(' ')}" ${paint}/>`;
      }
      case 4: return `<polygon points="${pt([cx - h, cy - h])} ${pt([cx + h, cy])} ${pt([cx - h, cy + h])}" ${paint}/>`;
      case 5: return `<polygon points="${pt([cx + h, cy - h])} ${pt([cx - h, cy])} ${pt([cx + h, cy + h])}" ${paint}/>`;
      case 6: return `<path d="M${pt([cx - h, cy])}L${pt([cx - h * 0.2, cy + h * 0.8])}L${pt([cx + h, cy - h])}" fill="none" stroke="${color}" stroke-width="${r2(Math.max(1, size / 5))}"/>`;
      default: return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(h)}" ${paint}/>`;
    }
  }

  function colorScale(stops) {
    const interp = (a, b) => (global.d3 ? global.d3.interpolateRgb(a, b) : (t => (t < 0.5 ? a : b)));
    if (stops.length === 2) { const f = interp(stops[0], stops[1]); return t => f(t); }
    const f0 = interp(stops[0], stops[1]), f1 = interp(stops[1], stops[2]);
    return t => (t < 0.5 ? f0(t * 2) : f1((t - 0.5) * 2));
  }

  function labelInfo(f, s) {
    const n = f.n, st = n.style || {};
    let text = st.displayName || n.name || '';
    if (f.collapsed) text = (text ? text + ' ' : '') + `(${f.leafCount})`;
    const ls = st.labelStyle || '';
    return {
      text,
      size: s.fontSize * (st.labelSize || 1),
      bold: ls.includes('bold'),
      italic: s.italic || ls.includes('italic'),
      color: st.labelColor || null,
      bg: st.labelBg || null,
    };
  }

  // Only attributes that differ from the label group defaults.
  function fontAttrs(li, s) {
    return (r2(li.size) !== r2(s.fontSize) ? ` font-size="${r2(li.size)}"` : '') + (li.bold ? ' font-weight="bold"' : '') +
      (li.italic !== !!s.italic ? ` font-style="${li.italic ? 'italic' : 'normal'}"` : '');
  }

  // Map leaf name -> row for an aligned dataset. Clade ids (A|B, internal names) fan out to leaves.
  function leafMap(ds, index) {
    const map = new Map(), leafRows = [];
    for (const row of ds.rows) {
      const node = T().resolveSpec(index, row.id);
      if (!node) continue;
      if (!node.children.length) { leafRows.push([node.name, row]); continue; }
      for (const l of T().leaves(node)) if (!map.has(l.name)) map.set(l.name, row);
    }
    for (const [name, row] of leafRows) map.set(name, row);
    return map;
  }

  function renderScene(m, opt = {}) {
    const s = m.settings;
    const th = opt.theme;
    const interactive = opt.interactive !== false;
    const measure = m.measure;
    const did = f => (interactive ? ` data-id="${f.n.id}"` : '');
    const L = PTV.Layout.computeLayout(m.root, s);
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

    // --- coordinates ---
    if (unr) {
      usx = s.treeWidth / PTV.Layout.equalAngle(L);
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

    function branchD(f) {
      const p = f.parent;
      if (!p) return '';
      if (mode === 'rectangular') return `M${r2(p.px)},${r2(p.py)}V${r2(f.py)}H${r2(f.px)}`;
      if (!circ) return `M${r2(p.px)},${r2(p.py)}L${r2(f.px)},${r2(f.py)}`;
      const corner = polar(p.r, f.a);
      const d = f.a - p.a;
      const arc = p.r > 0 && Math.abs(d) > 1e-9
        ? `A${r2(p.r)},${r2(p.r)} 0 ${Math.abs(d) > 180 ? 1 : 0} ${d > 0 ? 1 : 0} ${pt(corner)}`
        : `L${pt(corner)}`;
      return `M${r2(p.px)},${r2(p.py)}${arc}L${r2(f.px)},${r2(f.py)}`;
    }

    // Rotated text anchored at (x, y) reading outward along angle a.
    function rotText(x, y, a, text, attrs) {
      if (!a) return `<text x="${r2(x)}" y="${r2(y)}" dy=".32em" ${attrs}>${esc(text)}</text>`;
      const flip = Math.cos(a * DEG) < 0;
      return `<text transform="translate(${r2(x)},${r2(y)}) rotate(${r2(flip ? a + 180 : a)})" dy=".32em" text-anchor="${flip ? 'end' : 'start'}" ${attrs}>${esc(text)}</text>`;
    }

    // --- search / selection context ---
    const hits = m.hits || new Set();
    const hitPath = new Set();
    const infoOf = new Map(L.infos.map(f => [f.n, f]));
    const visibleInfo = node => {
      for (let c = node; c; c = c.parent) { const f = infoOf.get(c); if (f) return f; }
      return null;
    };
    if (hits.size) {
      for (const id of hits) {
        const node = m.index.byId.get(id);
        if (!node) continue;
        for (let f = visibleInfo(node); f; f = f.parent) hitPath.add(f);
      }
    }
    const dim = hits.size > 0 && s.dimNonHits;

    // --- labels (measure first: ranges and datasets depend on extent) ---
    const labels = [];
    let labelsEnd = rect ? L.maxX * sx : circ ? rad(L.maxX) : 0;
    const gap = 4 + (s.nodeDots ? 3 : 0);
    if (s.showLeafLabels) {
      for (const f of L.tips) {
        const li = labelInfo(f, s);
        if (!li.text) continue;
        li.w = measure(li.text, li.size, li.bold, li.italic);
        const ep = endPoint(f);
        if (rect) {
          li.x = (s.alignLabels ? L.maxX * sx : ep[0]) + gap; li.y = f.py; li.a = 0;
          li.guideFrom = s.alignLabels && ep[0] < L.maxX * sx - 1 ? ep : null;
          labelsEnd = Math.max(labelsEnd, li.x + li.w);
        } else if (circ) {
          const rl = (s.alignLabels ? rad(L.maxX) : rad(tipEnd(f))) + gap;
          [li.x, li.y] = polar(rl, f.a); li.a = f.a;
          li.guideFrom = s.alignLabels && rad(tipEnd(f)) < rad(L.maxX) - 1 ? ep : null;
          li.guideTo = polar(rad(L.maxX), f.a);
          labelsEnd = Math.max(labelsEnd, rl + li.w);
        } else {
          li.x = ep[0] + gap * Math.cos(f.a * DEG); li.y = ep[1] + gap * Math.sin(f.a * DEG); li.a = f.a || 0.0001;
        }
        li.f = f;
        labels.push(li);
      }
    }

    const out = [];
    const legendBlocks = [];
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    const ext = (x, y) => { if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y; };

    // --- clade ranges ---
    if (!unr) {
      const rangeLegend = new Map();
      const parts = [];
      for (const f of L.infos) {
        const st = f.n.style;
        if (!st || !st.range) continue;
        const c = A().safeColor(st.range, '#ddd');
        if (st.rangeLabel) rangeLegend.set(c + '\u0000' + st.rangeLabel, { color: c, label: st.rangeLabel, shape: 1 });
        if (rect) {
          const x0 = f.parent ? f.px - Math.min(6, (f.px - f.parent.px) / 2) : f.px - 6;
          const y0 = (f.ymin - 0.5) * rowH, y1 = (f.ymax + 0.5) * rowH;
          parts.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(labelsEnd + 6 - x0)}" height="${r2(y1 - y0)}" fill="${c}"/>`);
        } else {
          const r0 = Math.max(0, f.r - 6);
          parts.push(`<path d="${sectorD(r0, labelsEnd + 6, ang(f.ymin - 0.5), ang(f.ymax + 0.5))}" fill="${c}"/>`);
        }
      }
      if (parts.length) out.push(`<g class="ranges" fill-opacity="${r2(s.rangeOpacity * (th.rangeScale || 1))}">${parts.join('')}</g>`);
      if (rangeLegend.size) legendBlocks.push({ title: 'Clades', items: [...rangeLegend.values()] });
    }

    // --- label backgrounds and alignment guides ---
    const bgParts = [], guideParts = [];
    for (const li of labels) {
      const isHit = hits.has(li.f.n.id) || (li.f.collapsed && [...hits].some(id => {
        const nd = m.index.byId.get(id); return nd && visibleInfo(nd) === li.f;
      }));
      li.hit = isHit;
      const bg = isHit ? th.hit : li.bg;
      if (bg) {
        const h = li.size * 1.25, w = li.w + 4;
        if (!li.a) bgParts.push(`<rect x="${r2(li.x - 2)}" y="${r2(li.y - h / 2)}" width="${r2(w)}" height="${r2(h)}" rx="2" fill="${bg}"/>`);
        else {
          const flip = Math.cos(li.a * DEG) < 0;
          bgParts.push(`<rect transform="translate(${r2(li.x)},${r2(li.y)}) rotate(${r2(flip ? li.a + 180 : li.a)})" x="${r2(flip ? -w + 2 : -2)}" y="${r2(-h / 2)}" width="${r2(w)}" height="${r2(h)}" rx="2" fill="${bg}"/>`);
        }
      }
      if (li.guideFrom) {
        const to = rect ? [li.x - gap, li.y] : li.guideTo;
        guideParts.push(`<path d="M${pt(li.guideFrom)}L${pt(to)}"/>`);
      }
    }
    if (guideParts.length) out.push(`<g stroke="${th.guide}" stroke-width="${r2(Math.max(0.5, lw * 0.6))}" stroke-dasharray="2,2" fill="none">${guideParts.join('')}</g>`);
    if (bgParts.length) out.push(`<g class="label-bg">${bgParts.join('')}</g>`);

    // --- branches (grouped by style so most of the tree is a single path) ---
    const brGroups = new Map();
    for (const f of L.infos) {
      if (!f.parent) continue;
      const st = f.n.style || {};
      let attrs = '';
      if (st.branchColor) attrs += ` stroke="${A().safeColor(st.branchColor, th.branch)}"`;
      if (st.branchWidth) attrs += ` stroke-width="${r2(lw * st.branchWidth)}"`;
      if (st.branchDashed) attrs += ' stroke-dasharray="4,3"';
      if (dim && !hitPath.has(f)) attrs += ' stroke-opacity="0.2"';
      if (!brGroups.has(attrs)) brGroups.set(attrs, []);
      brGroups.get(attrs).push(branchD(f));
    }
    const br = [];
    for (const [attrs, ds] of brGroups) br.push(`<path d="${ds.join('')}"${attrs}/>`);
    out.push(`<g class="branches" fill="none" stroke="${th.branch}" stroke-width="${r2(lw)}" stroke-linecap="square">${br.join('')}</g>`);

    // --- collapsed clades ---
    const tri = [];
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
      const c = A().safeColor((f.n.style || {}).branchColor, th.branch);
      tri.push(`<polygon points="${pts.map(pt).join(' ')}" fill="${c}" fill-opacity="0.25" stroke="${c}"${did(f)}/>`);
    }
    if (tri.length) out.push(`<g class="collapsed" stroke-width="${r2(lw)}">${tri.join('')}</g>`);

    // --- selection paths ---
    const selInfos = [];
    (m.selection || []).forEach((id, i) => {
      const node = m.index.byId.get(id);
      const f = node && visibleInfo(node);
      if (f) selInfos.push({ f, color: SELECTION_COLORS[i % SELECTION_COLORS.length] });
    });
    if (selInfos.length) {
      const parts = [];
      for (const { f, color } of selInfos) {
        const ds = [];
        for (let c = f; c.parent; c = c.parent) ds.push(branchD(c));
        if (ds.length) parts.push(`<path d="${ds.join('')}" stroke="${color}"/>`);
      }
      out.push(`<g class="sel-paths" fill="none" stroke-width="${r2(lw + 2.5)}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85">${parts.join('')}</g>`);
    }

    // --- node dots & support ---
    const dots = [], supSym = [], supText = [];
    if (s.nodeDots) {
      for (const f of L.infos) dots.push(`<circle cx="${r2(f.px)}" cy="${r2(f.py)}" r="${r2(Math.max(1.5, lw * 1.4))}" fill="${f.tip ? th.tip : th.branch}"/>`);
    }
    if (s.support !== 'none') {
      const maxSup = maxOf(L.infos.map(f => (f.n.support == null ? 0 : f.n.support)), 0);
      const scale = maxSup > 1 ? 100 : 1;
      for (const f of L.infos) {
        const v = f.n.support;
        if (f.tip || !f.parent || v == null) continue;
        const ok = v >= s.supportMin * (scale === 1 ? 0.01 : 1);
        if (s.support === 'text') {
          if (!ok) continue;
          if (rect) supText.push(`<text x="${r2(f.px - 3)}" y="${r2(f.py - 3)}" text-anchor="end">${esc(fmtNum(v))}</text>`);
          else supText.push(`<text x="${r2(f.px + 3)}" y="${r2(f.py - 3)}">${esc(fmtNum(v))}</text>`);
        } else {
          const rr = 1.5 + 3.5 * Math.min(1, v / scale);
          supSym.push(`<circle cx="${r2(f.px)}" cy="${r2(f.py)}" r="${r2(rr)}"${ok ? '' : ' fill="none"'}/>`);
        }
      }
    }
    if (dots.length) out.push(`<g class="nodes">${dots.join('')}</g>`);
    if (supSym.length) out.push(`<g class="support" fill="${th.support}" stroke="${th.support}" stroke-width="0.8">${supSym.join('')}</g>`);
    if (supText.length) out.push(`<g class="support" font-size="${r2(Math.max(6, s.fontSize * 0.75))}" fill="${th.muted}">${supText.join('')}</g>`);

    // --- branch length values ---
    if (s.showBranchLengths) {
      const fsz = Math.max(6, s.fontSize * 0.7);
      const parts = [];
      for (const f of L.infos) {
        if (!f.parent || f.n.length == null) continue;
        let x, y;
        if (rect) { x = (f.parent.px + f.px) / 2; y = f.py - 3; }
        else if (circ) { [x, y] = polar((f.parent.r + f.r) / 2, f.a); }
        else { x = (f.parent.px + f.px) / 2; y = (f.parent.py + f.py) / 2; }
        parts.push(`<text x="${r2(x)}" y="${r2(y)}" text-anchor="middle">${esc(fmtNum(f.n.length))}</text>`);
      }
      out.push(`<g class="branch-lengths" font-size="${r2(fsz)}" fill="${th.muted}">${parts.join('')}</g>`);
    }

    // --- internal node names ---
    if (s.showInternalLabels) {
      const fsz = Math.max(6, s.fontSize * 0.8);
      const parts = [];
      for (const f of L.infos) {
        const txt = (f.n.style && f.n.style.displayName) || f.n.name;
        if (f.tip || !txt) continue;
        if (rect) parts.push(`<text x="${r2(f.px - 3)}" y="${r2(f.py + fsz + 1)}" text-anchor="end"${did(f)}>${esc(txt)}</text>`);
        else parts.push(`<text x="${r2(f.px + 3)}" y="${r2(f.py + fsz)}"${did(f)}>${esc(txt)}</text>`);
      }
      out.push(`<g class="internal-labels" font-size="${r2(fsz)}" fill="${th.muted}">${parts.join('')}</g>`);
    }

    // --- leaf labels ---
    if (labels.length) {
      const parts = labels.map(li => {
        const fill = li.color ? ` fill="${A().safeColor(li.color, th.text)}"` : '';
        const op = dim && !li.hit ? ' fill-opacity="0.3"' : '';
        const attrs = `${fontAttrs(li, s)}${fill}${op}${li.hit ? ' font-weight="bold"' : ''}${did(li.f)}`;
        return rotText(li.x, li.y, li.a, li.text, attrs);
      });
      out.push(`<g class="labels" fill="${th.text}" font-size="${r2(s.fontSize)}"${s.italic ? ' font-style="italic"' : ''}>${parts.join('')}</g>`);
    }

    // --- datasets ---
    let offset = labelsEnd + 10;
    let headerH = 0;
    const visibleDs = unr ? [] : (m.datasets || []).filter(d => d.visible !== false);
    const headerParts = [];
    const headerFs = Math.min(12, Math.max(7, s.fontSize * 0.9));
    const band = (o0, o1, f, frac) => {
      if (rect) {
        const h = rowH * frac;
        return `M${r2(o0)},${r2(f.py - h / 2)}H${r2(o1)}V${r2(f.py + h / 2)}H${r2(o0)}Z`;
      }
      return sectorD(o0, o1, f.a - da * frac / 2, f.a + da * frac / 2);
    };
    const at = (o, f) => (rect ? [o, f.py] : polar(o, f.a));
    const header = (x, text) => {
      headerParts.push(`<text transform="translate(${r2(x)},${r2(-rowH / 2 - 4)}) rotate(-55)" font-size="${r2(headerFs)}">${esc(text)}</text>`);
      headerH = Math.max(headerH, measure(text, headerFs) * 0.82 + 8);
    };

    for (const ds of visibleDs) {
      if (ds.type === 'symbol') continue;
      const map = leafMap(ds, m.index);
      const value = f => {
        if (!f.collapsed) return map.get(f.n.name);
        for (const l of T().leaves(f.n)) { const v = map.get(l.name); if (v) return v; }
        return undefined;
      };
      const parts = [];
      let w = ds.width || 20;
      const d0 = offset;
      if (ds.type === 'colorstrip') {
        for (const f of L.tips) {
          const row = value(f);
          if (row) parts.push(`<path d="${band(d0, d0 + w, f, 1)}" fill="${A().safeColor(row.color, '#ccc')}"${did(f)}/>`);
        }
        const leg = new Map();
        for (const row of ds.rows) if (!leg.has(row.color)) leg.set(row.color, row.label || row.color);
        if (rect) header(d0 + w / 2, ds.label);
        legendBlocks.push(ds.legend || { title: ds.label, items: [...leg].slice(0, 40).map(([c, l]) => ({ color: A().safeColor(c, '#ccc'), label: l, shape: 1 })) });
      } else if (ds.type === 'simplebar' || ds.type === 'multibar') {
        const multi = ds.type === 'multibar';
        const tot = row => (multi ? row.values.reduce((a, b) => a + Math.max(0, b || 0), 0) : Math.max(0, row.value));
        const max = maxOf(ds.rows.map(tot), 1e-12);
        const color = A().safeColor(ds.color, '#4e79a7');
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          if (!multi) {
            const len = Math.max(0, row.value) / max * w;
            if (len > 0) parts.push(`<path d="${band(d0, d0 + len, f, 0.72)}" fill="${color}"${did(f)}/>`);
          } else {
            let acc = d0;
            row.values.forEach((v, i) => {
              const len = Math.max(0, v || 0) / max * w;
              if (len <= 0) return;
              const c = A().safeColor((ds.fields[i] || {}).color, A().paletteColor(i));
              parts.push(`<path d="${band(acc, acc + len, f, 0.72)}" fill="${c}"${did(f)}/>`);
              acc += len;
            });
          }
        }
        const axis = rect
          ? `<path d="M${r2(d0)},${r2(-rowH / 2)}V${r2((n - 0.5) * rowH)}" stroke="${th.guide}" fill="none"/>`
          : `<path d="${full ? `M${r2(d0)},0A${r2(d0)},${r2(d0)} 0 1 1 ${r2(-d0)},0A${r2(d0)},${r2(d0)} 0 1 1 ${r2(d0)},0` : `M${pt(polar(d0, ang(-0.5)))}A${r2(d0)},${r2(d0)} 0 ${s.arc > 180 ? 1 : 0} 1 ${pt(polar(d0, ang(n - 0.5)))}`}" stroke="${th.guide}" fill="none"/>`;
        parts.unshift(axis);
        if (rect) header(d0 + w / 2, `${ds.label} (max ${fmtNum(max)})`);
        legendBlocks.push(ds.legend || (multi
          ? { title: ds.label, items: ds.fields.map((fd, i) => ({ color: A().safeColor(fd.color, A().paletteColor(i)), label: fd.label, shape: 1 })) }
          : { title: ds.label, items: [{ color, label: `max ${fmtNum(max)}`, shape: 1 }] }));
      } else if (ds.type === 'heatmap') {
        const nF = maxOf(ds.rows.map(r => r.values.length), Math.max(1, (ds.fields || []).length));
        const o = ds.opts || {};
        const all = ds.rows.flatMap(r => r.values).filter(v => v != null && isFinite(v));
        const min = o.min != null ? o.min : minOf(all);
        const max = o.max != null ? o.max : maxOf(all);
        const stops = o.colorMid ? [o.colorMin, o.colorMid, o.colorMax] : [o.colorMin, o.colorMax];
        const scale = colorScale(stops.map(c => A().safeColor(c, '#888')));
        const cell = w / nF;
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          row.values.forEach((v, i) => {
            if (v == null || !isFinite(v)) return;
            const t = max > min ? (v - min) / (max - min) : 0.5;
            parts.push(`<path d="${band(d0 + i * cell, d0 + (i + 1) * cell, f, 1)}" fill="${scale(Math.max(0, Math.min(1, t)))}"${did(f)}/>`);
          });
        }
        if (rect) {
          if (nF > 1) (ds.fields || []).forEach((fd, i) => header(d0 + (i + 0.5) * cell, fd.label));
          else header(d0 + w / 2, ds.label);
        }
        if (all.length) legendBlocks.push({ title: ds.label, gradient: { stops: [0, 0.25, 0.5, 0.75, 1].map(t => scale(t)), min, max } });
      } else if (ds.type === 'binary') {
        const nF = Math.max(1, (ds.fields || []).length);
        const cell = w / nF;
        for (const f of L.tips) {
          const row = value(f);
          if (!row) continue;
          row.values.forEach((v, i) => {
            if (v !== 1 && v !== 0) return;
            const fd = ds.fields[i] || {};
            const p = at(d0 + (i + 0.5) * cell, f);
            const slot = rect ? rowH : (d0 + (i + 0.5) * cell) * da * DEG;
            const size = Math.max(2, Math.min(cell, slot) * 0.7);
            parts.push(shape(fd.shape || 2, p[0], p[1], size, A().safeColor(fd.color, '#333'), v === 1));
          });
        }
        if (rect) (ds.fields || []).forEach((fd, i) => header(d0 + (i + 0.5) * cell, fd.label));
        legendBlocks.push(ds.legend || { title: ds.label, items: ds.fields.map(fd => ({ color: A().safeColor(fd.color, '#333'), label: fd.label, shape: fd.shape || 2 })) });
      } else if (ds.type === 'text') {
        let maxW = 0;
        for (const f of L.tips) {
          const row = value(f);
          if (!row || !row.label) continue;
          const size = s.fontSize * (row.size || 1);
          const bold = /bold/.test(row.style || ''), italic = /italic/.test(row.style || '');
          maxW = Math.max(maxW, measure(row.label, size, bold, italic));
          const p = at(d0 + 2, f);
          const fill = A().safeColor(row.color, th.text);
          parts.push(rotText(p[0], p[1], rect ? 0 : f.a, row.label,
            `font-size="${r2(size)}" fill="${fill}"${bold ? ' font-weight="bold"' : ''}${italic ? ' font-style="italic"' : ''}${did(f)}`));
        }
        w = ds.width || maxW + 6;
        if (rect) header(d0 + 4, ds.label);
      }
      out.push(`<g class="dataset">${parts.join('')}</g>`);
      offset += w + s.datasetGap;
    }
    const datasetsEnd = offset - s.datasetGap;

    // --- node symbols (placed on the tree, not aligned) ---
    for (const ds of visibleDs) {
      if (ds.type !== 'symbol') continue;
      const parts = [];
      const maxSize = maxOf(ds.rows.map(r => r.size), 1);
      for (const row of ds.rows) {
        const node = T().resolveSpec(m.index, row.id);
        const f = node && infoOf.get(node);
        if (!f) continue;
        let p = [f.px, f.py];
        if (f.parent && row.position >= 0 && row.position < 1) {
          const q = rect ? [f.parent.px, f.py] : circ ? polar(f.parent.r, f.a) : [f.parent.px, f.parent.py];
          p = [q[0] + (f.px - q[0]) * row.position, q[1] + (f.py - q[1]) * row.position];
        }
        const size = Math.max(2, (row.size / maxSize) * (ds.maxSize || 10));
        parts.push(shape(row.shape, p[0], p[1], size, A().safeColor(row.color, '#888'), row.filled));
      }
      out.push(`<g class="symbols">${parts.join('')}</g>`);
      if (ds.legend) legendBlocks.push(ds.legend);
    }

    // --- selection markers (MRCA) ---
    if (selInfos.length) {
      const parts = selInfos.map(({ f, color }) => `<circle cx="${r2(f.px)}" cy="${r2(f.py)}" r="4" fill="${color}" stroke="${th.bg}" stroke-width="1.5"/>`);
      if (selInfos.length >= 2) {
        const mr = T().mrca(selInfos.map(x => x.f.n));
        const f = mr && visibleInfo(mr);
        if (f) parts.push(`<circle cx="${r2(f.px)}" cy="${r2(f.py)}" r="7" fill="none" stroke="#9333ea" stroke-width="2.5"/><circle cx="${r2(f.px)}" cy="${r2(f.py)}" r="3" fill="#9333ea"/>`);
      }
      out.push(`<g class="sel-markers">${parts.join('')}</g>`);
    }

    if (headerParts.length) out.push(`<g class="headers" fill="${th.text}">${headerParts.join('')}</g>`);

    // --- bounds ---
    if (rect) {
      ext(-8, -rowH / 2 - headerH);
      ext(Math.max(labelsEnd, datasetsEnd, L.maxX * sx) + 4, (n - 0.5) * rowH);
    } else if (circ) {
      const R = Math.max(labelsEnd, datasetsEnd) + 8;
      ext(-R, -R); ext(R, R);
    } else {
      for (const f of L.infos) ext(f.px, f.py);
      for (const li of labels) {
        const ca = Math.cos(li.a * DEG), sa = Math.sin(li.a * DEG);
        ext(li.x + ca * li.w, li.y + sa * li.w);
        ext(li.x + ca * li.w, li.y + sa * li.w + li.size / 2);
      }
      bMinX -= 10; bMinY -= 10; bMaxX += 10; bMaxY += 10;
    }

    // --- scale bar ---
    if (s.showScale && L.useLen) {
      const unit = unr ? usx : sx;
      const step = PTV.Layout.niceStep((s.treeWidth / unit) / 5);
      const len = step * unit;
      const x0 = bMinX + 8, y0 = bMaxY + 18;
      out.push(`<g class="scale" stroke="${th.text}" fill="${th.text}"><path d="M${r2(x0)},${r2(y0 - 4)}V${r2(y0)}H${r2(x0 + len)}V${r2(y0 - 4)}" fill="none" stroke-width="1.2"/>` +
        `<text x="${r2(x0 + len / 2)}" y="${r2(y0 + 13)}" text-anchor="middle" stroke="none" font-size="11">${esc(fmtNum(step))}</text></g>`);
      ext(x0, y0 + 18);
    }

    // --- legend (right of the tree, or below it for portrait viewports) ---
    if (s.showLegend && legendBlocks.length) {
      const scale = Math.max(1, Math.min(6, Math.max(bMaxX - bMinX, bMaxY - bMinY) / 900));
      const blocks = legendBlocks.map(blk => {
        const parts = [];
        let y = 0, w = 0;
        if (blk.title) {
          parts.push(`<text x="0" y="10" font-size="12" font-weight="bold">${esc(blk.title)}</text>`);
          w = Math.max(w, measure(blk.title, 12, true));
          y += 18;
        }
        if (blk.gradient) {
          const gid = 'lg' + Math.random().toString(36).slice(2, 9);
          const g = blk.gradient;
          parts.push(`<defs><linearGradient id="${gid}">${g.stops.map((c, i) => `<stop offset="${i / (g.stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>` +
            `<rect x="0" y="${y}" width="120" height="12" fill="url(#${gid})"/>` +
            `<text x="0" y="${y + 24}" font-size="10">${esc(fmtNum(g.min))}</text>` +
            `<text x="120" y="${y + 24}" font-size="10" text-anchor="end">${esc(fmtNum(g.max))}</text>`);
          w = Math.max(w, 120);
          y += 30;
        }
        for (const it of blk.items || []) {
          parts.push(shape(it.shape || 1, 6, y + 6, 10, it.color, true));
          parts.push(`<text x="18" y="${y + 6}" dy=".32em" font-size="11">${esc(it.label)}</text>`);
          w = Math.max(w, 18 + measure(String(it.label), 11));
          y += 16;
        }
        return { html: parts.join(''), w: w * scale, h: y * scale };
      });
      const parts = [];
      const place = (b, x, y) => parts.push(`<g transform="translate(${r2(x)},${r2(y)})${scale > 1 ? ` scale(${r2(scale)})` : ''}">${b.html}</g>`);
      if (opt.legendBelow) {
        const x0 = bMinX + 8, maxX = Math.max(bMaxX, x0 + 300 * scale);
        let x = x0, y = bMaxY + 24 * scale, rowH = 0;
        for (const b of blocks) {
          if (x > x0 && x + b.w > maxX) { x = x0; y += rowH + 12 * scale; rowH = 0; }
          place(b, x, y);
          x += b.w + 24 * scale;
          rowH = Math.max(rowH, b.h);
        }
        ext(x0, y + rowH);
      } else {
        const x = bMaxX + 30 * scale;
        let y = bMinY + 6, w = 0;
        for (const b of blocks) { place(b, x, y); y += b.h + 10 * scale; w = Math.max(w, b.w); }
        ext(x + w + 10, y);
      }
      out.push(`<g class="legend" fill="${th.text}">${parts.join('')}</g>`);
    }

    return {
      html: out.join(''),
      bounds: { x: bMinX, y: bMinY, w: bMaxX - bMinX, h: bMaxY - bMinY },
      layout: L,
      points: L.infos.map(f => [f.n.id, f.px, f.py]),
    };
  }

  PTV.Render = { renderScene, SELECTION_COLORS, esc, fmtNum, leafMap };
  if (typeof module !== 'undefined' && module.exports) module.exports = PTV;
})(typeof window !== 'undefined' ? window : globalThis);
