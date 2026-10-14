import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/core/tree.js';
import * as N from '../src/io/newick.js';
import * as A from '../src/io/annotations.js';
import { parseColor, ramp, RAMPS, paletteColor, PALETTES } from '../src/render/color.js';
import { buildScene } from '../src/render/scene.js';
import { treeFromLineages } from '../src/io/taxonomy.js';
import { encodeSession, decodeSession } from '../src/io/share.js';

const measure = (t, size) => String(t).length * size * 0.6;
const theme = { bg: '#fff', text: '#000', branch: '#333', muted: '#666', guide: '#ccc', tip: '#0a0', support: '#555', hit: '#ff0' };
const SETTINGS = {
  mode: 'rectangular', branchLengths: true, alignLabels: true, showLeafLabels: true, showInternalLabels: false,
  support: 'symbol', supportMin: 0, showBranchLengths: false, fontSize: 12, spacing: 18, treeWidth: 400, arc: 360,
  rotation: 0, innerRadius: 0, lineWidth: 1.5, nodeDots: true, italic: false, showLegend: true, showScale: true,
  dimNonHits: true, rangeOpacity: 0.3, datasetGap: 6, fontFamily: 'Arial', branchColorBy: 'none', branchRamp: 'Viridis',
};

function scene(root, datasets = [], over = {}) {
  return buildScene({
    root, settings: { ...SETTINGS, ...over }, datasets, index: T.buildIndex(root), hits: new Set(), measure,
  }, { theme });
}

const ds = text => A.datasetFromItol(A.parseItol(text));

test('colors: parsing and perceptual ramps', () => {
  assert.deepEqual(parseColor('#f00'), [255, 0, 0, 1]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5]);
  const f = ramp(['#000000', '#ffffff']);
  assert.equal(f(0), '#000000');
  assert.equal(f(1), '#ffffff');
  const mid = parseColor(f(0.5));
  assert.ok(mid[0] > 90 && mid[0] < 140, 'OKLab midpoint is perceptually mid-grey');
  assert.equal(ramp(RAMPS.Viridis)(0), '#440154');
  assert.equal(paletteColor(0, PALETTES['Okabe-Ito (colorblind safe)']), '#e69f00');
  assert.match(paletteColor(50), /^#[0-9a-f]{6}$/);
});

test('new iTOL dataset types parse', () => {
  const pie = ds('DATASET_PIECHART\nSEPARATOR COMMA\nDATASET_LABEL,p\nFIELD_LABELS,a,b\nFIELD_COLORS,#f00,#00f\nDATA\nA,-1,10,3,7\nB|C,0.5,20,1,1\n');
  assert.equal(pie.type, 'pie');
  assert.deepEqual(pie.rows[0].values, [3, 7]);
  assert.equal(pie.rows[1].position, 0.5);

  const box = ds('DATASET_BOXPLOT\nSEPARATOR COMMA\nDATA\nA,1,2,3,4,5,9,10\n');
  assert.deepEqual([box.rows[0].median, box.rows[0].extremes], [3, [9, 10]]);

  const line = ds('DATASET_LINECHART\nSEPARATOR COMMA\nDATA\nA,0|1,1|3,2|2\n');
  assert.deepEqual(line.rows[0].points, [[0, 1], [1, 3], [2, 2]]);

  const conn = ds('DATASET_CONNECTION\nSEPARATOR COMMA\nDATA\nA,D,2,#ff0000,dashed,x\n');
  assert.equal(conn.rows[0].to, 'D');
  assert.equal(conn.rows[0].dashed, true);

  const img = ds('DATASET_IMAGE\nSEPARATOR COMMA\nDATA\nA,-1,1,0,0,0,https://example.org/a.png\nB,-1,1,0,0,0,javascript:alert(1)\n');
  assert.equal(img.rows.length, 1);

  const shp = ds('DATASET_EXTERNALSHAPE\nSEPARATOR COMMA\nFIELD_LABELS,f1,f2\nDATA\nA,1,5\n');
  assert.equal(shp.type, 'shapes');
  assert.equal(shp.fields.length, 2);
});

test('FASTA alignments', () => {
  assert.ok(A.isFasta('>A desc\nACGT\n>B\nAC-T\n'));
  assert.ok(!A.isFasta('(A,B);'));
  const d = A.datasetFromFasta('>A desc\nAC\nGT\n>B\nAC-T\n');
  assert.deepEqual(d.rows, [{ id: 'A', seq: 'ACGT' }, { id: 'B', seq: 'AC-T' }]);
});

