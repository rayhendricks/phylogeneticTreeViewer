import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/core/tree.js';
import * as N from '../src/io/newick.js';
import * as A from '../src/io/annotations.js';
import { DEFAULTS } from '../src/core/settings.js';
import { buildScene } from '../src/render/scene.js';
import { detectKind } from '../src/io/detect.js';
import { treeFromJplace } from '../src/io/jplace.js';

const measure = (t, size) => String(t).length * size * 0.6;
const theme = { bg: '#fff', text: '#000', branch: '#333', muted: '#666', guide: '#ccc', tip: '#0a0', support: '#555', hit: '#ff0' };
const NWK = '((A:1,B:2)AB:1,(C:1,(D:1,E_x:1):1):2);';
const tree = () => N.parseNewick(NWK);
const scene = (root, datasets = [], over = {}) => buildScene({
  root, settings: { ...DEFAULTS, ...over }, datasets, index: T.buildIndex(root), hits: new Set(), measure,
}, { theme });

test('node IDs: A---B and CONTAINS== regex', () => {
  const idx = T.buildIndex(tree());
  assert.equal(T.resolveSpec(idx, 'A---B').name, 'AB');
  assert.deepEqual(T.resolveSpecs(idx, 'CONTAINS==^[DE]').map(n => n.name).sort(), ['D', 'E_x']);
});

test('tree annotations: PRUNE, SPACING, METADATA, POPUP_INFO, LABELS classes', () => {
  const root = tree(), idx = T.buildIndex(root);
  const pr = A.applyTreeAnnotation(A.parseItol('PRUNE\nDATA\nA\nC\nD\n'), idx);
  const t = { root };
  assert.ok(T.prune(t, pr.prune));
  assert.deepEqual(T.leaves(t.root).map(l => l.name).sort(), ['A', 'C', 'D']);

  const r2 = tree(), i2 = T.buildIndex(r2);
  A.applyTreeAnnotation(A.parseItol('SPACING\nDATA\nA,3\n'), i2);
  A.applyTreeAnnotation(A.parseItol('METADATA\nSEPARATOR COMMA\nFIELD_LABELS,host,year\nDATA\nB,human,2019\n'), i2);
  A.applyTreeAnnotation(A.parseItol('POPUP_INFO\nSEPARATOR COMMA\nDATA\nC,Title C,<b>bold</b>\n'), i2);
  A.applyTreeAnnotation(A.parseItol('LABELS\nSEPARATOR COMMA\nDATA\nD,Dee,genus\n'), i2);
  assert.equal(T.lookupName(i2, 'A').style.spacing, 3);
  assert.deepEqual(T.lookupName(i2, 'B').attrs, { host: 'human', year: '2019' });
  assert.equal(T.lookupName(i2, 'C').style.popupHtml, '<b>bold</b>');
  assert.equal(T.lookupName(i2, 'D').style.nodeClass, 'genus');
  // Extra spacing makes the row taller.
  const ys = scene(r2).rows.tipYs;
  assert.ok(ys[1] - ys[0] > ys[2] - ys[1]);
  assert.equal(T.autoCollapse(r2, { label: 'AB' }), 1);
});

test('new dataset types render in both modes', () => {
  const files = [
    'DATASET_RANGE\nSEPARATOR COMMA\nDATASET_LABEL,r\nDATA\nA,B,#ff000055,,,,,,Clade AB\n',
    'DATASET_ARROWS\nSEPARATOR COMMA\nDATASET_LABEL,a\nDATA\nA,100,10,40,#f00,#00f,gene1\n',
    'DATASET_TIMESCALE\nSEPARATOR COMMA\nDATASET_LABEL,t\nDATA\n0,1,#eeeeee,,Early\n1,3,#cccccc,,Late\n',
  ];
  for (const f of files) {
    const d = A.datasetFromItol(A.parseItol(f));
    for (const mode of ['rectangular', 'circular']) {
      const base = scene(tree(), [], { mode }).prims.length;
      assert.ok(scene(tree(), [d], { mode }).prims.length > base, `${d.type} ${mode}`);
    }
  }
});

test('MULTI_STYLE labels become rich text', () => {
  const r = A.applyTreeAnnotation(A.parseItol('MULTI_STYLE\nSEPARATOR COMMA\nLABEL_SEPARATOR,_\nDATA\n1,bold,normal,#ff0000,1\n2,italic,normal,#0000ff,1\n'), T.buildIndex(tree()));
  const sc = scene(tree(), [], { multiStyle: r.multiStyle });
  assert.ok(sc.prims.some(p => p.k === 'r' && p.runs.some(x => x.bold)));
});

test('jplace placements graft onto their best edge', () => {
  const jp = JSON.stringify({
    version: 3, fields: ['edge_num', 'likelihood', 'like_weight_ratio', 'distal_length', 'pendant_length'],
    tree: '((A:1{0},B:2{1}):1{2},C:3{3}){4};',
    placements: [{ p: [[1, -10, 0.9, 0.5, 0.1], [0, -12, 0.1, 0.2, 0.1]], n: ['q1'] }],
  });
  assert.equal(detectKind(jp), 'jplace');
  const { root, placed } = treeFromJplace(jp);
  assert.equal(placed, 1);
  const q = T.leaves(root).find(l => l.name === 'q1');
  assert.ok(T.leaves(q.parent).some(l => l.name === 'B'));
  assert.equal(T.leaves(root).find(l => l.name === 'B').length, 0.5);
});

test('MEME XML becomes a domains dataset', () => {
  const xml = `<?xml version="1.0"?><MEME version="5"><training_set><sequence id="sequence_0" name="A" length="120"/></training_set>
<motifs><motif id="motif_1" name="ACGT" alt="MEME-1" width="12"></motif></motifs>
<scanned_sites_summary><scanned_sites sequence_id="sequence_0" pvalue="1e-5" num_sites="1"><scanned_site motif_id="motif_1" strand="plus" position="30" pvalue="1e-6"/></scanned_sites></scanned_sites_summary></MEME>`;
  assert.equal(detectKind(xml), 'meme');
  const d = A.datasetFromMeme(xml);
  assert.equal(d.rows[0].id, 'A');
  assert.deepEqual([d.rows[0].domains[0].start, d.rows[0].domains[0].end], [30, 42]);
});
