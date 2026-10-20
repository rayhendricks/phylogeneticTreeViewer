/* Tree data model and topology operations. No DOM dependencies. */

let nextId = 1;

function createNode(parent) {
  const n = {
    id: nextId++, name: '', length: null, support: null, attrs: null,
    children: [], parent: null, collapsed: false, style: null,
  };
  if (parent) { n.parent = parent; parent.children.push(n); }
  return n;
}

const isLeaf = n => n.children.length === 0;

function preorder(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

// Children always precede their parent.
const postorder = root => preorder(root).reverse();

const leaves = n => preorder(n).filter(isLeaf);

function ancestors(n) {
  const out = [];
  for (let c = n; c; c = c.parent) out.push(c);
  return out;
}

function branchLength(n) {
  const l = n.length;
  return (l == null || !isFinite(l)) ? 0 : l;
}

function rootDistance(n) {
  let d = 0;
  for (let c = n; c.parent; c = c.parent) d += branchLength(c);
  return d;
}

function mrca(nodes) {
  if (!nodes.length) return null;
  let common = ancestors(nodes[0]);
  for (let i = 1; i < nodes.length; i++) {
    const set = new Set(ancestors(nodes[i]));
    common = common.filter(a => set.has(a));
  }
  return common[0] || null;
}

function patristic(a, b) {
  const m = mrca([a, b]);
  return rootDistance(a) + rootDistance(b) - 2 * rootDistance(m);
}

function hasBranchLengths(root) {
  for (const n of preorder(root)) if (n.parent && n.length != null) return true;
  return false;
}

function buildIndex(root) {
  const byId = new Map(), byName = new Map(), leafByName = new Map();
  for (const n of preorder(root)) {
    byId.set(n.id, n);
    if (!n.name) continue;
    if (isLeaf(n)) {
      if (!leafByName.has(n.name)) leafByName.set(n.name, n);
      byName.set(n.name, leafByName.get(n.name));
    } else if (!byName.has(n.name)) {
      byName.set(n.name, n);
    }
  }
  return { byId, byName, leafByName };
}

// Name lookup that tolerates the common "_" vs " " mismatch.
function lookupName(index, name) {
  if (name == null) return null;
  const s = String(name).trim();
  return index.byName.get(s) || index.byName.get(s.replace(/_/g, ' ')) ||
    index.byName.get(s.replace(/ /g, '_')) || null;
}

// Resolve an iTOL-style node id: a node name, or "A|B" / "A---B" meaning MRCA(A, B).
function resolveSpec(index, spec) {
  const s = String(spec).trim();
  if (!s) return null;
  if (/^CONTAINS==/.test(s)) return resolveSpecs(index, s)[0] || null;
  if (s.includes('|') || s.includes('---')) {
    const found = s.split(/\||---/).map(p => lookupName(index, p)).filter(Boolean);
    return found.length ? mrca(found) : null;
  }
  return lookupName(index, s);
}

// Like resolveSpec, but "CONTAINS==text" matches every node whose name matches (as a regular expression).
function resolveSpecs(index, spec) {
  const s = String(spec).trim();
  const m = /^CONTAINS==(.*)$/.exec(s);
  if (!m) { const n = resolveSpec(index, s); return n ? [n] : []; }
  let re;
  try { re = new RegExp(m[1]); } catch (e) { re = { test: v => v.includes(m[1]) }; }
  const out = [];
  for (const n of index.byId.values()) if (n.name && re.test(n.name)) out.push(n);
  return out;
}

// Collapse clades matching a rule; returns the number collapsed.
// rule: { avgLength: x } | { support: '<70' } | { nodeClass: 'genus' } | { label: 'text' }
function autoCollapse(root, rule) {
  let count = 0;
  const avgDist = n => { const base = rootDistance(n); const ls = leaves(n); return ls.reduce((a, l) => a + rootDistance(l) - base, 0) / ls.length; };
  let test;
  if (rule.avgLength != null) test = n => avgDist(n) < rule.avgLength;
  else if (rule.support != null) {
    const m = /^\s*([<>]?)\s*(-?[\d.]+)/.exec(String(rule.support));
    if (!m) return 0;
    const v = parseFloat(m[2]);
    test = n => n.support != null && (m[1] === '>' ? n.support > v : n.support < v);
  } else if (rule.nodeClass) test = n => n.style && n.style.nodeClass === rule.nodeClass;
  else if (rule.label) test = n => (n.name && n.name.includes(rule.label)) || (n.style && n.style.displayName && n.style.displayName.includes(rule.label));
  else return 0;
  // Top-down: once a clade is collapsed its descendants are hidden anyway.
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n.children.length) continue;
    if (n.parent && test(n)) { if (!n.collapsed) { n.collapsed = true; count++; } continue; }
    for (const c of n.children) stack.push(c);
  }
  return count;
}

