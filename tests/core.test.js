'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/tree.js');
require('../js/newick.js');
require('../js/annotations.js');
require('../js/layout.js');
require('../js/samples.js');
const { Tree: T, Newick: N, Annotations: A, Layout: L, Samples } = globalThis.PTV;

const names = root => T.leaves(root).map(n => n.name).sort();
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('parses Newick with lengths, support and internal names', () => {
  const r = N.parseNewick('((A:0.1,B:0.2)95:0.3,(C:0.4,D:0.5)Clade1:0.6);');
  assert.deepEqual(names(r), ['A', 'B', 'C', 'D']);
  const [ab, cd] = r.children;
  assert.equal(ab.support, 95);
  assert.equal(ab.name, '');
  assert.equal(cd.name, 'Clade1');
  close(ab.length, 0.3);
  close(T.rootDistance(r.children[1].children[1]), 1.1);
});

test('parses quoted labels, comments, NHX and scientific notation', () => {
  const r = N.parseNewick("('Homo sapiens':1e-2,'it''s':2[&&NHX:S=x:B=88],(X,Y)[&posterior=0.97,height={1,2}]);");
  const [a, b, c] = r.children;
  assert.equal(a.name, 'Homo sapiens');
  close(a.length, 0.01);
  assert.equal(b.name, "it's");
  assert.equal(b.attrs.S, 'x');
  assert.equal(b.support, 88);
  close(c.support, 0.97);
  assert.equal(c.attrs.height, '{1,2}');
});

test('reports malformed Newick', () => {
  assert.throws(() => N.parseNewick('((A,B);'), /Unbalanced/);
  assert.throws(() => N.parseNewick('(A,B));'), /Unbalanced/);
  assert.throws(() => N.parseNewick('(A:x,B);'), /Invalid branch length/);
});

test('Newick round trip is stable', () => {
  const src = "((A:0.1,'B c':0.2)95:0.3,(C:0.4,D:0.5)Clade1:0.6);";
  const out = N.toNewick(N.parseNewick(src));
  assert.equal(out, src);
  assert.equal(N.toNewick(N.parseNewick(out)), out);
});

test('deep trees do not overflow the stack', () => {
  let s = 'L0';
  for (let i = 1; i < 20000; i++) s = `(${s},L${i})`;
  const r = N.parseNewick(s + ';');
  assert.equal(T.leaves(r).length, 20000);
  const out = N.toNewick(r);
  assert.equal(T.leaves(N.parseNewick(out)).length, 20000);
  const lay = L.computeLayout(r, { branchLengths: false });
  assert.equal(lay.tips.length, 20000);
});

test('parses NEXUS with translate table and multiple trees', () => {
  const nex = `#NEXUS
begin taxa; dimensions ntax=3; end;
BEGIN TREES;
  TRANSLATE 1 Alpha, 2 'Beta gamma', 3 Delta;
  TREE first = [&R] ((1:1,2:2):0.5,3:3);
  tree second = (1,(2,3));
END;`;
  const trees = N.parseNexus(nex);
  assert.equal(trees.length, 2);
  assert.equal(trees[0].name, 'first');
  assert.deepEqual(names(trees[0].root), ['Alpha', 'Beta gamma', 'Delta']);
  assert.equal(N.parseTrees(nex).length, 2);
});

test('parseTrees handles several Newick trees in one file', () => {
  const trees = N.parseTrees('(A,B,C);\n((A,B),C);\n');
  assert.equal(trees.length, 2);
});

test('reroot preserves leaves, total length and support on bipartitions', () => {
  const r = N.parseNewick('((A:1,B:2)90:3,(C:4,D:5)80:6);');
  const tree = { root: r };
  const total = T.stats(r).totalLength;
  const C = T.leaves(r).find(n => n.name === 'C');
  assert.ok(T.reroot(tree, C));
  assert.deepEqual(names(tree.root), ['A', 'B', 'C', 'D']);
  close(T.stats(tree.root).totalLength, total);
  assert.equal(tree.root.children.length, 2);
  const byName = n => T.leaves(tree.root).find(x => x.name === n);
  close(T.patristic(byName('A'), byName('D')), 1 + 3 + 6 + 5);
  close(T.patristic(byName('C'), byName('D')), 9);
  // The AB clade still has its support.
  const ab = T.mrca([byName('A'), byName('B')]);
  assert.equal(ab.support, 90);
  for (const n of T.preorder(tree.root)) for (const c of n.children) assert.equal(c.parent, n);
});

