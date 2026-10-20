/* Abstract tree layout: depth (x) and leaf order (y) for visible nodes. No DOM dependencies. */
import * as Tree from './tree.js';

// Returns { infos (preorder), tips, root, maxX, useLen }.
// Each info: { n, parent, kids, tip, collapsed, x, y, cx, ymin, ymax, leafCount }.
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
    if (useLen) f.x = f.parent ? f.parent.x + Math.max(0, Tree.branchLength(f.n)) : 0;
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
  for (const f of infos) if (f.tip) { f.y = f.ymin = f.ymax = tips.length; tips.push(f); }
  for (let i = infos.length - 1; i >= 0; i--) {
    const f = infos[i];
    if (f.tip) { f.leafCount = f.collapsed ? Tree.leaves(f.n).length : 1; continue; }
    const a = f.kids[0], b = f.kids[f.kids.length - 1];
    f.y = (a.y + b.y) / 2;
    f.ymin = a.ymin; f.ymax = b.ymax;
    f.leafCount = f.kids.reduce((s, k) => s + k.leafCount, 0);
  }
  let maxX = 0;
  for (const f of tips) maxX = Math.max(maxX, f.collapsed ? f.cx : f.x);
  if (!(maxX > 0)) maxX = 1;
  return { infos, tips, root: infos[0], maxX, useLen };
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

function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

export { computeLayout, equalAngle, niceStep };