// Re-root on the branch above `node`; frac is the fraction of that branch
// placed between the new root and `node`.
function reroot(tree, node, frac = 0.5) {
  const oldRoot = tree.root;
  if (!node || node === oldRoot || !node.parent) return false;
  const p = node.parent;
  const L = branchLength(node);
  const hadLen = node.length != null;
  const R = createNode();
  p.children.splice(p.children.indexOf(node), 1);
  R.children.push(node);
  node.parent = R;
  node.length = hadLen ? L * frac : null;

  let cur = p, newParent = R, newLen = hadLen ? L * (1 - frac) : null, newSupport = node.support;
  while (cur) {
    const oldParent = cur.parent, oldLen = cur.length, oldSupport = cur.support;
    if (oldParent) oldParent.children.splice(oldParent.children.indexOf(cur), 1);
    cur.parent = newParent;
    newParent.children.push(cur);
    cur.length = newLen;
    cur.support = newSupport;
    newParent = cur; newLen = oldLen; newSupport = oldSupport;
    cur = oldParent;
  }
  if (oldRoot.children.length === 1) collapseUnary(tree, oldRoot);
  tree.root = R;
  return true;
}

// Replace a node that has exactly one child by that child, merging branch lengths.
function collapseUnary(tree, n) {
  const c = n.children[0];
  const pp = n.parent;
  if (!pp) {
    tree.root = c;
    c.parent = null;
    c.length = null;
    return;
  }
  pp.children[pp.children.indexOf(n)] = c;
  c.parent = pp;
  c.length = (c.length == null && n.length == null) ? null : branchLength(c) + branchLength(n);
  if (c.support == null) c.support = n.support;
}

function midpointRoot(tree) {
  const ls = leaves(tree.root);
  if (ls.length < 2) return false;
  const farthest = start => {
    const dist = new Map([[start, 0]]), prev = new Map(), stack = [start];
    while (stack.length) {
      const n = stack.pop();
      const d = dist.get(n);
      const nb = n.children.map(c => [c, branchLength(c)]);
      if (n.parent) nb.push([n.parent, branchLength(n)]);
      for (const [m, w] of nb) {
        if (!dist.has(m)) { dist.set(m, d + w); prev.set(m, n); stack.push(m); }
      }
    }
    let best = start, bd = -1;
    for (const l of ls) { const d = dist.get(l); if (d > bd) { bd = d; best = l; } }
    return { node: best, dist: bd, prev };
  };
  const a = farthest(ls[0]).node;
  const r = farthest(a);
  const D = r.dist;
  if (!(D > 0)) return false;
  const half = D / 2;
  let cur = r.node, acc = 0;
  while (cur !== a) {
    const p = r.prev.get(cur);
    const childOfEdge = p === cur.parent ? cur : p;
    const w = branchLength(childOfEdge);
    if (acc + w >= half) {
      const fromCur = half - acc;
      const toChild = childOfEdge === cur ? fromCur : w - fromCur;
      return reroot(tree, childOfEdge, w > 0 ? toChild / w : 0.5);
    }
    acc += w;
    cur = p;
  }
  return false;
}

function leafCounts(root) {
  const counts = new Map();
  for (const n of postorder(root)) {
    counts.set(n, isLeaf(n) ? 1 : n.children.reduce((s, c) => s + counts.get(c), 0));
  }
  return counts;
}

function ladderize(root, ascending = true) {
  const counts = leafCounts(root);
  for (const n of preorder(root)) {
    if (n.children.length > 1) {
      n.children.sort((a, b) => ascending ? counts.get(a) - counts.get(b) : counts.get(b) - counts.get(a));
    }
  }
}

function rotate(n) { n.children.reverse(); }

// Keep only the given leaves (and the structure joining them).
function prune(tree, keepLeaves) {
  const keep = new Set();
  for (const n of postorder(tree.root)) {
    if (isLeaf(n) ? keepLeaves.has(n) : n.children.some(c => keep.has(c))) keep.add(n);
  }
  if (!keep.has(tree.root)) return false;
  for (const n of preorder(tree.root)) n.children = n.children.filter(c => keep.has(c));
  for (const n of postorder(tree.root)) if (n.children.length === 1) collapseUnary(tree, n);
  return true;
}

