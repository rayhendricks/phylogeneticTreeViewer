import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, buildSession, sessionToSVG } from '../src/cli/cli.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'localtree-'));
  await writeFile(join(dir, 'fam1.nwk'), '((Hs_1:0.1,Mm_1:0.2)90:0.1,(Hs_2:0.3,Dr_1:0.2)70:0.2);');
  await writeFile(join(dir, 'species.tsv'), 'gene\tspecies\nHs_1\tHuman\nMm_1\tMouse\nHs_2\tHuman\nDr_1\tZebrafish\n');
  await writeFile(join(dir, 'fam1.fasta'), '>Hs_1\nMKV-L\n>Mm_1\nMKVAL\n>Hs_2\nMRV-L\n>Dr_1\nMKIAL\n');
  return dir;
}

test('buildSession combines tree, table and alignment with stable dataset ids', async () => {
  const dir = await fixture();
  const { session, notes } = await buildSession({
    tree: join(dir, 'fam1.nwk'), annot: [join(dir, 'species.tsv'), join(dir, 'fam1.fasta')],
    midpoint: true, colorBy: 'species', meta: ['expansion=+3'], set: ['mode=circular'],
  });
  assert.equal(session.meta.leaves, 4);
  assert.equal(session.meta.expansion, 3);
  assert.equal(session.settings.mode, 'circular');
  assert.equal(session.settings.branchColorBy, 'cat:species');
  assert.deepEqual(session.datasets.map(d => d.type), ['colorstrip', 'alignment']);
  assert.equal(notes.length, 2);
  const svg = sessionToSVG(session);
  assert.match(svg, /^<\?xml/);
  assert.ok(svg.includes('Hs_1') && svg.includes('</svg>'));
});

test('bad options give clear errors', async () => {
  const dir = await fixture();
  await assert.rejects(buildSession({ tree: join(dir, 'fam1.nwk'), colorBy: 'nope' }), /no color-strip dataset/);
  await assert.rejects(buildSession({ tree: join(dir, 'fam1.nwk'), set: ['bogus=1'] }), /unknown setting/);
});

test('render and dashboard commands write their outputs', { skip: !(await readFile('dist/localtree.html').catch(() => null)) && 'run npm run build first' }, async () => {
  const dir = await fixture();
  const out = join(dir, 'out', 'fam1');
  const err = console.error; console.error = () => {};
  try {
    await main(['render', '--tree', join(dir, 'fam1.nwk'), '--annot', join(dir, 'species.tsv'), '--out', out]);
    await main(['dashboard', '--out', join(dir, 'dash'), '--title', 'T', out + '.session.json']);
  } finally { console.error = err; }
  const html = await readFile(out + '.html', 'utf8');
  assert.ok(html.includes('window.LOCALTREE_EMBED='));
  assert.ok(!/<\/script>[^]*window\.LOCALTREE_EMBED/.test(html.split('<body>')[0]));
  assert.deepEqual(await readdir(join(dir, 'dash', 'data')), ['fam1.js']);
  const idx = await readFile(join(dir, 'dash', 'index.html'), 'utf8');
  assert.ok(idx.includes('"dashboard"') && idx.includes('data/fam1.js'));
});