test('midpoint rooting balances the longest path', () => {
  const r = N.parseNewick('((A:1,B:1):1,(C:1,D:9):1);');
  const tree = { root: r };
  assert.ok(T.midpointRoot(tree));
  const D = T.leaves(tree.root).find(n => n.name === 'D');
  const A = T.leaves(tree.root).find(n => n.name === 'A');
  close(T.rootDistance(D), 6);
  close(T.rootDistance(A), 6);
  close(T.stats(tree.root).totalLength, 14);
});

test('prune and remove keep a valid tree', () => {
  const r = N.parseNewick('(((A:1,B:1):1,C:2):1,(D:1,E:1):2);');
  const tree = { root: r };
  const keep = new Set(T.leaves(r).filter(n => ['A', 'C', 'D'].includes(n.name)));
  assert.ok(T.prune(tree, keep));
  assert.deepEqual(names(tree.root), ['A', 'C', 'D']);
  const D = T.leaves(tree.root).find(n => n.name === 'D');
  close(T.rootDistance(D), 3);
  for (const n of T.preorder(tree.root)) assert.ok(n.children.length !== 1);
  const C = T.leaves(tree.root).find(n => n.name === 'C');
  assert.ok(T.removeClade(tree, C));
  assert.deepEqual(names(tree.root), ['A', 'D']);
});

test('ladderize orders by clade size', () => {
  const r = N.parseNewick('(((A,B),C),D);');
  T.ladderize(r, true);
  assert.equal(r.children[0].name, 'D');
  T.ladderize(r, false);
  assert.equal(r.children[1].name, 'D');
});

test('snapshot/restore round-trips structure, ids and styles', () => {
  const r = N.parseNewick('((A:1,B:2)90:3,C:4);');
  T.setStyle(r.children[0], { range: '#ff0000' });
  r.children[0].collapsed = true;
  const r2 = T.restore(JSON.parse(JSON.stringify(T.snapshot(r))));
  assert.equal(N.toNewick(r2), N.toNewick(r));
  assert.equal(r2.children[0].style.range, '#ff0000');
  assert.equal(r2.children[0].collapsed, true);
  assert.equal(r2.children[0].id, r.children[0].id);
});

test('resolveSpec handles names, MRCA pairs and underscore/space variants', () => {
  const r = N.parseNewick('((Homo_sapiens,Pan),(Mus,Rattus)Rodents);');
  const idx = T.buildIndex(r);
  assert.equal(T.resolveSpec(idx, 'Homo sapiens').name, 'Homo_sapiens');
  assert.equal(T.resolveSpec(idx, 'Rodents'), r.children[1]);
  assert.equal(T.resolveSpec(idx, 'Homo_sapiens|Pan'), r.children[0]);
  assert.equal(T.resolveSpec(idx, 'Pan|Mus'), r);
  assert.equal(T.resolveSpec(idx, 'missing'), null);
});

test('iTOL annotation parsing: datasets', () => {
  const strip = A.parseItol('DATASET_COLORSTRIP\nSEPARATOR TAB\nDATASET_LABEL\tHabitat\nCOLOR\t#ff0000\nDATA\nA\t#00ff00\tland\nB|C\t#0000ff\tsea\n');
  assert.equal(strip.type, 'DATASET_COLORSTRIP');
  const ds = A.datasetFromItol(strip);
  assert.equal(ds.type, 'colorstrip');
  assert.equal(ds.label, 'Habitat');
  assert.equal(ds.rows.length, 2);
  assert.equal(ds.rows[1].id, 'B|C');

  const heat = A.datasetFromItol(A.parseItol('DATASET_HEATMAP\nSEPARATOR COMMA\nDATASET_LABEL,H\nFIELD_LABELS,f1,f2\nDATA\nA,1,X\nB,2,3\n'));
  assert.equal(heat.fields.length, 2);
  assert.deepEqual(heat.rows[0].values, [1, null]);

  const bin = A.datasetFromItol(A.parseItol('DATASET_BINARY\nSEPARATOR SPACE\nDATASET_LABEL bin\nFIELD_SHAPES 1 2\nFIELD_LABELS a b\nDATA\nA 1 0\n'));
  assert.equal(bin.fields[0].shape, 1);
  assert.deepEqual(bin.rows[0].values, [1, 0]);
});

