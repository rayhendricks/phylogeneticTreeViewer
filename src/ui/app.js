/* LocalTree UI controller: state, rendering pipeline, interaction, import/export, persistence. */
import * as Tree from '../core/tree.js';
import * as Newick from '../io/newick.js';
import * as Ann from '../io/annotations.js';
import { SAMPLES } from '../io/samples.js';
import { encodeSession, decodeSession } from '../io/share.js';
import { treeFromJplace } from '../io/jplace.js';
import { fetchTaxa, treeFromLineages } from '../io/taxonomy.js';
import { buildScene, leafMap, fmtNum, SELECTION_COLORS } from '../render/scene.js';
import { paint } from '../render/canvas.js';
import { sceneToSVG, esc } from '../render/svg.js';
import { PALETTES } from '../render/color.js';
import { View } from './view.js';
import { DEFAULTS, autoSettings } from '../core/settings.js';
import { detectKind } from '../io/detect.js';
import { initPanels } from './panels.js';
import { initDashboard } from './dashboard.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const STORAGE_KEY = 'ptv-session-v2';
const THEME_KEY = 'ptv-theme';


export const state = {
  tree: null, name: '', fileTrees: null, settings: { ...DEFAULTS }, datasets: [], selection: [],
  hits: new Set(), index: null, undo: [], redo: [], scene: null, overlay: [], dsMaps: null,
};

const el = {
  canvas: $('#canvas'), stage: $('#stage'), empty: $('#empty-state'), stats: $('#tree-stats'),
  search: $('#search-input'), searchMode: $('#search-mode'), searchResult: $('#search-result'),
  selPanel: $('#selection-panel'), tooltip: $('#tooltip'), ctx: $('#ctx-menu'), fileInput: $('#file-input'),
  treeSwitch: $('#tree-switch'), treeSwitchWrap: $('#tree-switch-wrap'), undo: $('#btn-undo'), redo: $('#btn-redo'),
  drop: $('#drop-overlay'),
};

// ---------- utilities ----------
export function toast(msg, type = 'info', ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? ms * 1.5 : ms);
}

