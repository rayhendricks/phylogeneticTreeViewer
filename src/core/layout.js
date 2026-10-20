/* Abstract tree layout: depth (x) and leaf order (y) for visible nodes. No DOM dependencies. */
import * as Tree from './tree.js';

// Returns { infos (preorder), tips, root, maxX, useLen, ny }.
// Each info: { n, parent, kids, tip, collapsed, x, y, cx, ymin, ymax, leafCount, slot, truncated }.
// ny is the total number of leaf rows (leaf spacing factors can make rows taller or shorter).
const branchLen = n => (n.style && n.style.truncate != null ? n.style.truncate : Tree.branchLength(n));
function computeLayout(root, settings) {
  const useLen = !!settings.branchLengths && Tree.hasBranchLengths(root);
  const infos = [];
  const stack = [[root, null]];
  while (stack.length) {
    const [n, parent] = stack.pop();
    const collapsed = n.collapsed && n.children.length > 0;
    const inf = { n, parent, kids: [], tip: !n.children.length || collapsed, collapsed };
    if (parent) parent.kids.push(inf);
    infos.push(inf);
    if (!inf.tip) for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], inf]);
  }

  for (let i = infos.length - 1; i >= 0; i--) {
    const f = infos[i];
    f.h = f.tip ? (f.collapsed ? 1 : 0) : 1 + f.kids.reduce((m, k) => Math.max(m, k.h), 0);
  }
  const rootH = infos[0].h;
  for (const f of infos) {
    if (f.n.style && f.n.style.truncate != null) f.truncated = true;
    if (useLen) f.x = f.parent ? f.parent.x + Math.max(0, branchLen(f.n)) : 0;
    else f.x = rootH - f.h;
    if (f.collapsed) {
      if (useLen) {
        let ext = 0;
        const base = Tree.rootDistance(f.n);
        for (const l of Tree.leaves(f.n)) ext = Math.max(ext, Tree.rootDistance(l) - base);
        f.cx = f.x + ext;
      } else {
        f.cx = rootH;
      }
    }
  }

  const tips = [];
  let acc = 0;
  for (const f of infos) {
    if (!f.tip) continue;
    f.slot = (f.n.style && f.n.style.spacing) || 1;
    f.y = f.ymin = f.ymax = acc + f.slot / 2 - 0.5;
    acc += f.slot;
    tips.push(f);
  }
  const ny = acc || 1;
  if (settings.flip) for (const f of tips) f.y = f.ymin = f.ymax = ny - 1 - f.y;
  for (let i = infos.length - 1; i >= 0; i--) {
    const f = infos[i];
    if (f.tip) { f.leafCount = f.collapsed ? Tree.leaves(f.n).length : 1; continue; }
    const a = f.kids[0], b = f.kids[f.kids.length - 1];
    f.y = (a.y + b.y) / 2;
    f.ymin = Math.min(a.ymin, b.ymin); f.ymax = Math.max(a.ymax, b.ymax);
    f.leafCount = f.kids.reduce((s, k) => s + k.leafCount, 0);
  }
  let maxX = 0;
  for (const f of tips) maxX = Math.max(maxX, f.collapsed ? f.cx : f.x);
  if (!(maxX > 0)) maxX = 1;
  return { infos, tips, root: infos[0], maxX, useLen, ny };
}

// Equal-angle unrooted layout (Felsenstein). Sets ux, uy (units), ua (degrees) on each info.
function equalAngle(L) {
  const { infos } = L;
  for (let i = infos.length - 1; i >= 0; i--) {
    const f = infos[i];
    f.tc = f.tip ? 1 : f.kids.reduce((s, k) => s + k.tc, 0);
  }
  const r = infos[0];
  r.ux = 0; r.uy = 0; r.ua = 0; r.w0 = 0; r.sp = 360;
  let maxR = 0;
  for (const f of infos) {
    let w = f.w0;
    for (const k of f.kids) {
      k.sp = f.sp * k.tc / f.tc;
      k.w0 = w;
      k.ua = w + k.sp / 2;
      w += k.sp;
      const d = k.x - f.x;
      k.ux = f.ux + d * Math.cos(k.ua * Math.PI / 180);
      k.uy = f.uy + d * Math.sin(k.ua * Math.PI / 180);
    }
    const ext = f.collapsed ? f.cx - f.x : 0;
    maxR = Math.max(maxR, Math.hypot(f.ux, f.uy) + ext);
  }
  return maxR || 1;
}