test('scene builds every dataset type in every layout', () => {
  const root = N.parseNewick('((A:1,B:2)90:1,(C:1,D:1)70:2);');
  const datasets = [
    ds('DATASET_COLORSTRIP\nSEPARATOR COMMA\nDATA\nA,#f00,x\nB,#0f0,y\nC|D,#00f,z\n'),
    ds('DATASET_SIMPLEBAR\nSEPARATOR COMMA\nDATA\nA,1\nB,2\n'),
    ds('DATASET_MULTIBAR\nSEPARATOR COMMA\nFIELD_LABELS,a,b\nDATA\nA,1,2\n'),
    ds('DATASET_HEATMAP\nSEPARATOR COMMA\nFIELD_LABELS,a,b\nDATA\nA,1,2\nB,3,X\n'),
    ds('DATASET_BINARY\nSEPARATOR COMMA\nFIELD_LABELS,a,b\nFIELD_SHAPES,1,6\nDATA\nA,1,0\nB,0,1\n'),
    ds('DATASET_EXTERNALSHAPE\nSEPARATOR COMMA\nFIELD_LABELS,a\nDATA\nA,3\nC,1\n'),
    ds('DATASET_TEXT\nSEPARATOR COMMA\nDATA\nA,hello,-1,#000,bold,1\n'),
    ds('DATASET_PIECHART\nSEPARATOR COMMA\nFIELD_LABELS,a,b\nDATA\nA,-1,10,1,2\nA|B,0.5,10,1,1\n'),
    ds('DATASET_DOMAINS\nSEPARATOR COMMA\nDATA\nA,100,RE|1|20|#f00|k,EL|30|50|#0f0|s,DI|60|70|#00f|d,HH|72|80|#0ff|h,GP|85|90|#000|\n'),
    A.datasetFromFasta('>A\nACGT\n>C\nAC-T\n'),
    ds('DATASET_BOXPLOT\nSEPARATOR COMMA\nDATA\nA,1,2,3,4,5,8\nB,0,1,2,3,4\n'),
    ds('DATASET_LINECHART\nSEPARATOR COMMA\nDATA\nA,0|1,1|2\nD,0|3,1|1\n'),
    ds('DATASET_CONNECTION\nSEPARATOR COMMA\nDATA\nA,D,2,#f00,normal,\nB,C,1,#00f,dashed,\n'),
    ds('DATASET_IMAGE\nSEPARATOR COMMA\nDATA\nA,-1,1,0,0,0,https://example.org/a.png\nB,0.5,1,0,0,0,https://example.org/b.png\n'),
    ds('DATASET_SYMBOL\nSEPARATOR COMMA\nDATA\nA|B,2,5,#f00,1,1\n'),
  ];
  for (const mode of ['rectangular', 'circular', 'slanted', 'unrooted']) {
    const sc = scene(root, datasets, { mode });
    assert.ok(sc.prims.length > 20, mode);
    assert.ok(sc.bounds.w > 0 && sc.bounds.h > 0, mode);
    for (const p of sc.prims) {
      assert.ok(['p', 't', 'i', 'a', 'g'].includes(p.k));
      assert.ok(p.box.every(isFinite), `${mode}: finite box for ${p.k}`);
      if (p.k === 'p') assert.ok(!/NaN|undefined|Infinity/.test(p.d), `${mode}: valid path`);
    }
    const kinds = new Set(sc.prims.map(p => p.k));
    assert.ok(kinds.has('i'), `${mode}: images`);
    if (mode === 'rectangular') assert.ok(kinds.has('a'), 'alignment drawn in rectangular mode');
  }
});

test('branch coloring by support and by category', () => {
  const root = N.parseNewick('((A:1,B:2)90:1,(C:1,D:1)20:2);');
  const bySupport = scene(root, [], { branchColorBy: 'support' });
  const strokes = new Set(bySupport.prims.filter(p => p.k === 'p' && p.stroke && p.cap === 'square').map(p => p.stroke));
  assert.ok(strokes.size >= 3, 'internal branches get ramp colors');
  const cat = ds('DATASET_COLORSTRIP\nSEPARATOR COMMA\nDATA\nA,#ff0000,x\nB,#ff0000,x\nC,#0000ff,y\nD,#00ff00,z\n');
  const byCat = scene(root, [cat], { branchColorBy: 'cat:' + cat.id });
  const s2 = new Set(byCat.prims.filter(p => p.k === 'p' && p.cap === 'square').map(p => p.stroke));
  assert.ok(s2.has('#ff0000') && s2.has('#0000ff') && s2.has('#333'), 'shared categories propagate; mixed clades stay default');
});

test('large trees build quickly and branches are chunked for culling', () => {
  const root = T.randomTree(5000, 3);
  const t0 = performance.now();
  const sc = scene(root, [], { spacing: 4, fontSize: 3 });
  const ms = performance.now() - t0;
  const branchChunks = sc.prims.filter(p => p.k === 'p' && p.cap === 'square');
  assert.ok(branchChunks.length >= 20, 'branches split into chunks');
  assert.ok(ms < 1500, `scene built in ${ms.toFixed(0)} ms`);
});

test('taxonomy lineages become a collapsed tree', () => {
  const lin = [{ id: '1', name: 'root' }, { id: '2759', name: 'Eukaryota' }, { id: '40674', name: 'Mammalia' }];
  const taxa = [
    { id: '9606', name: 'Homo sapiens', lineage: [...lin, { id: '9443', name: 'Primates' }, { id: '9605', name: 'Homo' }] },
    { id: '9598', name: 'Pan troglodytes', lineage: [...lin, { id: '9443', name: 'Primates' }, { id: '9596', name: 'Pan' }] },
    { id: '10090', name: 'Mus musculus', lineage: [...lin, { id: '9989', name: 'Rodentia' }] },
  ];
  const root = treeFromLineages(taxa);
  assert.deepEqual(T.leaves(root).map(n => n.name).sort(), ['Homo sapiens', 'Mus musculus', 'Pan troglodytes']);
  for (const n of T.preorder(root)) assert.notEqual(n.children.length, 1);
  const prim = T.mrca(T.leaves(root).filter(l => l.name !== 'Mus musculus'));
  assert.equal(prim.name, 'Primates');
  assert.ok(N.toNewick(root).includes("'Homo sapiens'"));
});

test('share links round-trip through compression', async () => {
  const obj = { ptvSession: 3, tree: T.snapshot(T.randomTree(200, 5)), name: 'x' };
  const code = await encodeSession(obj);
  assert.match(code, /^[\w-]+$/);
  assert.ok(code.length < JSON.stringify(obj).length, 'compressed');
  assert.deepEqual(await decodeSession(code), JSON.parse(JSON.stringify(obj)));
});