function download(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = () => (state.name || 'tree').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'tree';

const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
const measureCache = new Map();
function measure(text, size, bold, italic, font) {
  const f = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${font || state.settings.fontFamily}`;
  const key = f + '\u0000' + text;
  let w = measureCache.get(key);
  if (w == null) {
    measureCtx.font = f;
    w = measureCtx.measureText(text).width;
    if (measureCache.size > 200000) measureCache.clear();
    measureCache.set(key, w);
  }
  return w;
}

function theme(forExport) {
  const s = state.settings;
  let th;
  if (forExport) {
    th = { bg: '#ffffff', text: '#1d2430', branch: '#3a4452', muted: '#6b7686', guide: '#c4cad3', tip: '#0f9d8a', support: '#59636f', hit: '#fde68a', rangeScale: 1 };
  } else {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    th = {
      bg: v('--canvas'), text: v('--tree-text'), branch: v('--tree-branch'), muted: v('--tree-muted'),
      guide: v('--tree-guide'), tip: v('--tree-tip'), support: v('--tree-support'), hit: v('--tree-hit'),
      rangeScale: parseFloat(v('--tree-range-scale')) || 1,
    };
  }
  if (s.bgColor) th.bg = s.bgColor;
  if (s.branchColor) th.branch = s.branchColor;
  if (s.labelColor) th.text = s.labelColor;
  return th;
}

export const nodeLabel = n => (n.style && n.style.displayName) || n.name ||
  (n.children.length ? `Internal node (${Tree.leaves(n).length} leaves)` : 'Unnamed leaf');

function model(clean) {
  return {
    root: state.tree.root, settings: state.settings, datasets: state.datasets, index: state.index,
    hits: clean ? new Set() : state.hits, measure,
  };
}

// ---------- rendering pipeline ----------
// rebuild(): tree/settings/datasets changed -> new scene. repaint(): view or overlay changed -> paint only.
// Large scenes: while panning/zooming, move a cached bitmap of the last frame and repaint
// at full quality once the motion stops. Small scenes always repaint fully.
let frameCache = null, interacting = false, idleTimer = null;
const heavyScene = () => state.scene && state.scene.points.length > 1500;

const view = new View(el.canvas, () => {
  hideTooltip();
  hover = null;
  if (heavyScene()) {
    interacting = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { interacting = false; schedulePaint(); }, 140);
  }
  schedulePaint();
});
const ctx2d = el.canvas.getContext('2d');
let hoverNode = null, hover = null, paintQueued = false, rebuildQueued = false, fitNext = false;

function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintNow(); });
}

export function requestRebuild(opts = {}) {
  if (opts.fit) fitNext = true;
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => { rebuildQueued = false; rebuild({ fit: fitNext }); fitNext = false; });
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

function paintNow() {
  const { w, h, dpr } = sizeCanvas();
  const th = theme(false);
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.fillStyle = th.bg;
  ctx2d.fillRect(0, 0, el.canvas.width, el.canvas.height);
  if (!state.scene) return;
  const fc = frameCache;
  if (interacting && fc && fc.canvas.width === el.canvas.width && fc.canvas.height === el.canvas.height) {
    const r = view.k / fc.k;
    ctx2d.setTransform(r, 0, 0, r, dpr * (view.x - fc.x * r), dpr * (view.y - fc.y * r));
    ctx2d.drawImage(fc.canvas, 0, 0);
    return;
  }
  ctx2d.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
  const prims = hover ? [...state.scene.prims, ...state.overlay, hover] : state.overlay.length ? [...state.scene.prims, ...state.overlay] : state.scene.prims;
  const t0 = performance.now();
  paint(ctx2d, prims, view, { width: w, height: h, font: state.settings.fontFamily, onImageLoad: schedulePaint });
  state.paintMs = performance.now() - t0;
  if (heavyScene()) {
    if (!fc || fc.canvas.width !== el.canvas.width || fc.canvas.height !== el.canvas.height) {
      frameCache = { canvas: new OffscreenCanvas(el.canvas.width, el.canvas.height) };
    }
    const cctx = frameCache.canvas.getContext('2d');
    cctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    cctx.drawImage(el.canvas, 0, 0);
    Object.assign(frameCache, { k: view.k, x: view.x, y: view.y });
  } else {
    frameCache = null;
  }
}

export function rebuild(opts = {}) {
  state.dsMaps = null;
  if (!state.tree) {
    state.scene = null;
    el.empty.hidden = false;
    el.selPanel.hidden = true;
    schedulePaint();
    return;
  }
  el.empty.hidden = true;
  const t0 = performance.now();
  state.scene = buildScene(model(false), { theme: theme(false), legendBelow: el.canvas.clientHeight > el.canvas.clientWidth * 1.15 });
  state.buildMs = performance.now() - t0;
  buildHitGrid(state.scene.points);
  refreshOverlay();
  if (opts.fit) view.fit(state.scene.bounds, false);
  updateUndoButtons();
  scheduleSave();
  schedulePaint();
}

export function refreshOverlay() {
  state.overlay = state.scene ? state.scene.overlay(state.selection, theme(false).bg) : [];
  updateSelectionPanel();
  schedulePaint();
}

export const fit = (animate = true) => state.scene && view.fit(state.scene.bounds, animate);

// ---------- tree state & undo ----------
function reindex() { state.index = Tree.buildIndex(state.tree.root); }


export function setTree(root, name, opts = {}) {
  state.tree = { root };
  state.name = name || 'Untitled tree';
  state.undo = []; state.redo = [];
  state.selection = [];
  if (!opts.keepDatasets) state.datasets = [];
  if ('fileTrees' in opts) state.fileTrees = opts.fileTrees;
  if (opts.auto !== false) autoSettings(state.settings, root);
  reindex();
  updateTreeSwitch();
  refreshSearch(false);
  panels.sync();
  updateStats();
  rebuild({ fit: true });
}

const snap = () => ({ tree: Tree.snapshot(state.tree.root), datasets: state.datasets.map(d => ({ ...d })), settings: { ...state.settings } });

function applySnap(s) {
  state.tree = { root: Tree.restore(s.tree) };
  state.datasets = s.datasets;
  if (s.settings) state.settings = s.settings;
  afterChange();
}

export function afterChange(opts = {}) {
  reindex();
  state.selection = state.selection.filter(id => state.index.byId.has(id));
  refreshSearch(false);
  updateStats();
  panels.sync();
  rebuild(opts);
}

// Run fn as an undoable edit. fn may return false to signal "nothing changed".
export function mutate(fn, opts = {}) {
  if (!state.tree) return;
  const before = snap();
  let result;
  try { result = fn(); } catch (e) { applySnap(before); toast(e.message, 'error'); return; }
  if (result === false) return false;
  pushUndo(before);
  afterChange(opts);
  return result;
}

export function pushUndo(before) {
  state.undo.push(before);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
}

// Live edits (sliders, color pickers): one undo step per gesture, committed on 'change'.
let pendingSnap = null;
export function liveEdit(fn) {
  if (!state.tree) return;
  if (!pendingSnap) pendingSnap = snap();
  fn();
  panels.syncLight();
  requestRebuild();
}
export function commitLive() {
  if (!pendingSnap) return;
  pushUndo(pendingSnap);
  pendingSnap = null;
  updateUndoButtons();
  panels.sync();
}

function undo() { if (!state.undo.length) return; state.redo.push(snap()); applySnap(state.undo.pop()); }
function redo() { if (!state.redo.length) return; state.undo.push(snap()); applySnap(state.redo.pop()); }
function updateUndoButtons() { el.undo.disabled = !state.undo.length; el.redo.disabled = !state.redo.length; }

function requireTree() { if (!state.tree) throw new Error('Load a tree first'); }

// ---------- persistence ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.tree || state.embedded) return;
    try {
      const json = JSON.stringify(sessionObject());
      if (json.length > 4.5e6) throw new Error('too large');
      localStorage.setItem(STORAGE_KEY, json);
    } catch (e) { /* autosave is best effort */ }
  }, 800);
}

export function sessionObject() {
  return {
    ptvSession: 3, name: state.name, savedAt: new Date().toISOString(),
    tree: Tree.snapshot(state.tree.root), datasets: state.datasets, settings: state.settings,
  };
}

function migrateDataset(d) {
  // v2 heatmaps stored colorMin/colorMid/colorMax.
  if (d.type === 'heatmap' && d.opts && !d.opts.stops) {
    d.opts.stops = [d.opts.colorMin, d.opts.colorMid, d.opts.colorMax].filter(Boolean);
  }
  return d;
}

// keepView: keep the current display choices (layout, colors, labels) but take size-dependent ones from the session.
const SIZE_KEYS = ['spacing', 'fontSize', 'treeWidth', 'branchLengths', 'support'];
export function loadSession(o, keepView = false) {
  if (!o || !Array.isArray(o.tree) || !o.tree.length) throw new Error('Invalid session file');
  const root = Tree.restore(o.tree);
  const incoming = { ...DEFAULTS, ...(o.settings || {}) };
  if (keepView && state.tree) {
    const kept = { ...state.settings };
    for (const k of SIZE_KEYS) kept[k] = incoming[k];
    // Category coloring refers to a dataset id; keep it only if this session has that dataset.
    if (kept.branchColorBy.startsWith('cat:') && !(o.datasets || []).some(d => 'cat:' + d.id === kept.branchColorBy)) kept.branchColorBy = incoming.branchColorBy;
    state.settings = kept;
  } else {
    state.settings = incoming;
  }
  state.datasets = Array.isArray(o.datasets) ? o.datasets.map(migrateDataset) : [];
  setTree(root, o.name, { keepDatasets: true, auto: false, fileTrees: null });
}

// ---------- loading ----------

export async function ingest(text, kind, name) {
  if (kind === 'session') { loadSession(JSON.parse(text)); toast(`Session "${state.name}" loaded`); return; }
  if (kind === 'tree') {
    const trees = Newick.parseTrees(text);
    setTree(trees[0].root, trees.length > 1 ? name : (trees[0].name || name), { fileTrees: trees.length > 1 ? trees : null });
    if (trees.length > 1) toast(`${trees.length} trees in file. Showing the first; switch in the Tree panel.`);
    return;
  }
  if (kind === 'jplace') {
    const r = treeFromJplace(text);
    setTree(r.root, name || 'Placements', { fileTrees: null });
    toast(`${r.placed} placement(s) grafted onto their best edge` + (r.missing ? `, ${r.missing} on unknown edges` : ''));
    return;
  }
  requireTree();
  if (kind === 'meme') addDataset(Ann.datasetFromMeme(text, (name || 'MEME motifs').replace(/\.[^.]+$/, '')), true);
  else if (kind === 'annotation') await applyAnnotationText(text, true);
  else if (kind === 'fasta') addDataset(Ann.datasetFromFasta(text, (name || 'Alignment').replace(/\.[^.]+$/, '')), true);
  else if (kind === 'table') await panels.openTableWizard(Ann.parseTable(text), name);
}

let batchNotes = null;
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  batchNotes = files.length > 1 ? [] : null;
  const items = await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() })));
  const order = { session: 0, jplace: 1, tree: 1, annotation: 2, meme: 3, fasta: 3, table: 4 };
  items.forEach(it => { it.kind = detectKind(it.text, it.name); });
  items.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const it of items) {
    try { await ingest(it.text, it.kind, it.name); } catch (e) { toast(`${it.name}: ${e.message}`, 'error'); }
  }
  if (batchNotes && batchNotes.length) toast(batchNotes.length === 1 ? batchNotes[0] : `Added ${batchNotes.length} datasets: ${batchNotes.join('; ')}`, 'info', 7000);
  batchNotes = null;
}

function addDataset(ds, notify) {
  const matched = ds.rows.filter(r => Tree.resolveSpec(state.index, r.id)).length;
  mutate(() => { state.datasets.push(ds); });
  const msg = `"${ds.label}" (${matched}/${ds.rows.length} IDs matched)`;
  if (batchNotes && matched) batchNotes.push(msg);
  else if (notify) toast(`Added ${msg}`, matched ? 'info' : 'error');
}

async function applyAnnotationText(text, notify) {
  const p = Ann.parseItol(text);
  if (Ann.isTreeAnnotation(p.type)) {
    let res;
    mutate(() => {
      res = Ann.applyTreeAnnotation(p, state.index);
      if (res.multiStyle) state.settings.multiStyle = res.multiStyle;
      if (res.prune && res.prune.size && !Tree.prune(state.tree, res.prune)) { res = null; throw new Error('PRUNE: nothing left to keep'); }
    });
    if (!res) return;
    if (notify) toast(`${p.type}: ${res.applied} row(s) applied` + (res.missing.length ? `, ${res.missing.length} ID(s) not found (e.g. ${res.missing.slice(0, 3).join(', ')})` : ''));
    if (res.taxonomy && res.taxonomy.length) await applyTaxonomyIds(res.taxonomy, res.labelFormat);
    return;
  }
  const ds = Ann.datasetFromItol(p);
  addDataset(ds, notify);
  // COLOR_BRANCHES on a color strip colors the tree's branches by its categories.
  if (ds.type === 'colorstrip' && ds.opts && ds.opts.colorBranches) { state.settings.branchColorBy = 'cat:' + ds.id; panels.sync(); rebuild(); }
}

// AUTO_TAXONOMY: look up NCBI taxonomy IDs, store each rank as metadata and relabel leaves.
const RANKS = ['superkingdom', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];
async function applyTaxonomyIds(pairs, labelFormat) {
  toast(`Fetching ${pairs.length} taxonomy IDs from NCBI…`, 'info', 4000);
  let taxa;
  try { ({ taxa } = await fetchTaxa(pairs.map(p => p[1]))); } catch (e) { toast('NCBI taxonomy lookup failed: ' + e.message, 'error'); return; }
  const byId = new Map(taxa.map(t => [t.id, t]));
  mutate(() => {
    for (const [nodeId, taxid] of pairs) {
      const n = Tree.resolveSpec(state.index, nodeId), t = byId.get(taxid);
      if (!n || !t) continue;
      const attrs = { ...(n.attrs || {}), taxid, scientific_name: t.name };
      for (const l of [...t.lineage, t]) if (RANKS.includes(l.rank)) attrs[l.rank] = l.name;
      n.attrs = attrs;
      const label = labelFormat ? labelFormat.replace(/%(\w+)%?/g, (m, k) => attrs[k.toLowerCase()] ?? '') : t.name;
      Tree.setStyle(n, { displayName: label.trim() || t.name });
    }
  });
  toast(`Taxonomy applied to ${pairs.filter(p => byId.has(p[1])).length} node(s)`);
}

function loadSample(i) {
  const sm = SAMPLES[i];
  if (!sm) return;
  const root = sm.random ? Tree.randomTree(sm.random, 7 + i) : Newick.parseNewick(sm.newick);
  setTree(root, sm.name, { fileTrees: null });
  if (sm.annotations) {
    for (const text of sm.annotations) {
      const p = Ann.parseItol(text);
      if (Ann.isTreeAnnotation(p.type)) {
        const r = Ann.applyTreeAnnotation(p, state.index);
        if (r.multiStyle) state.settings.multiStyle = r.multiStyle;
      } else state.datasets.push(Ann.datasetFromItol(p));
    }
    Object.assign(state.settings, { alignLabels: true, italic: false }, sm.settings || {});
    afterChange({ fit: true });
  }
}

function updateTreeSwitch() {
  const trees = state.fileTrees;
  el.treeSwitchWrap.hidden = !trees;
  if (!trees) return;
  el.treeSwitch.innerHTML = trees.map((t, i) => `<option value="${i}">${esc(t.name || 'Tree ' + (i + 1))}</option>`).join('');
  const cur = trees.findIndex(t => t.root === state.tree.root);
  if (cur >= 0) el.treeSwitch.value = cur;
}

function updateStats() {
  if (!state.tree) { el.stats.innerHTML = ''; return; }
  const st = Tree.stats(state.tree.root);
  const rows = [
    ['Name', esc(state.name)], ['Leaves', st.leaves.toLocaleString()], ['Internal nodes', st.internal.toLocaleString()],
    ['Rooted', st.rooted ? 'yes' : 'no'], ['Bifurcating', st.binary ? 'yes' : 'no'], ['Branch lengths', st.hasLengths ? 'yes' : 'no'],
  ];
  if (st.hasLengths) rows.push(['Max root-to-tip', fmtNum(st.maxRootToTip)], ['Total length', fmtNum(st.totalLength)]);
  if (st.support) rows.push(['Support range', `${fmtNum(st.support[0])} – ${fmtNum(st.support[1])}`]);
  el.stats.innerHTML = '<dl class="stats">' + rows.map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`).join('') + '</dl>';
}