function removeClade(tree, n) {
  if (!n.parent) return false;
  const drop = new Set(leaves(n));
  const keepSet = new Set(leaves(tree.root).filter(l => !drop.has(l)));
  if (keepSet.size < 1) return false;
  return prune(tree, keepSet);
}

function extractClade(tree, n) {
  if (!n.parent || isLeaf(n)) return false;
  n.parent.children.splice(n.parent.children.indexOf(n), 1);
  n.parent = null;
  n.length = null;
  tree.root = n;
  return true;
}

function setStyle(n, props) {
  n.style = Object.assign(n.style || {}, props);
  for (const k of Object.keys(n.style)) if (n.style[k] == null) delete n.style[k];
  if (!Object.keys(n.style).length) n.style = null;
}

function setCladeStyle(n, props) { for (const d of preorder(n)) setStyle(d, props); }

// Flat, JSON-safe snapshot (no recursion, so very deep trees are fine).
function snapshot(root) {
  const list = [], idx = new Map();
  for (const n of preorder(root)) {
    idx.set(n, list.length);
    list.push({
      id: n.id, name: n.name, length: n.length, support: n.support, attrs: n.attrs,
      collapsed: n.collapsed || undefined, style: n.style ? { ...n.style } : undefined,
      p: n.parent ? idx.get(n.parent) : -1,
    });
  }
  return list;
}

function restore(list) {
  let maxId = 0;
  const nodes = list.map(o => {
    maxId = Math.max(maxId, o.id || 0);
    return {
      id: o.id || 0, name: o.name || '', length: o.length ?? null, support: o.support ?? null,
      attrs: o.attrs || null, collapsed: !!o.collapsed, style: o.style ? { ...o.style } : null,
      children: [], parent: null,
    };
  });
  nextId = Math.max(nextId, maxId + 1);
  nodes.forEach(n => { if (!n.id) n.id = nextId++; });
  list.forEach((o, i) => {
    if (o.p >= 0) { nodes[i].parent = nodes[o.p]; nodes[o.p].children.push(nodes[i]); }
  });
  return nodes[0];
}

function stats(root) {
  const all = preorder(root);
  const tips = all.filter(isLeaf);
  let total = 0, maxDepth = 0, binary = true, supMin = Infinity, supMax = -Infinity;
  const dist = new Map();
  for (const n of all) {
    const d = n.parent ? dist.get(n.parent) + branchLength(n) : 0;
    dist.set(n, d);
    if (n.parent) total += branchLength(n);
    if (!n.children.length) maxDepth = Math.max(maxDepth, d);
    else if (n.children.length !== 2 && n.parent) binary = false;
    if (n.children.length && n.support != null) {
      supMin = Math.min(supMin, n.support); supMax = Math.max(supMax, n.support);
    }
  }
  return {
    leaves: tips.length, internal: all.length - tips.length, totalLength: total, maxRootToTip: maxDepth,
    rooted: root.children.length === 2, binary: binary && root.children.length <= 3,
    hasLengths: hasBranchLengths(root),
    support: supMin <= supMax ? [supMin, supMax] : null,
  };
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Random Yule-like tree, handy for testing large layouts.
function randomTree(nLeaves, seed = 42) {
  const rng = mulberry32(seed);
  const root = createNode();
  const tips = [root];
  while (tips.length < nLeaves) {
    const i = Math.floor(rng() * tips.length);
    const t = tips[i];
    const a = createNode(t), b = createNode(t);
    tips[i] = a; tips.push(b);
  }
  let k = 1;
  for (const n of preorder(root)) {
    if (n.parent) n.length = Math.round(-Math.log(1 - rng()) * 1000) / 10000 + 0.001;
    if (isLeaf(n)) n.name = 'T' + (k++);
    else if (n.parent) n.support = Math.round(40 + rng() * 60);
  }
  return root;
}

export {
  createNode, isLeaf, preorder, postorder, leaves, ancestors, branchLength, rootDistance,
  mrca, patristic, hasBranchLengths, buildIndex, lookupName, resolveSpec, resolveSpecs, autoCollapse, reroot, midpointRoot,
  ladderize, rotate, prune, removeClade, extractClade, collapseUnary, setStyle, setCladeStyle,
  snapshot, restore, stats, leafCounts, randomTree, mulberry32,
};
