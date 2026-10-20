/* LocalTree command line: render trees to SVG / interactive HTML / session JSON, and build dashboards.

   localtree render    --tree FILE [--annot FILE ...] [options] --out PREFIX
   localtree dashboard --out DIR [--title TEXT] [--svg] FILE ...
*/
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as Tree from '../core/tree.js';
import * as Newick from '../io/newick.js';
import * as Ann from '../io/annotations.js';
import { detectKind } from '../io/detect.js';
import { treeFromJplace } from '../io/jplace.js';
import { DEFAULTS, autoSettings } from '../core/settings.js';
import { buildScene } from '../render/scene.js';
import { sceneToSVG } from '../render/svg.js';
import { measureText } from '../render/textmetrics.js';
import { PALETTES } from '../render/color.js';

export const VERSION = '3.1.0';

const USAGE = `LocalTree ${VERSION}: render phylogenetic trees and build interactive dashboards.

Usage:
  localtree render --tree FILE [--annot FILE ...] [options] --out PREFIX
  localtree dashboard --out DIR [--title TEXT] [--svg] FILE ...
  localtree --version

render
  --tree FILE          Newick, NEXUS or phyloXML tree (first tree is used)
  --annot FILE         Annotation to add; repeatable. iTOL annotation files, FASTA
                       alignments and CSV/TSV tables (one row per leaf) are detected
                       automatically. Table columns become datasets by inferred type.
  --name TEXT          Display name (default: tree file name)
  --id TEXT            Identifier used in dashboards (default: derived from the name)
  --layout MODE        rectangular | circular | slanted | unrooted   (default rectangular)
  --midpoint           Midpoint-root the tree
  --ladderize          Ladderize (larger clades last)
  --color-by WHAT      Color branches by: support | length | attr:KEY | a color-strip
                       dataset label (e.g. the column name of a species table)
  --palette NAME       Categorical palette for table columns (default "Tableau 10")
  --set KEY=VALUE      Override any display setting, e.g. --set alignLabels=true; repeatable
  --meta KEY=VALUE     Extra column shown in dashboards, e.g. --meta expansion=+12; repeatable
  --formats LIST       Comma list of svg,html,json (default svg,html,json)
  --out PREFIX         Output path prefix, e.g. results/OG0000123

dashboard
  FILE ...             Session JSON files from "render" (or plain tree files)
  --out DIR            Output folder: DIR/index.html plus DIR/data/
  --title TEXT         Dashboard title
  --svg                Also write DIR/svg/<id>.svg for every family
`;

const slug = s => String(s).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tree';

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && isFinite(Number(v))) return Number(v);
  return v;
}

function keyValues(list = []) {
  const out = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`Expected KEY=VALUE, got "${kv}"`);
    out[kv.slice(0, i).trim()] = kv.slice(i + 1);
  }
  return out;
}

// Table -> datasets with every non-ID column included, typed by its contents.
function tableDatasets(table, index, palette) {
  let idCol = 0, best = -1;
  table.header.forEach((h, i) => {
    const c = table.rows.slice(0, 3000).filter(r => r[i] && Tree.lookupName(index, r[i])).length;
    if (c > best) { best = c; idCol = i; }
  });
  const cols = table.header.map((h, i) => i).filter(i => i !== idCol)
    .map(i => ({ index: i, type: Ann.inferColumnType(table.rows.map(r => r[i])) }));
  return { ...Ann.datasetsFromTable(table, idCol, cols, palette), matched: best };
}

