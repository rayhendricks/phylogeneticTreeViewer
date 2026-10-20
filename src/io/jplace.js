/* jplace (Matsen et al. 2012, PLoS ONE 7:e31009): phylogenetic placements onto a reference tree.
   Each query is grafted onto its best edge (highest like_weight_ratio) as a new, highlighted leaf. */
import * as Tree from '../core/tree.js';
import { parseNewick } from './newick.js';

export function isJplace(text) {
  const t = String(text).trimStart();
  return t[0] === '{' && /"placements"\s*:/.test(t) && /"tree"\s*:/.test(t);
}

export function treeFromJplace(text, { color = '#e15759' } = {}) {
  const j = JSON.parse(text);
  const root = parseNewick(j.tree);
  const fields = j.fields || ['edge_num', 'likelihood', 'like_weight_ratio', 'distal_length', 'pendant_length'];
  const fi = k => fields.indexOf(k);
  const iE = fi('edge_num'), iW = fi('like_weight_ratio'), iD = fi('distal_length'), iP = fi('pendant_length');
  const byEdge = new Map();
  for (const n of Tree.preorder(root)) if (n.edge != null) byEdge.set(n.edge, n);
  // Group queries by edge so several placements on one edge are ordered by distal length.
  const groups = new Map();
  let placed = 0, missing = 0;
  for (const pl of j.placements || []) {
    const ps = pl.p || [];
    if (!ps.length) continue;
    const best = ps.reduce((a, b) => ((b[iW] ?? 0) > (a[iW] ?? 0) ? b : a));
    const node = byEdge.get(best[iE]);
    const names = pl.n || (pl.nm || []).map(x => x[0]);
    if (!node || !node.parent) { missing += names.length; continue; }
    if (!groups.has(node)) groups.set(node, []);
    for (const name of names) groups.get(node).push({ name, distal: +best[iD] || 0, pendant: +best[iP] || 0, lwr: best[iW] });
  }
  for (const [node, qs] of groups) {
    qs.sort((a, b) => b.distal - a.distal);
    // Walk up the edge from the child end, inserting one junction per distinct distal length.
    let below = node, used = 0;
    const len = node.length || 0;
    for (const q of qs) {
      const d = Math.min(Math.max(q.distal, 0), len) - used;
      const parent = below.parent;
      const junction = Tree.createNode(parent);
      parent.children[parent.children.indexOf(below)] = junction;
      parent.children.pop();
      junction.length = below.length != null ? Math.max(0, below.length - d) : null;
      below.parent = junction;
      below.length = below.length != null ? d : null;
      junction.children.push(below);
      const leaf = Tree.createNode(junction);
      leaf.name = q.name;
      leaf.length = q.pendant;
      leaf.attrs = { placement: 'jplace', like_weight_ratio: q.lwr != null ? String(q.lwr) : '' };
      Tree.setStyle(leaf, { labelColor: color, branchColor: color });
      used += d;
      below = junction;
      placed++;
    }
  }
  return { root, placed, missing };
}