// Equal-daylight refinement of an equal-angle layout: rotates subtrees around each internal node
// so the empty angular gaps ("daylight") between them are equal. Updates ux, uy, ua in place.
function equalDaylight(L, iterations = 1) {
  const { infos } = L;
  if (infos.length > 4000) return;
  const subtree = f => { const out = []; const st = [f]; while (st.length) { const g = st.pop(); out.push(g); for (const k of g.kids) st.push(k); } return out; };
  const norm = a => { a %= 360; return a > 180 ? a - 360 : a <= -180 ? a + 360 : a; };
  for (let it = 0; it < iterations; it++) {
    for (const v of infos) {
      if (v.tip || v.kids.length < 2 && !v.parent) continue;
      const groups = v.kids.map(k => ({ nodes: subtree(k), fixed: false }));
      if (v.parent) {
        const inside = new Set(subtree(v));
        groups.unshift({ nodes: infos.filter(g => !inside.has(g)), fixed: true });
      }
      if (groups.length < 2) continue;
      // Angular extent of each group as seen from v.
      for (const g of groups) {
        const tipsOnly = g.nodes.filter(x => x.tip || x === infos[0]);
        const pts = tipsOnly.length ? tipsOnly : g.nodes;
        const cx = pts.reduce((a, x) => a + x.ux, 0) / pts.length - v.ux, cy = pts.reduce((a, x) => a + x.uy, 0) / pts.length - v.uy;
        g.dir = Math.atan2(cy, cx) * 180 / Math.PI;
        let lo = 0, hi = 0;
        for (const x of pts) {
          if (x === v) continue;
          const a = norm(Math.atan2(x.uy - v.uy, x.ux - v.ux) * 180 / Math.PI - g.dir);
          if (a < lo) lo = a; if (a > hi) hi = a;
        }
        g.lo = lo; g.hi = hi;
      }
      const used = groups.reduce((a, g) => a + (g.hi - g.lo), 0);
      if (used >= 360) continue;
      const gap = (360 - used) / groups.length;
      // Order groups by direction, starting from the fixed (parent-side) group.
      const startIdx = Math.max(0, groups.findIndex(g => g.fixed));
      const base = groups[startIdx].dir;
      const ordered = groups.map(g => ({ g, rel: ((g.dir - base) % 360 + 360) % 360 })).sort((a, b) => a.rel - b.rel).map(x => x.g);
      let edge = ordered[0].dir + ordered[0].hi;
      for (let i = 1; i < ordered.length; i++) {
        const g = ordered[i];
        const want = edge + gap - g.lo;
        const delta = norm(want - g.dir) * Math.PI / 180;
        if (Math.abs(delta) > 1e-6 && !g.fixed) {
          const c = Math.cos(delta), sn = Math.sin(delta);
          for (const x of g.nodes) {
            const dx = x.ux - v.ux, dy = x.uy - v.uy;
            x.ux = v.ux + dx * c - dy * sn; x.uy = v.uy + dx * sn + dy * c;
          }
        }
        edge = want + g.hi;
      }
    }
  }
  for (const f of infos) if (f.parent) f.ua = Math.atan2(f.uy - f.parent.uy, f.ux - f.parent.ux) * 180 / Math.PI;
}

function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

export { computeLayout, equalAngle, equalDaylight, niceStep };