// Build a session object (the same format the browser app saves) from files on disk.
export async function buildSession(opts) {
  const treeText = await readFile(opts.tree, 'utf8');
  const tree = { root: detectKind(treeText, opts.tree) === 'jplace' ? treeFromJplace(treeText).root : Newick.parseTrees(treeText)[0].root };
  if (opts.midpoint && Tree.hasBranchLengths(tree.root)) Tree.midpointRoot(tree);
  if (opts.ladderize) Tree.ladderize(tree.root, true);
  const settings = autoSettings({ ...DEFAULTS }, tree.root);
  settings.mode = opts.layout || 'rectangular';
  if (opts.palette) settings.palette = opts.palette;
  const palette = PALETTES[settings.palette] || PALETTES['Tableau 10'];
  let index = Tree.buildIndex(tree.root);
  const datasets = [];
  const notes = [];
  const usedIds = new Set();
  const addDs = ds => {
    let id = slug(ds.label).toLowerCase(), k = 2;
    while (usedIds.has(id)) id = `${slug(ds.label).toLowerCase()}_${k++}`;
    usedIds.add(id);
    datasets.push({ ...ds, id });
  };

  for (const file of opts.annot || []) {
    const text = await readFile(file, 'utf8');
    const kind = detectKind(text, file);
    if (kind === 'annotation') {
      const p = Ann.parseItol(text);
      if (Ann.isTreeAnnotation(p.type)) {
        const r = Ann.applyTreeAnnotation(p, index);
        if (r.multiStyle) settings.multiStyle = r.multiStyle;
        if (r.prune && r.prune.size) {
          if (!Tree.prune(tree, r.prune)) throw new Error(`${file}: PRUNE would remove every leaf`);
          index = Tree.buildIndex(tree.root);
        }
        if (r.taxonomy) notes.push(`${basename(file)}: AUTO_TAXONOMY needs NCBI lookups and is applied only in the browser`);
        notes.push(`${basename(file)}: ${p.type}, ${r.applied} rows applied, ${r.missing.length} IDs not found`);
      } else {
        const ds = Ann.datasetFromItol(p);
        addDs(ds);
        notes.push(`${basename(file)}: ${ds.type} "${ds.label}", ${ds.rows.filter(r => Tree.resolveSpec(index, r.id)).length}/${ds.rows.length} IDs matched`);
      }
    } else if (kind === 'meme') {
      const ds = Ann.datasetFromMeme(text, basename(file).replace(/\.[^.]+$/, ''));
      addDs(ds);
      notes.push(`${basename(file)}: MEME motifs, ${ds.rows.filter(r => Tree.resolveSpec(index, r.id)).length}/${ds.rows.length} sequences matched`);
    } else if (kind === 'fasta') {
      const ds = Ann.datasetFromFasta(text, basename(file).replace(/\.[^.]+$/, ''));
      addDs(ds);
      notes.push(`${basename(file)}: alignment, ${ds.rows.filter(r => index.byName.has(r.id)).length}/${ds.rows.length} sequences matched`);
    } else if (kind === 'table') {
      const res = tableDatasets(Ann.parseTable(text), index, palette);
      res.datasets.forEach(addDs);
      if (res.rename) for (const [id, nm] of res.rename) { const n = Tree.resolveSpec(index, id); if (n && nm) Tree.setStyle(n, { displayName: nm }); }
      notes.push(`${basename(file)}: table, ${res.datasets.length} datasets, ${res.matched} rows matched`);
    } else {
      throw new Error(`${file}: not an annotation, FASTA or table file`);
    }
  }

  if (datasets.some(d => ['colorstrip', 'heatmap', 'simplebar', 'binary', 'domains', 'alignment'].includes(d.type))) settings.alignLabels = true;
  if (opts.colorBy) {
    const c = opts.colorBy;
    if (['support', 'length'].includes(c) || c.startsWith('attr:')) settings.branchColorBy = c;
    else {
      const ds = datasets.find(d => d.type === 'colorstrip' && (d.label === c || d.id === c));
      if (!ds) throw new Error(`--color-by: no color-strip dataset named "${c}" (available: ${datasets.filter(d => d.type === 'colorstrip').map(d => d.label).join(', ') || 'none'})`);
      settings.branchColorBy = 'cat:' + ds.id;
    }
  }
  for (const [k, v] of Object.entries(keyValues(opts.set))) {
    if (!(k in DEFAULTS)) throw new Error(`--set: unknown setting "${k}". Known: ${Object.keys(DEFAULTS).join(', ')}`);
    settings[k] = parseValue(v);
  }

  const name = opts.name || basename(opts.tree).replace(/\.[^.]+$/, '');
  const st = Tree.stats(tree.root);
  return {
    session: {
      ptvSession: 3, name, id: opts.id || slug(name), savedAt: new Date().toISOString(),
      tree: Tree.snapshot(tree.root), datasets, settings,
      meta: {
        leaves: st.leaves, rooted: st.rooted, maxRootToTip: st.hasLengths ? +st.maxRootToTip.toPrecision(4) : null,
        datasets: datasets.length, ...Object.fromEntries(Object.entries(keyValues(opts.meta)).map(([k, v]) => [k, parseValue(v)])),
      },
    },
    notes,
  };
}

const EXPORT_THEME = { bg: '#ffffff', text: '#1d2430', branch: '#3a4452', muted: '#6b7686', guide: '#c4cad3', tip: '#0f9d8a', support: '#59636f', hit: '#fde68a', rangeScale: 1 };