// ---------- search ----------
function refreshSearch(doRebuild = true) {
  state.hits = new Set();
  const terms = el.search.value.split(/[\n,;]+/).map(t => t.trim()).filter(Boolean);
  if (!terms.length || !state.tree) {
    el.searchResult.textContent = '';
    if (doRebuild) requestRebuild();
    return;
  }
  const mode = el.searchMode.value;
  const nodes = Tree.preorder(state.tree.root).filter(n => n.name || (n.style && n.style.displayName));
  const notFound = [];
  for (const term of terms) {
    let test;
    if (mode === 'regex') {
      let re;
      try { re = new RegExp(term, 'i'); } catch (e) {
        el.searchResult.innerHTML = `<span class="warn">Invalid expression: ${esc(e.message)}</span>`;
        state.hits = new Set();
        if (doRebuild) requestRebuild();
        return;
      }
      test = s => re.test(s);
    } else {
      const q = term.toLowerCase().replace(/_/g, ' ');
      test = mode === 'exact' ? s => s.toLowerCase().replace(/_/g, ' ') === q : s => s.toLowerCase().replace(/_/g, ' ').includes(q);
    }
    let found = 0;
    for (const n of nodes) {
      const dn = n.style && n.style.displayName;
      if ((n.name && test(n.name)) || (dn && test(dn))) { state.hits.add(n.id); found++; }
    }
    if (!found) notFound.push(term);
  }
  let html = `<span class="${state.hits.size ? 'ok' : 'warn'}">${state.hits.size} match${state.hits.size === 1 ? '' : 'es'}</span>`;
  if (notFound.length && terms.length > 1) html += ` · not found (${notFound.length}): ${esc(notFound.slice(0, 15).join(', '))}${notFound.length > 15 ? '…' : ''}`;
  el.searchResult.innerHTML = html;
  if (doRebuild) requestRebuild();
}

const hitNodes = () => [...state.hits].map(id => state.index.byId.get(id)).filter(Boolean);