test('iTOL annotation parsing: tree-level annotations mutate styles', () => {
  const r = N.parseNewick('((A,B),(C,D));');
  const idx = T.buildIndex(r);
  const res = A.applyTreeAnnotation(A.parseItol('TREE_COLORS\nSEPARATOR COMMA\nDATA\nA|B,range,#ffeeee,Group 1\nC,label,#ff0000,bold,2\nC|D,clade,#00aa00,normal,2\nZZZ,branch,#000000\n'), idx);
  assert.equal(res.applied, 3);
  assert.deepEqual(res.missing, ['ZZZ']);
  assert.equal(r.children[0].style.range, '#ffeeee');
  assert.equal(r.children[0].style.rangeLabel, 'Group 1');
  const C = T.leaves(r)[2];
  assert.equal(C.style.labelColor, '#ff0000');
  assert.equal(C.style.labelStyle, 'bold');
  assert.equal(C.style.branchColor, '#00aa00');

  A.applyTreeAnnotation(A.parseItol('LABELS\nSEPARATOR COMMA\nDATA\nA,Alpha\n'), idx);
  assert.equal(T.leaves(r)[0].style.displayName, 'Alpha');
  A.applyTreeAnnotation(A.parseItol('COLLAPSE\nDATA\nC|D\n'), idx);
  assert.equal(r.children[1].collapsed, true);
});

test('annotation colors are sanitised', () => {
  const ds = A.datasetFromItol(A.parseItol('DATASET_COLORSTRIP\nSEPARATOR COMMA\nDATA\nA,"/><script>x</script>\n'));
  assert.equal(ds.rows[0].color, '#cccccc');
  assert.equal(A.safeColor('rgba(1,2,3,0.5)'), 'rgba(1,2,3,0.5)');
});

test('table import builds typed datasets', () => {
  const table = A.parseTable('id,group,size,g1,g2,present\nA,x,1.5,0.1,0.2,yes\nB,y,2,0.3,0.4,no\nC,x,,0.5,,1\n');
  assert.deepEqual(table.header, ['id', 'group', 'size', 'g1', 'g2', 'present']);
  assert.equal(A.inferColumnType(table.rows.map(r => r[1])), 'colorstrip');
  assert.equal(A.inferColumnType(table.rows.map(r => r[2])), 'simplebar');
  const res = A.datasetsFromTable(table, 0, [
    { index: 1, type: 'colorstrip' }, { index: 2, type: 'simplebar' },
    { index: 3, type: 'heatmap' }, { index: 4, type: 'heatmap' }, { index: 5, type: 'binary' },
  ]);
  const types = res.datasets.map(d => d.type);
  assert.deepEqual(types, ['colorstrip', 'simplebar', 'heatmap', 'binary']);
  assert.equal(res.datasets[0].rows[0].color, res.datasets[0].rows[2].color);
  assert.equal(res.datasets[1].rows.length, 2);
  assert.deepEqual(res.datasets[2].rows[2].values, [0.5, null]);
  assert.deepEqual(res.datasets[3].rows.map(r => r.values[0]), [1, 0, 1]);
});

test('CSV parsing handles quotes', () => {
  assert.deepEqual(A.splitCsvLine('a,"b, c","d ""e"""', ','), ['a', 'b, c', 'd "e"']);
});

test('layout assigns leaf order and depths', () => {
  const r = N.parseNewick('((A:1,B:2):1,C:1);');
  const lay = L.computeLayout(r, { branchLengths: true });
  assert.equal(lay.tips.length, 3);
  assert.deepEqual(lay.tips.map(t => t.y), [0, 1, 2]);
  close(lay.maxX, 3);
  close(lay.infos[1].y, 0.5);
  const clado = L.computeLayout(r, { branchLengths: false });
  assert.ok(clado.tips.every(t => t.x === clado.maxX));
  r.children[0].collapsed = true;
  const col = L.computeLayout(r, { branchLengths: true });
  assert.equal(col.tips.length, 2);
  close(col.tips[0].cx, 3);
  assert.equal(col.tips[0].leafCount, 2);
});

test('equal-angle layout places every node', () => {
  const r = T.randomTree(200, 3);
  const lay = L.computeLayout(r, { branchLengths: true });
  const maxR = L.equalAngle(lay);
  assert.ok(maxR > 0);
  assert.ok(lay.infos.every(f => isFinite(f.ux) && isFinite(f.uy)));
});

test('sample trees parse and their annotations resolve', () => {
  for (const s of Samples) {
    if (s.random) continue;
    const r = N.parseNewick(s.newick);
    assert.ok(T.leaves(r).length >= 5, s.name);
    const idx = T.buildIndex(r);
    for (const text of s.annotations || []) {
      const p = A.parseItol(text);
      if (A.isTreeAnnotation(p.type)) {
        assert.equal(A.applyTreeAnnotation(p, idx).missing.length, 0);
      } else {
        const ds = A.datasetFromItol(p);
        assert.ok(ds.rows.every(row => T.resolveSpec(idx, row.id)), ds.label);
      }
    }
  }
});

test('random tree generator is deterministic', () => {
  assert.equal(N.toNewick(T.randomTree(50, 1)).replace(/\d+:/g, ''), N.toNewick(T.randomTree(50, 1)).replace(/\d+:/g, ''));
  assert.equal(T.leaves(T.randomTree(123)).length, 123);
});