export function sessionToSVG(session) {
  const root = Tree.restore(session.tree);
  const s = { ...DEFAULTS, ...session.settings };
  const th = { ...EXPORT_THEME, ...(s.bgColor ? { bg: s.bgColor } : {}), ...(s.branchColor ? { branch: s.branchColor } : {}), ...(s.labelColor ? { text: s.labelColor } : {}) };
  const sc = buildScene({ root, settings: s, datasets: session.datasets, index: Tree.buildIndex(root), hits: new Set(), measure: measureText }, { theme: th });
  return sceneToSVG(sc.prims, { bounds: sc.bounds, bg: th.bg, font: s.fontFamily }).svg;
}

// JSON that is safe inside <script>.
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(SEPARATORS, c => '\\u' + c.charCodeAt(0).toString(16));

async function viewerTemplate() {
  // eslint-disable-next-line no-undef
  if (typeof __LOCALTREE_VIEWER__ !== 'undefined') return __LOCALTREE_VIEWER__;
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/localtree.html');
  try { return await readFile(path, 'utf8'); } catch (e) {
    throw new Error(`Viewer not built (${path} missing). Run "npm run build" first.`);
  }
}

export async function viewerHTML(embed, title) {
  let html = await viewerTemplate();
  if (title) html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${title.replace(/[<&]/g, '')}</title>`);
  return html.replace('<body>', () => `<body>\n<script>window.LOCALTREE_EMBED=${scriptJson(embed)};</script>`);
}

async function render(o) {
  if (!o.tree || !o.out) throw new Error('render needs --tree and --out');
  const { session, notes } = await buildSession({
    tree: o.tree, annot: o.annot, name: o.name, id: o.id, layout: o.layout, midpoint: o.midpoint, ladderize: o.ladderize,
    colorBy: o['color-by'], palette: o.palette, set: o.set, meta: o.meta,
  });
  const formats = (o.formats || 'svg,html,json').split(',').map(s => s.trim().toLowerCase());
  await mkdir(dirname(resolve(o.out)), { recursive: true });
  const written = [];
  if (formats.includes('json')) { await writeFile(o.out + '.session.json', JSON.stringify(session)); written.push(o.out + '.session.json'); }
  if (formats.includes('svg')) { await writeFile(o.out + '.svg', sessionToSVG(session)); written.push(o.out + '.svg'); }
  if (formats.includes('html')) { await writeFile(o.out + '.html', await viewerHTML({ session }, session.name)); written.push(o.out + '.html'); }
  for (const n of notes) console.error(n);
  console.error(`${session.name}: ${session.meta.leaves} leaves -> ${written.join(', ')}`);
}

async function dashboard(o, files) {
  if (!o.out || !files.length) throw new Error('dashboard needs --out DIR and at least one input file');
  await mkdir(join(o.out, 'data'), { recursive: true });
  if (o.svg) await mkdir(join(o.out, 'svg'), { recursive: true });
  const families = [];
  const seen = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    let session;
    if (detectKind(text, file) === 'session') session = JSON.parse(text);
    else session = (await buildSession({ tree: file })).session;
    let id = slug(session.id || session.name), k = 2;
    while (seen.has(id)) id = `${slug(session.id || session.name)}_${k++}`;
    seen.add(id);
    await writeFile(join(o.out, 'data', id + '.js'), `LocalTreeLoad(${scriptJson(session)},${JSON.stringify(id)});\n`);
    if (o.svg) await writeFile(join(o.out, 'svg', id + '.svg'), sessionToSVG(session));
    families.push({ id, name: session.name, file: `data/${id}.js`, meta: session.meta || { leaves: Tree.leaves(Tree.restore(session.tree)).length } });
  }
  families.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const title = o.title || 'LocalTree dashboard';
  await writeFile(join(o.out, 'index.html'), await viewerHTML({ dashboard: { title, families } }, title));
  console.error(`Dashboard with ${families.length} families -> ${join(o.out, 'index.html')}`);
}

export async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      tree: { type: 'string' }, annot: { type: 'string', multiple: true }, name: { type: 'string' }, id: { type: 'string' },
      layout: { type: 'string' }, midpoint: { type: 'boolean' }, ladderize: { type: 'boolean' }, 'color-by': { type: 'string' },
      palette: { type: 'string' }, set: { type: 'string', multiple: true }, meta: { type: 'string', multiple: true },
      formats: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' }, svg: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (o.version) { console.log(VERSION); return; }
  if (o.help || !cmd) { console.log(USAGE); return; }
  if (cmd === 'render') return render(o);
  if (cmd === 'dashboard') return dashboard(o, rest);
  throw new Error(`Unknown command "${cmd}". Run "localtree --help".`);
}