function searchAction(act) {
  const nodes = hitNodes();
  if (act === 'clear') { el.search.value = ''; refreshSearch(); return; }
  if (!nodes.length) { toast('No matches'); return; }
  const color = $('#search-color').value;
  if (act === 'select') {
    state.selection = nodes.slice(0, 64).map(n => n.id);
    if (nodes.length > 64) toast('Selected the first 64 matches');
    refreshOverlay();
  } else if (act === 'highlight') {
    const m = Tree.mrca(nodes);
    mutate(() => Tree.setStyle(m, { range: color }));
  } else if (act === 'color') {
    mutate(() => {
      for (const n of nodes) {
        if (n.children.length) Tree.setCladeStyle(n, { branchColor: color });
        else Tree.setStyle(n, { labelColor: color, branchColor: color });
      }
    });
  } else if (act === 'prune') {
    const keep = new Set(nodes.flatMap(n => Tree.leaves(n)));
    if (keep.size < 2) { toast('Need at least two matching leaves', 'error'); return; }
    if (!confirm(`Keep ${keep.size} leaves and remove the other ${Tree.leaves(state.tree.root).length - keep.size}? (Undo is available.)`)) return;
    mutate(() => Tree.prune(state.tree, keep), { fit: true });
  }
}

// ---------- selection ----------
function toggleSelect(id) {
  const i = state.selection.indexOf(id);
  if (i >= 0) state.selection.splice(i, 1); else state.selection.push(id);
}

function updateSelectionPanel() {
  const sel = state.selection.map(id => state.index && state.index.byId.get(id)).filter(Boolean);
  if (!sel.length) { el.selPanel.hidden = true; return; }
  const colors = SELECTION_COLORS;
  let html = `<h4>Selection (${sel.length}) <span><button class="link-btn" data-sel="copy">Copy distances</button> · <button class="link-btn" data-sel="clear">Clear</button></span></h4>`;
  html += '<ul class="sel-list">' + sel.map((n, i) =>
    `<li><span class="dot" style="background:${colors[i % colors.length]}"></span><span class="nm" title="${esc(nodeLabel(n))}">${esc(nodeLabel(n))}</span><span class="val" title="Distance to root">${fmtNum(Tree.rootDistance(n))}</span></li>`).join('') + '</ul>';
  if (sel.length >= 2) {
    const m = Tree.mrca(sel);
    html += `<div class="small"><b>Common ancestor:</b> ${esc(nodeLabel(m))}${m.support != null ? `, support ${fmtNum(m.support)}` : ''} · <button class="link-btn" data-sel="mrca-select">Select</button> · <button class="link-btn" data-sel="mrca-highlight">Highlight</button></div>`;
    if (sel.length <= 8) {
      const short = n => esc(nodeLabel(n).slice(0, 10));
      html += '<table class="dist"><tr><th></th>' + sel.map((n, i) => `<th style="color:${colors[i % colors.length]}" title="${esc(nodeLabel(n))}">${i + 1}</th>`).join('') + '</tr>' +
        sel.map((a, i) => `<tr><th title="${esc(nodeLabel(a))}" style="color:${colors[i % colors.length]}">${i + 1} ${short(a)}</th>` +
          sel.map((b, j) => `<td>${i === j ? '–' : fmtNum(Tree.patristic(a, b))}</td>`).join('') + '</tr>').join('') + '</table>';
      html += '<div class="muted small">Patristic distances (sum of branch lengths).</div>';
    }
  }
  el.selPanel.innerHTML = html;
  el.selPanel.hidden = false;
}

function onSelectionPanel(e) {
  const b = e.target.closest('[data-sel]');
  if (!b) return;
  const sel = state.selection.map(id => state.index.byId.get(id)).filter(Boolean);
  const act = b.dataset.sel;
  if (act === 'clear') { state.selection = []; refreshOverlay(); }
  else if (act === 'copy') {
    const names = sel.map(nodeLabel);
    const tsv = ['\t' + names.join('\t'), ...sel.map((a, i) => names[i] + '\t' + sel.map(b2 => Tree.patristic(a, b2)).join('\t'))].join('\n');
    copyText(tsv, 'Distance matrix copied (TSV)');
  } else if (act === 'mrca-select') { state.selection = [Tree.mrca(sel).id]; refreshOverlay(); }
  else if (act === 'mrca-highlight') { const m = Tree.mrca(sel); mutate(() => Tree.setStyle(m, { range: '#c7d2fe' })); }
}

export async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch (e) { toast('Copy failed: clipboard not available', 'error'); }
}

// ---------- hit testing ----------
let hitGrid = null;
const HIT_CELL = 24;
function buildHitGrid(points) {
  const grid = new Map(), pos = new Map();
  for (const p of points) {
    const k = Math.floor(p[1] / HIT_CELL) + ',' + Math.floor(p[2] / HIT_CELL);
    let arr = grid.get(k);
    if (!arr) grid.set(k, arr = []);
    arr.push(p);
    pos.set(p[0], p);
  }
  hitGrid = { grid, pos };
}

function nodeAt(clientX, clientY) {
  if (!hitGrid || !state.scene) return null;
  const [x, y] = view.toScene(clientX, clientY);
  const r = 9 / view.k;
  const span = Math.min(40, Math.ceil(r / HIT_CELL));
  const cx = Math.floor(x / HIT_CELL), cy = Math.floor(y / HIT_CELL);
  let best = null, bd = r * r;
  for (let i = cx - span; i <= cx + span; i++) {
    for (let j = cy - span; j <= cy + span; j++) {
      const arr = hitGrid.grid.get(i + ',' + j);
      if (!arr) continue;
      for (const q of arr) {
        const d = (q[1] - x) ** 2 + (q[2] - y) ** 2;
        if (d < bd) { bd = d; best = q[0]; }
      }
    }
  }
  if (best == null) {
    // Labels (axis-aligned boxes are exact for rectangular labels, approximate for rotated ones).
    for (const [id, b] of state.scene.labels) if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) { best = id; break; }
  }
  if (best == null) {
    // Dataset columns: map the row (or angle) back to its leaf.
    const R = state.scene.rows;
    if (R.n && !R.circ && R.rect && x > R.treeEnd) {
      const i = nearestRow(R.tipYs, y);
      if (i >= 0 && i < R.n && R.cells.some(([a, b]) => x >= a && x <= b)) best = R.tips[i];
    } else if (R.n && R.circ) {
      const rr = Math.hypot(x, y);
      if (R.cells.some(([a, b]) => rr >= a && rr <= b)) {
        let a = Math.atan2(y, x) * 180 / Math.PI - R.ang0;
        a = ((a % 360) + 360) % 360;
        const i = Math.round(a / R.da - (R.full ? 0.5 : 0));
        if (i >= 0 && i < R.n) best = R.tips[i];
      }
    }
  }
  return best == null ? null : state.index.byId.get(best) || null;
}

// Binary search for the tip row closest to y (rows can have uneven spacing).
function nearestRow(ys, y) {
  let lo = 0, hi = ys.length - 1;
  if (hi < 0) return -1;
  const asc = ys[hi] >= ys[0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((ys[mid] < y) === asc) lo = mid; else hi = mid;
  }
  return Math.abs(ys[lo] - y) <= Math.abs(ys[hi] - y) ? lo : hi;
}

function hoverPrim(node) {
  const p = node && hitGrid && hitGrid.pos.get(node.id);
  if (!p) return null;
  const r = 6 / view.k;
  return { k: 'p', d: `M${p[1] - r},${p[2]}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0Z`, fill: 'rgba(79,70,229,0.18)', stroke: '#4f46e5', lw: 1.5 / view.k, box: null };
}

// ---------- tooltip ----------
function datasetValueText(ds, row) {
  if (!row) return null;
  const fl = i => (ds.fields && ds.fields[i] || {}).label || i + 1;
  switch (ds.type) {
    case 'colorstrip': return row.label || row.color;
    case 'simplebar': return fmtNum(row.value);
    case 'text': return row.label;
    case 'binary': return row.values.map((v, i) => `${fl(i)}: ${v === 1 ? 'yes' : v === 0 ? 'no' : '–'}`).join(', ');
    case 'boxplot': return `median ${fmtNum(row.median)} (IQR ${fmtNum(row.q1)}–${fmtNum(row.q3)})`;
    case 'domains': return row.domains.map(d => d.label || d.shape).join(', ');
    case 'alignment': return `${row.seq.replace(/[-.]/g, '').length} residues`;
    case 'linechart': return `${row.points.length} points`;
    case 'pie': case 'heatmap': case 'multibar': case 'shapes':
      return row.values.map((v, i) => `${fl(i)}: ${v == null ? '–' : fmtNum(v)}`).join(', ');
    default: return null;
  }
}

// POPUP_INFO html: keep basic formatting tags and safe images/links, drop everything else.
const POPUP_TAGS = new Set(['b', 'i', 'u', 'em', 'strong', 'br', 'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'img', 'a', 'sub', 'sup', 'hr']);
function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = node => {
    for (const c of Array.from(node.children)) {
      const tag = c.tagName.toLowerCase();
      if (!POPUP_TAGS.has(tag)) { c.replaceWith(...(['script', 'style', 'iframe', 'object'].includes(tag) ? [] : c.childNodes)); continue; }
      for (const a of Array.from(c.attributes)) {
        const ok = (tag === 'img' && ['src', 'width', 'height', 'alt'].includes(a.name)) || (tag === 'a' && a.name === 'href') || a.name === 'style' && !/url\(|expression/i.test(a.value);
        if (!ok || ((a.name === 'src' || a.name === 'href') && !Ann.safeUrl(a.value))) c.removeAttribute(a.name);
      }
      if (tag === 'a') { c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener noreferrer'); }
      walk(c);
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

function tooltipHTML(n) {
  if (n.style && (n.style.popupHtml || n.style.popupTitle)) {
    return `<b>${esc(n.style.popupTitle || nodeLabel(n))}</b><div class="popup">${sanitizeHTML(n.style.popupHtml || '')}</div>`;
  }
  const rows = [];
  if (n.length != null) rows.push(['Branch length', fmtNum(n.length)]);
  if (n.support != null) rows.push(['Support', fmtNum(n.support)]);
  rows.push(['Distance to root', fmtNum(Tree.rootDistance(n))]);
  if (n.children.length) rows.push(['Leaves', Tree.leaves(n).length.toLocaleString()]);
  if (n.style && n.style.displayName && n.name) rows.push(['ID', esc(n.name)]);
  if (n.attrs) Object.entries(n.attrs).slice(0, 8).forEach(([k, v]) => rows.push([esc(k), esc(v)]));
  if (!n.children.length && state.datasets.length) {
    if (!state.dsMaps) state.dsMaps = state.datasets.map(d => (['symbol', 'connection'].includes(d.type) ? null : leafMap(d, state.index)));
    state.datasets.forEach((ds, i) => {
      const map = state.dsMaps[i];
      const txt = map && datasetValueText(ds, map.get(n.name));
      if (txt != null && txt !== '') rows.push([esc(ds.label), esc(String(txt).slice(0, 140))]);
    });
  }
  return `<b>${esc(nodeLabel(n))}</b><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}

function showTooltip(n, x, y) {
  el.tooltip.innerHTML = tooltipHTML(n);
  el.tooltip.hidden = false;
  const r = el.tooltip.getBoundingClientRect();
  el.tooltip.style.left = Math.max(4, Math.min(x + 14, window.innerWidth - r.width - 8)) + 'px';
  el.tooltip.style.top = Math.max(4, y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14) + 'px';
}
function hideTooltip() { el.tooltip.hidden = true; }

// ---------- context menu ----------
const SWATCHES = ['#e15759', '#f28e2b', '#edc948', '#59a14f', '#76b7b2', '#4e79a7', '#b07aa1', '#ff9da7', '#9c755f', '#1d2430'];
let ctxTarget = 'clade', ctxNode = null;

function openContextMenu(node, x, y) {
  hideTooltip();
  ctxNode = node;
  const leaf = !node.children.length, root = !node.parent;
  const targets = leaf ? [['branch', 'Branch'], ['label', 'Label'], ['range', 'Highlight'], ['labelBg', 'Label bg']]
    : [['clade', 'Clade'], ['branch', 'Branch'], ['label', 'Labels'], ['range', 'Highlight']];
  if (!targets.some(t => t[0] === ctxTarget)) ctxTarget = targets[0][0];
  const selected = state.selection.includes(node.id);
  const sub = leaf ? (node.length != null ? `Branch length ${fmtNum(node.length)}` : 'Leaf')
    : `${Tree.leaves(node).length} leaves${node.support != null ? ` · support ${fmtNum(node.support)}` : ''}`;
  const item = (act, label, show = true) => (show ? `<button class="item" data-ctx="${act}">${label}</button>` : '');
  el.ctx.innerHTML = `
    <div class="title" title="${esc(nodeLabel(node))}">${esc(nodeLabel(node))}</div><div class="sub">${sub}</div>
    ${item('select', selected ? 'Deselect' : 'Select')}
    ${item('collapse', node.collapsed ? 'Expand clade' : 'Collapse clade', !leaf)}
    ${item('reroot', 'Reroot on this branch', !root)}
    ${item('rotate', 'Rotate (flip children)', !leaf)}
    ${item('ladderize', 'Ladderize this clade', !leaf)}
    <hr>
    <div class="sub">Color</div>
    <div class="target">${targets.map(([k, l]) => `<button data-ctx-target="${k}" class="${k === ctxTarget ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="swatches">${SWATCHES.map(c => `<button class="swatch" data-ctx-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <button class="swatch none" data-ctx-color="" title="Remove color"></button>
      <input type="color" data-ctx-custom value="#4f46e5" title="Custom color"></div>
    ${item('clear-style', leaf ? 'Clear styles' : 'Clear styles in clade')}
    <hr>
    ${item('rename', 'Set display name…')}
    ${item('truncate', node.style && node.style.truncate != null ? 'Restore branch length' : 'Truncate branch…', !root)}
    ${item('spacing', leaf ? 'Set leaf spacing…' : 'Set leaf spacing in clade…')}
    ${item('range-label', 'Set highlight label…', !!(node.style && node.style.range))}
    ${item('copy-newick', 'Copy subtree as Newick', !leaf)}
    ${item('copy-names', 'Copy leaf names', !leaf)}
    ${item('copy-name', 'Copy name', leaf)}
    ${item('extract', 'Keep only this clade', !leaf && !root)}
    ${item('delete', leaf ? 'Remove leaf' : 'Remove clade', !root)}`;
  el.ctx.hidden = false;
  const r = el.ctx.getBoundingClientRect();
  el.ctx.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  el.ctx.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
}

function closeContextMenu() { el.ctx.hidden = true; ctxNode = null; }

function applyColor(node, color) {
  const c = color || null;
  mutate(() => {
    switch (ctxTarget) {
      case 'clade': Tree.setCladeStyle(node, { branchColor: c }); break;
      case 'branch': Tree.setStyle(node, { branchColor: c }); break;
      case 'label': for (const l of Tree.leaves(node)) Tree.setStyle(l, { labelColor: c }); break;
      case 'labelBg': Tree.setStyle(node, { labelBg: c }); break;
      case 'range': Tree.setStyle(node, { range: c, rangeLabel: c ? ((node.style && node.style.rangeLabel) || (node.children.length ? node.name : '') || null) : null }); break;
    }
  });
}

function onContextMenu(e) {
  const node = ctxNode;
  if (!node) return;
  const tgt = e.target.closest('[data-ctx-target]');
  if (tgt) {
    ctxTarget = tgt.dataset.ctxTarget;
    for (const b of el.ctx.querySelectorAll('[data-ctx-target]')) b.classList.toggle('active', b === tgt);
    return;
  }
  const sw = e.target.closest('[data-ctx-color]');
  if (sw) { applyColor(node, sw.dataset.ctxColor); closeContextMenu(); return; }
  const b = e.target.closest('[data-ctx]');
  if (!b) return;
  closeContextMenu();
  ctxAction(b.dataset.ctx, node);
}

function ctxAction(act, node) {
  switch (act) {
    case 'select': toggleSelect(node.id); refreshOverlay(); break;
    case 'collapse': mutate(() => { node.collapsed = !node.collapsed; }); break;
    case 'reroot': mutate(() => Tree.reroot(state.tree, node), { fit: true }); break;
    case 'rotate': mutate(() => Tree.rotate(node)); break;
    case 'ladderize': mutate(() => Tree.ladderize(node, false)); break;
    case 'clear-style': mutate(() => {
      for (const d of node.children.length ? Tree.preorder(node) : [node]) {
        if (d.style) Tree.setStyle(d, { branchColor: null, branchWidth: null, branchDashed: null, labelColor: null, labelBg: null, labelStyle: null, labelSize: null, range: null, rangeLabel: null });
      }
    }); break;
    case 'rename': {
      const v = prompt('Display name (leave empty to reset)', (node.style && node.style.displayName) || node.name);
      if (v != null) mutate(() => Tree.setStyle(node, { displayName: v.trim() && v.trim() !== node.name ? v.trim() : null }));
      break;
    }
    case 'range-label': {
      const v = prompt('Label shown in the legend', node.style.rangeLabel || '');
      if (v != null) mutate(() => Tree.setStyle(node, { rangeLabel: v.trim() || null }));
      break;
    }
    case 'copy-newick': copyText(Newick.toNewick(node), 'Subtree Newick copied'); break;
    case 'copy-names': copyText(Tree.leaves(node).map(l => l.name).join('\n'), 'Leaf names copied'); break;
    case 'copy-name': copyText(node.name, 'Name copied'); break;
    case 'extract': mutate(() => Tree.extractClade(state.tree, node), { fit: true }); break;
    case 'delete': mutate(() => Tree.removeClade(state.tree, node), { fit: true }); break;
    case 'truncate': {
      if (node.style && node.style.truncate != null) { mutate(() => Tree.setStyle(node, { truncate: null })); break; }
      const v = prompt('Draw this branch with length', fmtNum((node.length || 0) / 10));
      if (v != null && isFinite(parseFloat(v))) mutate(() => Tree.setStyle(node, { truncate: Math.max(0, parseFloat(v)) }));
      break;
    }
    case 'spacing': {
      const v = prompt('Leaf spacing factor (1 = normal)', String((node.style && node.style.spacing) || 1));
      if (v != null && parseFloat(v) > 0) mutate(() => { for (const l of node.children.length ? Tree.leaves(node) : [node]) Tree.setStyle(l, { spacing: parseFloat(v) === 1 ? null : parseFloat(v) }); });
      break;
    }
  }
}

// Shortcuts that act on the node under the mouse.
const HOVER_KEYS = { c: 'collapse', r: 'reroot', t: 'rotate', l: 'ladderize', n: 'rename', s: 'select', x: 'delete', k: 'extract', b: 'truncate' };

// ---------- canvas interaction ----------
let lastClickId = null, suppressClick = false, pressTimer = null, pressStart = null;

function bindCanvas() {
  el.canvas.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    closeContextMenu();
    const node = nodeAt(e.clientX, e.clientY);
    if (!node) {
      if (e.detail === 1 && state.selection.length) { state.selection = []; refreshOverlay(); }
      return;
    }
    if (e.detail === 2 && lastClickId === node.id) {
      toggleSelect(node.id);
      if (node.children.length) mutate(() => { node.collapsed = !node.collapsed; });
      else refreshOverlay();
      return;
    }
    lastClickId = node.id;
    toggleSelect(node.id);
    refreshOverlay();
  });
  el.canvas.addEventListener('contextmenu', e => {
    const node = nodeAt(e.clientX, e.clientY);
    if (!node) return;
    e.preventDefault();
    openContextMenu(node, e.clientX, e.clientY);
  });
  el.canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' && !e.buttons) {
      const node = nodeAt(e.clientX, e.clientY);
      hoverNode = node;
      const hp = hoverPrim(node);
      if ((hp && hp.d) !== (hover && hover.d)) { hover = hp; schedulePaint(); }
      el.canvas.classList.toggle('over-node', !!node);
      if (node) showTooltip(node, e.clientX, e.clientY); else hideTooltip();
    }
    if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart[0], e.clientY - pressStart[1]) > 10) { clearTimeout(pressTimer); pressTimer = null; }
  });
  el.canvas.addEventListener('pointerleave', () => { hoverNode = null; hideTooltip(); if (hover) { hover = null; schedulePaint(); } });
  el.canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const node = nodeAt(e.clientX, e.clientY);
    if (!node) return;
    pressStart = [e.clientX, e.clientY];
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressTimer = null; suppressClick = true; openContextMenu(node, pressStart[0], pressStart[1]); }, 550);
  });
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  el.canvas.addEventListener('pointerup', cancelPress);
  el.canvas.addEventListener('pointercancel', cancelPress);
  new ResizeObserver(() => schedulePaint()).observe(el.canvas);
}

// ---------- export ----------
function exportScene() {
  return buildScene(model(true), { theme: theme(true) });
}

// Export options from the Export menu: margin, PNG scale, visible area only.
function exportOpts(sc) {
  const pad = Math.max(0, parseFloat($('#exp-margin').value) || 0);
  let bounds = sc.bounds;
  if ($('#exp-visible').checked) {
    const r = el.canvas.getBoundingClientRect();
    const [x0, y0] = view.toScene(r.left, r.top), [x1, y1] = view.toScene(r.right, r.bottom);
    const bx0 = Math.max(x0, bounds.x), by0 = Math.max(y0, bounds.y);
    const bx1 = Math.min(x1, bounds.x + bounds.w), by1 = Math.min(y1, bounds.y + bounds.h);
    if (bx1 > bx0 && by1 > by0) bounds = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  }
  return { pad, bounds, scale: $('#exp-scale').value };
}

function exportSVG() {
  const sc = exportScene();
  const th = theme(true);
  const o = exportOpts(sc);
  return sceneToSVG(sc.prims, { bounds: o.bounds, bg: th.bg, font: state.settings.fontFamily, pad: o.pad });
}

async function exportPNG() {
  const sc = exportScene();
  const th = theme(true);
  const o = exportOpts(sc);
  const pad = o.pad, b = o.bounds;
  const w = b.w + 2 * pad, h = b.h + 2 * pad;
  const maxScale = Math.min(Math.sqrt(250e6 / (w * h)), 32000 / Math.max(w, h));
  const scale = o.scale === 'auto' ? Math.max(0.25, Math.min(4, Math.sqrt(120e6 / (w * h)), 16000 / Math.max(w, h))) : Math.min(+o.scale, maxScale);
  const draw = withImages => {
    const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    const cx = c.getContext('2d');
    cx.fillStyle = th.bg;
    cx.fillRect(0, 0, c.width, c.height);
    cx.setTransform(scale, 0, 0, scale, (pad - b.x) * scale, (pad - b.y) * scale);
    const prims = withImages ? sc.prims : sc.prims.filter(p => p.k !== 'i');
    paint(cx, prims, { k: scale, x: (pad - b.x) * scale, y: (pad - b.y) * scale }, { width: c.width, height: c.height, font: state.settings.fontFamily });
    return c.convertToBlob({ type: 'image/png' });
  };
  try { download(await draw(true), safeName() + '.png'); } catch (e) {
    download(await draw(false), safeName() + '.png');
    toast('Some images could not be included (their server does not allow it). Use SVG export to keep them.', 'error');
  }
}

async function shareLink() {
  const code = await encodeSession(sessionObject());
  const url = `${location.origin}${location.pathname}#s=${code}`;
  await copyText(url, `Link copied (${(url.length / 1024).toFixed(1)} KB). The tree is inside the link; nothing is uploaded.`);
  if (url.length > 60000) toast('This link is long. Some chat apps cut long links; a session file is more reliable.', 'error');
}

function newickForExport() {
  if (!$('#exp-labels').checked) return Newick.toNewick(state.tree.root);
  const copy = Tree.restore(Tree.snapshot(state.tree.root));
  for (const n of Tree.preorder(copy)) if (n.style && n.style.displayName) n.name = n.style.displayName;
  return Newick.toNewick(copy);
}

function doExport(kind) {
  if (!state.tree) { toast('Nothing to export'); return; }
  try {
    if (kind === 'svg') download(exportSVG().svg, safeName() + '.svg', 'image/svg+xml');
    else if (kind === 'png') exportPNG().catch(e => toast('PNG export failed: ' + e.message, 'error'));
    else if (kind === 'newick') download(newickForExport() + '\n', safeName() + '.nwk', 'text/plain');
    else if (kind === 'copy-newick') copyText(newickForExport(), 'Newick copied');
    else if (kind === 'session') download(JSON.stringify(sessionObject()), safeName() + '.session.json', 'application/json');
    else if (kind === 'share') shareLink().catch(e => toast('Could not create link: ' + e.message, 'error'));
  } catch (e) { toast('Export failed: ' + e.message, 'error'); }
}

// ---------- taxonomy ----------
function bindTaxonomy() {
  const dlg = $('#taxonomy-dialog');
  let abort = null;
  $('#btn-taxonomy').onclick = () => { $('#tax-status').textContent = ''; dlg.showModal(); $('#tax-input').focus(); };
  $('#tax-cancel').onclick = () => { if (abort) abort.abort(); };
  $('#tax-build').onclick = async () => {
    const queries = $('#tax-input').value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    if (queries.length < 2) { $('#tax-status').textContent = 'Enter at least two names or IDs.'; return; }
    abort = new AbortController();
    $('#tax-build').disabled = true;
    try {
      const { taxa, missing } = await fetchTaxa(queries, { signal: abort.signal, onProgress: m => { $('#tax-status').textContent = m; } });
      if (taxa.length < 2) throw new Error('Fewer than two taxa were found');
      const root = treeFromLineages(taxa, { keepRanks: $('#tax-ranks').checked });
      dlg.close();
      setTree(root, 'NCBI Taxonomy tree', { fileTrees: null });
      state.settings.showInternalLabels = true;
      panels.sync();
      requestRebuild();
      toast(`Built a tree of ${taxa.length} taxa` + (missing.length ? `. Not found: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}` : ''), missing.length ? 'error' : 'info', 7000);
    } catch (e) {
      if (e.name !== 'AbortError') $('#tax-status').textContent = 'Error: ' + e.message;
    } finally {
      $('#tax-build').disabled = false;
      abort = null;
    }
  };
}

// ---------- theme ----------
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  rebuild();
}

function setMode(mode) {
  state.settings.mode = mode;
  panels.sync();
  rebuild({ fit: true });
}

// ---------- wiring ----------
let panels;

function bind() {
  $('#btn-open').onclick = () => el.fileInput.click();
  el.fileInput.onchange = () => { handleFiles(el.fileInput.files); el.fileInput.value = ''; };
  $('#btn-import-annot').onclick = () => el.fileInput.click();
  $('#btn-import-table').onclick = () => el.fileInput.click();
  $('#btn-paste').onclick = () => { $('#paste-dialog').returnValue = ''; $('#paste-dialog').showModal(); $('#paste-text').focus(); };
  $('#paste-dialog').addEventListener('close', async () => {
    if ($('#paste-dialog').returnValue !== 'load') return;
    const text = $('#paste-text').value;
    if (!text.trim()) return;
    try { await ingest(text, detectKind(text), 'Pasted data'); $('#paste-text').value = ''; } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-help').onclick = () => $('#help-dialog').showModal();
  $('#btn-theme').onclick = toggleTheme;
  el.undo.onclick = undo;
  el.redo.onclick = redo;
  $('#btn-panel').onclick = () => document.body.classList.toggle('panel-open');

  const sampleSel = $('#sample-select');
  sampleSel.innerHTML += SAMPLES.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
  sampleSel.onchange = () => {
    if (sampleSel.value === '') return;
    try { loadSample(+sampleSel.value); } catch (e) { toast(e.message, 'error'); }
    sampleSel.value = '';
  };
  el.treeSwitch.onchange = () => {
    const t = state.fileTrees && state.fileTrees[+el.treeSwitch.value];
    if (t) setTree(t.root, t.name || state.name, { keepDatasets: true, auto: false });
  };

  const exportMenu = $('#export-menu');
  $('#btn-export').onclick = e => { e.stopPropagation(); exportMenu.classList.toggle('hidden'); };
  exportMenu.onclick = e => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    exportMenu.classList.add('hidden');
    doExport(b.dataset.export);
  };

  for (const b of $$('#mode-seg button')) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $$('[data-action]')) {
    b.onclick = () => {
      const a = b.dataset.action;
      if (a === 'fit') { fit(); return; }
      if (!state.tree) return;
      if (a === 'midpoint') {
        if (!Tree.hasBranchLengths(state.tree.root)) { toast('Midpoint rooting needs branch lengths', 'error'); return; }
        mutate(() => Tree.midpointRoot(state.tree), { fit: true });
      } else if (a === 'ladderize-down') mutate(() => Tree.ladderize(state.tree.root, false));
      else if (a === 'ladderize-up') mutate(() => Tree.ladderize(state.tree.root, true));
      else if (a === 'expand-all') mutate(() => { let any = false; for (const n of Tree.preorder(state.tree.root)) if (n.collapsed) { n.collapsed = false; any = true; } return any; });
      else if (a === 'auto-collapse') $('#collapse-dialog').showModal();
      else if (a === 'edit-labels') {
        $('#labels-text').value = Tree.leaves(state.tree.root).map(l => `${l.name}\t${(l.style && l.style.displayName) || l.name}`).join('\n');
        $('#labels-dialog').showModal();
      } else if (a === 'clear-styles') mutate(() => { for (const n of Tree.preorder(state.tree.root)) n.style = n.style && n.style.displayName ? { displayName: n.style.displayName } : null; });
    };
  }

  $('#collapse-apply').onclick = () => {
    const rule = $('#collapse-rule').value, raw = $('#collapse-value').value.trim();
    if (!raw) return;
    const val = rule === 'avgLength' ? parseFloat(raw) : raw;
    if (rule === 'avgLength' && !isFinite(val)) { toast('Enter a number', 'error'); return; }
    let n = 0;
    mutate(() => { n = Tree.autoCollapse(state.tree.root, { [rule]: val }); return n > 0; }, { fit: true });
    toast(`${n} clade(s) collapsed`);
  };
  $('#labels-run').onclick = () => {
    let re;
    try { re = new RegExp($('#labels-find').value, 'g'); } catch (e) { toast('Invalid regular expression', 'error'); return; }
    const rp = $('#labels-replace').value;
    $('#labels-text').value = $('#labels-text').value.split('\n').map(line => {
      const i = line.indexOf('\t');
      return i < 0 ? line : line.slice(0, i + 1) + line.slice(i + 1).replace(re, rp);
    }).join('\n');
  };
  $('#labels-apply').onclick = () => {
    const map = new Map();
    for (const line of $('#labels-text').value.split('\n')) {
      const i = line.indexOf('\t');
      if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
    }
    mutate(() => {
      for (const l of Tree.leaves(state.tree.root)) {
        if (!map.has(l.name)) continue;
        const v = map.get(l.name);
        Tree.setStyle(l, { displayName: v && v !== l.name ? v : null });
      }
    });
  };

  let searchTimer = null;
  el.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshSearch(), 150); });
  el.searchMode.addEventListener('change', () => refreshSearch());
  for (const b of $$('[data-search-action]')) b.onclick = () => searchAction(b.dataset.searchAction);

  el.selPanel.addEventListener('click', onSelectionPanel);
  el.ctx.addEventListener('click', onContextMenu);
  el.ctx.addEventListener('change', e => { if (e.target.matches('[data-ctx-custom]') && ctxNode) { applyColor(ctxNode, e.target.value); closeContextMenu(); } });

  $('#zoom-in').onclick = () => view.zoomCenter(1.5);
  $('#zoom-out').onclick = () => view.zoomCenter(1 / 1.5);
  $('#zoom-fit').onclick = () => fit();

  document.addEventListener('pointerdown', e => {
    if (!el.ctx.hidden && !el.ctx.contains(e.target)) closeContextMenu();
    if (!e.target.closest('.menu-wrap')) $('#export-menu').classList.add('hidden');
    if (document.body.classList.contains('panel-open') && !e.target.closest('#panel') && !e.target.closest('#btn-panel')) document.body.classList.remove('panel-open');
  });

  document.addEventListener('keydown', e => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    const modes = { 1: 'rectangular', 2: 'circular', 3: 'slanted', 4: 'unrooted' };
    if (hoverNode && HOVER_KEYS[e.key] && state.index.byId.get(hoverNode.id) === hoverNode) {
      const act = HOVER_KEYS[e.key], n = hoverNode;
      if (act === 'select') { toggleSelect(n.id); refreshOverlay(); return; }
      if (['collapse', 'rotate', 'ladderize', 'extract'].includes(act) && !n.children.length) return;
      if (['reroot', 'delete', 'extract', 'truncate'].includes(act) && !n.parent) return;
      hideTooltip();
      ctxAction(act, n);
      return;
    }
    if (modes[e.key]) setMode(modes[e.key]);
    else if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === '+' || e.key === '=') view.zoomCenter(1.5);
    else if (e.key === '-') view.zoomCenter(1 / 1.5);
    else if (e.key === '/') { e.preventDefault(); document.body.classList.add('panel-open'); el.search.focus(); }
    else if (e.key === '?') $('#help-dialog').showModal();
    else if (e.key === 'Escape') { closeContextMenu(); hideTooltip(); if (state.selection.length) { state.selection = []; refreshOverlay(); } }
  });

  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; el.drop.hidden = false; });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
  window.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; el.drop.hidden = true; handleFiles(e.dataTransfer.files); });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => rebuild());
  bindCanvas();
  bindTaxonomy();
}

export async function init() {
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* ignore */ }
  panels = initPanels({
    state, DEFAULTS, mutate, liveEdit, commitLive, requestRebuild, rebuild, toast, setMode, refreshSearch,
    palettes: PALETTES,
  });
  bind();
  panels.sync();
  const embed = window.LOCALTREE_EMBED;
  if (embed && (embed.session || embed.dashboard)) {
    state.embedded = true;
    if (embed.session) loadSession(embed.session);
    else initDashboard(embed.dashboard, { loadSession, toast, state });
    return;
  }
  const m = /^#s=([\w-]+)/.exec(location.hash);
  if (m) {
    try {
      loadSession(await decodeSession(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
      toast(`Opened shared tree "${state.name}"`);
      return;
    } catch (e) { toast('Could not open the shared link: ' + e.message, 'error'); }
  }
  let restored = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { loadSession(JSON.parse(saved)); restored = true; }
  } catch (e) { console.warn('Could not restore session:', e); }
  if (!restored) loadSample(0);
}

// Exposed for debugging and automated tests.
window.LocalTree = { state, rebuild, fit, ingest, loadSample, undo, redo, mutate, exportSVG, view, sessionObject, nodeAt };
