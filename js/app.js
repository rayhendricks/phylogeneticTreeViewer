/* UI controller: state, interaction, import/export, persistence. */
(function () {
  'use strict';
  const { Tree: T, Newick: N, Annotations: A, Render: R, Samples } = window.PTV;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = R.esc;
  const STORAGE_KEY = 'ptv-session-v2';
  const THEME_KEY = 'ptv-theme';

  const DEFAULTS = {
    mode: 'rectangular', branchLengths: true, alignLabels: false, showLeafLabels: true, showInternalLabels: false,
    support: 'none', supportMin: 0, showBranchLengths: false, fontSize: 12, spacing: 18, treeWidth: 500,
    arc: 360, rotation: 0, innerRadius: 0, lineWidth: 1.5, nodeDots: false, italic: false, showLegend: true,
    showScale: true, dimNonHits: true, rangeOpacity: 0.35, datasetGap: 6,
  };

  const state = {
    tree: null, name: '', fileTrees: null, settings: { ...DEFAULTS }, datasets: [], selection: [],
    hits: new Set(), index: null, undo: [], redo: [], bounds: null, dsMaps: null,
  };

  const el = {
    canvas: $('#canvas'), viewport: $('#viewport'), scene: $('#scene'), empty: $('#empty-state'),
    stats: $('#tree-stats'), dsList: $('#ds-list'), dsCount: $('#ds-count'), search: $('#search-input'),
    searchMode: $('#search-mode'), searchResult: $('#search-result'), selPanel: $('#selection-panel'),
    tooltip: $('#tooltip'), ctx: $('#ctx-menu'), fileInput: $('#file-input'), treeSwitch: $('#tree-switch'),
    treeSwitchWrap: $('#tree-switch-wrap'), undo: $('#btn-undo'), redo: $('#btn-redo'), drop: $('#drop-overlay'),
  };

  // ---------- utilities ----------
  function toast(msg, type = 'info', ms = 4000) {
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? ms * 1.5 : ms);
  }

  function download(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const safeName = () => (state.name || 'tree').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'tree';
  const fmt = R.fmtNum;

  const measureCtx = document.createElement('canvas').getContext('2d');
  const measureCache = new Map();
  function measure(text, size, bold, italic) {
    const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
    const key = font + '\u0000' + text;
    let w = measureCache.get(key);
    if (w == null) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
      if (measureCache.size > 100000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  }

  function theme(forExport) {
    if (forExport) {
      return { bg: '#ffffff', text: '#1d2430', branch: '#3a4452', muted: '#6b7686', guide: '#c4cad3', tip: '#0f9d8a', support: '#59636f', hit: '#fde68a' };
    }
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
      bg: v('--canvas'), text: v('--tree-text'), branch: v('--tree-branch'), muted: v('--tree-muted'),
      guide: v('--tree-guide'), tip: v('--tree-tip'), support: v('--tree-support'), hit: v('--tree-hit'),
      rangeScale: parseFloat(v('--tree-range-scale')) || 1,
    };
  }

  const nodeLabel = n => (n.style && n.style.displayName) || n.name ||
    (n.children.length ? `Internal node (${T.leaves(n).length} leaves)` : 'Unnamed leaf');

  function model(clean) {
    return {
      root: state.tree.root, settings: state.settings, datasets: state.datasets, index: state.index,
      selection: clean ? [] : state.selection, hits: clean ? new Set() : state.hits, measure,
    };
  }

  // ---------- zoom ----------
  const zoom = d3.zoom().scaleExtent([0.005, 80]).clickDistance(4)
    .on('zoom', e => { el.viewport.setAttribute('transform', e.transform); hideTooltip(); if (hoverDot) showHover(null); });
  const svgSel = d3.select(el.canvas).call(zoom).on('dblclick.zoom', null);

  function fit(animate = true) {
    const b = state.bounds;
    if (!b || !(b.w > 0) || !(b.h > 0)) return;
    const W = el.canvas.clientWidth, H = el.canvas.clientHeight, pad = 28;
    const k = Math.min((W - 2 * pad) / b.w, (H - 2 * pad) / b.h, 4);
    const t = d3.zoomIdentity.translate((W - b.w * k) / 2 - b.x * k, (H - b.h * k) / 2 - b.y * k).scale(k);
    (animate ? svgSel.transition().duration(350) : svgSel).call(zoom.transform, t);
  }

  // ---------- rendering ----------
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render(opts = {}) {
    state.dsMaps = null;
    if (!state.tree) {
      el.scene.innerHTML = '';
      el.empty.hidden = false;
      el.selPanel.hidden = true;
      return;
    }
    el.empty.hidden = true;
    const res = R.renderScene(model(false), { theme: theme(false), legendBelow: el.canvas.clientHeight > el.canvas.clientWidth * 1.15 });
    el.scene.innerHTML = res.html;
    state.bounds = res.bounds;
    buildHitGrid(res.points);
    if (opts.fit) fit(false);
    updateSelectionPanel();
    updateUndoButtons();
    scheduleSave();
  }

  // ---------- tree state ----------
  function reindex() { state.index = T.buildIndex(state.tree.root); }

  function autoSettings(root) {
    const n = T.leaves(root).length;
    const s = state.settings;
    s.spacing = n > 3000 ? 3 : n > 1000 ? 5 : n > 300 ? 9 : n > 100 ? 14 : 20;
    s.fontSize = Math.max(3, Math.min(13, Math.round(s.spacing * 0.7 * 2) / 2));
    s.treeWidth = Math.round(Math.min(2400, Math.max(450, n * 2)) / 10) * 10;
    s.branchLengths = T.hasBranchLengths(root);
    s.support = 'none';
    for (const nd of T.preorder(root)) if (nd.children.length && nd.support != null) { s.support = n <= 200 ? 'text' : 'symbol'; break; }
  }

  function setTree(root, name, opts = {}) {
    state.tree = { root };
    state.name = name || 'Untitled tree';
    state.undo = []; state.redo = [];
    state.selection = [];
    if (!opts.keepDatasets) state.datasets = [];
    if ('fileTrees' in opts) state.fileTrees = opts.fileTrees;
    if (opts.auto !== false) autoSettings(root);
    reindex();
    updateTreeSwitch();
    refreshSearch(false);
    syncControls();
    renderDatasetList();
    updateStats();
    render({ fit: true });
  }

  const snap = () => ({ tree: T.snapshot(state.tree.root), datasets: state.datasets.map(d => ({ ...d })) });

  function applySnap(s) {
    state.tree = { root: T.restore(s.tree) };
    state.datasets = s.datasets;
    afterChange();
  }

  function afterChange(opts = {}) {
    reindex();
    state.selection = state.selection.filter(id => state.index.byId.has(id));
    refreshSearch(false);
    updateStats();
    renderDatasetList();
    render(opts);
  }

  // Run fn as an undoable edit. fn may return false to signal "nothing changed".
  function mutate(fn, opts = {}) {
    if (!state.tree) return;
    const before = snap();
    let result;
    try { result = fn(); } catch (e) { applySnap(before); toast(e.message, 'error'); return; }
    if (result === false) return false;
    state.undo.push(before);
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    afterChange(opts);
    return result;
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snap());
    applySnap(state.undo.pop());
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snap());
    applySnap(state.redo.pop());
  }

  function updateUndoButtons() {
    el.undo.disabled = !state.undo.length;
    el.redo.disabled = !state.redo.length;
  }

  function requireTree() { if (!state.tree) throw new Error('Load a tree first'); }

  // ---------- persistence ----------
  let saveTimer = null, saveWarned = false;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!state.tree) return;
      try {
        const json = JSON.stringify(sessionObject());
        if (json.length > 4.5e6) throw new Error('too large');
        localStorage.setItem(STORAGE_KEY, json);
      } catch (e) {
        if (!saveWarned) { saveWarned = true; console.warn('Autosave skipped:', e.message); }
      }
    }, 800);
  }

  function sessionObject() {
    return {
      ptvSession: 2, name: state.name, savedAt: new Date().toISOString(),
      tree: T.snapshot(state.tree.root), datasets: state.datasets, settings: state.settings,
    };
  }

  function loadSession(o) {
    if (!o || !Array.isArray(o.tree) || !o.tree.length) throw new Error('Invalid session file');
    const root = T.restore(o.tree);
    state.settings = { ...DEFAULTS, ...(o.settings || {}) };
    state.datasets = Array.isArray(o.datasets) ? o.datasets : [];
    setTree(root, o.name, { keepDatasets: true, auto: false, fileTrees: null });
  }

  // ---------- loading ----------
  function detectKind(text, filename = '') {
    const t = text.replace(/^﻿/, '').trimStart();
    if (t[0] === '{') {
      try { if (JSON.parse(t).ptvSession) return 'session'; } catch (e) { /* not JSON */ }
    }
    if (A.isItol(t)) return 'annotation';
    if (/^#nexus/i.test(t) || t[0] === '<' || t[0] === '(' || t[0] === '[') return 'tree';
    if (/\.(csv|tsv|tab)$/i.test(filename)) return 'table';
    const lines = t.split(/\r?\n/).filter(l => l.trim());
    if (lines.length >= 2 && !t.includes('(') && /[\t,;]/.test(lines[0])) return 'table';
    return 'tree';
  }

  async function ingest(text, kind, name) {
    if (kind === 'session') { loadSession(JSON.parse(text)); toast(`Session "${state.name}" loaded`); return; }
    if (kind === 'tree') {
      const trees = N.parseTrees(text);
      const nm = trees.length > 1 ? name : (trees[0].name || name);
      setTree(trees[0].root, nm, { fileTrees: trees.length > 1 ? trees : null });
      if (trees.length > 1) toast(`${trees.length} trees in file. Showing the first; switch in the Tree panel.`);
      return;
    }
    requireTree();
    if (kind === 'annotation') applyAnnotationText(text, true);
    else if (kind === 'table') await openTableWizard(A.parseTable(text), name);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const items = await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() })));
    const order = { session: 0, tree: 1, annotation: 2, table: 3 };
    items.forEach(it => { it.kind = detectKind(it.text, it.name); });
    items.sort((a, b) => order[a.kind] - order[b.kind]);
    for (const it of items) {
      try { await ingest(it.text, it.kind, it.name); } catch (e) { toast(`${it.name}: ${e.message}`, 'error'); }
    }
  }

  function countMatches(ds) {
    return ds.rows.filter(r => T.resolveSpec(state.index, r.id)).length;
  }

  function applyAnnotationText(text, notify) {
    const p = A.parseItol(text);
    if (A.isTreeAnnotation(p.type)) {
      let res;
      mutate(() => { res = A.applyTreeAnnotation(p, state.index); });
      if (notify) toast(`${p.type}: ${res.applied} row(s) applied` + (res.missing.length ? `, ${res.missing.length} ID(s) not found (e.g. ${res.missing.slice(0, 3).join(', ')})` : ''));
      return;
    }
    const ds = A.datasetFromItol(p);
    const matched = countMatches(ds);
    mutate(() => { state.datasets.push(ds); });
    if (notify) {
      toast(`Added "${ds.label}": ${matched} of ${ds.rows.length} IDs matched`, matched ? 'info' : 'error');
    }
  }

  function loadSample(i) {
    const sm = Samples[i];
    if (!sm) return;
    const root = sm.random ? T.randomTree(sm.random, 7 + i) : N.parseNewick(sm.newick);
    setTree(root, sm.name, { fileTrees: null });
    if (sm.annotations) {
      for (const text of sm.annotations) {
        const p = A.parseItol(text);
        if (A.isTreeAnnotation(p.type)) A.applyTreeAnnotation(p, state.index);
        else state.datasets.push(A.datasetFromItol(p));
      }
      state.settings.alignLabels = true;
      state.settings.italic = true;
      syncControls();
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

  // ---------- panels ----------
  function updateStats() {
    if (!state.tree) { el.stats.innerHTML = ''; return; }
    const st = T.stats(state.tree.root);
    const rows = [
      ['Name', esc(state.name)],
      ['Leaves', st.leaves.toLocaleString()],
      ['Internal nodes', st.internal.toLocaleString()],
      ['Rooted', st.rooted ? 'yes' : 'no'],
      ['Bifurcating', st.binary ? 'yes' : 'no'],
      ['Branch lengths', st.hasLengths ? 'yes' : 'no'],
    ];
    if (st.hasLengths) {
      rows.push(['Max root-to-tip', fmt(st.maxRootToTip)], ['Total length', fmt(st.totalLength)]);
    }
    if (st.support) rows.push(['Support range', `${fmt(st.support[0])} – ${fmt(st.support[1])}`]);
    el.stats.innerHTML = '<dl class="stats">' + rows.map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`).join('') + '</dl>';
    el.stats.className = '';
  }

  function syncControls() {
    const s = state.settings;
    for (const inp of $$('[data-setting]')) {
      const k = inp.dataset.setting;
      if (inp.type === 'checkbox') inp.checked = !!s[k];
      else inp.value = s[k];
    }
    for (const o of $$('output[data-for]')) {
      const k = o.dataset.for, v = s[k];
      o.textContent = k === 'arc' || k === 'rotation' ? v + '°' : k === 'rangeOpacity' ? Math.round(v * 100) + '%' : v;
    }
    for (const b of $$('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === s.mode);
    for (const e of $$('[data-modes]')) e.hidden = !e.dataset.modes.split(' ').includes(s.mode);
  }

  const TYPE_NAMES = { colorstrip: 'strip', simplebar: 'bars', multibar: 'stacked', heatmap: 'heatmap', binary: 'binary', text: 'text', symbol: 'symbols' };

  function renderDatasetList() {
    const list = state.datasets;
    el.dsCount.textContent = list.length ? `(${list.length})` : '';
    if (!list.length) {
      el.dsList.innerHTML = '<div class="ds-empty">No datasets yet. Import an iTOL annotation file or a CSV/TSV table, or drop files onto the tree.</div>';
      return;
    }
    el.dsList.innerHTML = list.map((ds, i) => {
      const sized = ds.type !== 'symbol' && ds.type !== 'text';
      const colorInput = ds.type === 'simplebar' && /^#[0-9a-f]{6}$/i.test(ds.color || '')
        ? `<input type="color" value="${ds.color}" data-ds-act="color" title="Bar color">` : '';
      return `<div class="ds-item" data-ds="${i}">
        <div class="ds-head">
          <input type="checkbox" data-ds-act="visible" ${ds.visible !== false ? 'checked' : ''} title="Show">
          <span class="ds-name" title="${esc(ds.label)}">${esc(ds.label)}</span>
          <span class="ds-type">${TYPE_NAMES[ds.type] || ds.type}</span>
        </div>
        <div class="ds-tools">
          ${sized ? `<input type="range" min="4" max="400" step="1" value="${Math.round(ds.width || 20)}" data-ds-act="width" title="Width" aria-label="Width">` : '<span style="flex:1"></span>'}
          ${colorInput}
          <button data-ds-act="rename" title="Rename">✎</button>
          <button data-ds-act="up" title="Move closer to tree">↑</button>
          <button data-ds-act="down" title="Move outward">↓</button>
          <button data-ds-act="remove" title="Remove">✕</button>
        </div></div>`;
    }).join('');
  }

  function onDatasetEvent(e) {
    const t = e.target.closest('[data-ds-act]');
    const item = e.target.closest('[data-ds]');
    if (!t || !item) return;
    const i = +item.dataset.ds;
    const ds = state.datasets[i];
    if (!ds) return;
    const act = t.dataset.dsAct;
    if (e.type === 'input') {
      if (act === 'width') { ds.width = +t.value; requestRender(); }
      if (act === 'color') { ds.color = t.value; requestRender(); }
      return;
    }
    if (e.type !== 'click' && e.type !== 'change') return;
    if (act === 'visible' && e.type === 'change') { ds.visible = t.checked; render(); }
    else if (act === 'remove' && e.type === 'click') mutate(() => { state.datasets.splice(i, 1); });
    else if (act === 'up' && e.type === 'click' && i > 0) mutate(() => { [state.datasets[i - 1], state.datasets[i]] = [state.datasets[i], state.datasets[i - 1]]; });
    else if (act === 'down' && e.type === 'click' && i < state.datasets.length - 1) mutate(() => { [state.datasets[i + 1], state.datasets[i]] = [state.datasets[i], state.datasets[i + 1]]; });
    else if (act === 'rename' && e.type === 'click') {
      const name = prompt('Dataset name', ds.label);
      if (name != null && name.trim()) mutate(() => { state.datasets[i] = { ...ds, label: name.trim() }; });
    }
  }

  // ---------- search ----------
  function refreshSearch(doRender = true) {
    state.hits = new Set();
    const terms = el.search.value.split(/[\n,;]+/).map(t => t.trim()).filter(Boolean);
    if (!terms.length || !state.tree) {
      el.searchResult.textContent = '';
      if (doRender) requestRender();
      return;
    }
    const mode = el.searchMode.value;
    const nodes = T.preorder(state.tree.root).filter(n => n.name || (n.style && n.style.displayName));
    const notFound = [];
    for (const term of terms) {
      let test;
      if (mode === 'regex') {
        let re;
        try { re = new RegExp(term, 'i'); } catch (e) {
          el.searchResult.innerHTML = `<span class="warn">Invalid expression: ${esc(e.message)}</span>`;
          state.hits = new Set();
          if (doRender) requestRender();
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
    if (notFound.length && terms.length > 1) {
      html += ` · not found (${notFound.length}): ${esc(notFound.slice(0, 15).join(', '))}${notFound.length > 15 ? '…' : ''}`;
    }
    el.searchResult.innerHTML = html;
    if (doRender) requestRender();
  }

  function hitNodes() { return [...state.hits].map(id => state.index.byId.get(id)).filter(Boolean); }

  function searchAction(act) {
    const nodes = hitNodes();
    if (act === 'clear') { el.search.value = ''; refreshSearch(); return; }
    if (!nodes.length) { toast('No matches'); return; }
    const color = $('#search-color').value;
    if (act === 'select') {
      state.selection = nodes.slice(0, 64).map(n => n.id);
      if (nodes.length > 64) toast('Selected the first 64 matches');
      render();
    } else if (act === 'highlight') {
      const m = T.mrca(nodes);
      mutate(() => T.setStyle(m, { range: color }));
    } else if (act === 'color') {
      mutate(() => {
        for (const n of nodes) {
          if (n.children.length) T.setCladeStyle(n, { branchColor: color });
          else T.setStyle(n, { labelColor: color, branchColor: color });
        }
      });
    } else if (act === 'prune') {
      const keep = new Set(nodes.flatMap(n => T.leaves(n)));
      if (keep.size < 2) { toast('Need at least two matching leaves', 'error'); return; }
      if (!confirm(`Keep ${keep.size} leaves and remove the other ${T.leaves(state.tree.root).length - keep.size}? (Undo is available.)`)) return;
      mutate(() => T.prune(state.tree, keep), { fit: true });
    }
  }

  // ---------- selection ----------
  function toggleSelect(id) {
    const i = state.selection.indexOf(id);
    if (i >= 0) state.selection.splice(i, 1); else state.selection.push(id);
  }

  function updateSelectionPanel() {
    const sel = state.selection.map(id => state.index.byId.get(id)).filter(Boolean);
    if (!sel.length) { el.selPanel.hidden = true; return; }
    const colors = R.SELECTION_COLORS;
    let html = `<h4>Selection (${sel.length}) <span><button class="link-btn" data-sel="copy">Copy distances</button> · <button class="link-btn" data-sel="clear">Clear</button></span></h4>`;
    html += '<ul class="sel-list">' + sel.map((n, i) =>
      `<li><span class="dot" style="background:${colors[i % colors.length]}"></span><span class="nm" title="${esc(nodeLabel(n))}">${esc(nodeLabel(n))}</span><span class="val" title="Distance to root">${fmt(T.rootDistance(n))}</span></li>`).join('') + '</ul>';
    if (sel.length >= 2) {
      const m = T.mrca(sel);
      html += `<div class="small"><b>Common ancestor:</b> ${esc(nodeLabel(m))}${m.support != null ? `, support ${fmt(m.support)}` : ''} · <button class="link-btn" data-sel="mrca-select">Select</button> · <button class="link-btn" data-sel="mrca-highlight">Highlight</button></div>`;
      if (sel.length <= 8) {
        const short = n => esc(nodeLabel(n).slice(0, 10));
        html += '<table class="dist"><tr><th></th>' + sel.map((n, i) => `<th style="color:${colors[i % colors.length]}" title="${esc(nodeLabel(n))}">${i + 1}</th>`).join('') + '</tr>' +
          sel.map((a, i) => `<tr><th title="${esc(nodeLabel(a))}" style="color:${colors[i % colors.length]}">${i + 1} ${short(a)}</th>` +
            sel.map((b, j) => `<td>${i === j ? '–' : fmt(T.patristic(a, b))}</td>`).join('') + '</tr>').join('') + '</table>';
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
    if (act === 'clear') { state.selection = []; render(); }
    else if (act === 'copy') {
      const names = sel.map(nodeLabel);
      const tsv = ['\t' + names.join('\t'), ...sel.map((a, i) => names[i] + '\t' + sel.map(b2 => T.patristic(a, b2)).join('\t'))].join('\n');
      copyText(tsv, 'Distance matrix copied (TSV)');
    } else if (act === 'mrca-select') {
      const m = T.mrca(sel);
      state.selection = [m.id];
      render();
    } else if (act === 'mrca-highlight') {
      const m = T.mrca(sel);
      mutate(() => T.setStyle(m, { range: '#c7d2fe' }));
    }
  }

  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(msg); } catch (e2) { toast('Copy failed', 'error'); }
      ta.remove();
    }
  }

  // ---------- tooltip ----------
  function datasetValueText(ds, row) {
    if (!row) return null;
    switch (ds.type) {
      case 'colorstrip': return row.label || row.color;
      case 'simplebar': return fmt(row.value);
      case 'text': return row.label;
      case 'binary': return row.values.map((v, i) => `${(ds.fields[i] || {}).label || i + 1}: ${v === 1 ? 'yes' : v === 0 ? 'no' : '–'}`).join(', ');
      default: return row.values.map((v, i) => `${(ds.fields && ds.fields[i] || {}).label || i + 1}: ${v == null ? '–' : fmt(v)}`).join(', ');
    }
  }

  function tooltipHTML(n) {
    const rows = [];
    if (n.length != null) rows.push(['Branch length', fmt(n.length)]);
    if (n.support != null) rows.push(['Support', fmt(n.support)]);
    rows.push(['Distance to root', fmt(T.rootDistance(n))]);
    if (n.children.length) rows.push(['Leaves', T.leaves(n).length.toLocaleString()]);
    if (n.style && n.style.displayName && n.name) rows.push(['ID', esc(n.name)]);
    if (n.attrs) Object.entries(n.attrs).slice(0, 8).forEach(([k, v]) => rows.push([esc(k), esc(v)]));
    if (!n.children.length && state.datasets.length) {
      if (!state.dsMaps) state.dsMaps = state.datasets.map(d => (d.type === 'symbol' ? null : R.leafMap(d, state.index)));
      state.datasets.forEach((ds, i) => {
        const map = state.dsMaps[i];
        const txt = map && datasetValueText(ds, map.get(n.name));
        if (txt != null && txt !== '') rows.push([esc(ds.label), esc(String(txt).slice(0, 120))]);
      });
    }
    return `<b>${esc(nodeLabel(n))}</b><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  }

  function showTooltip(n, x, y) {
    el.tooltip.innerHTML = tooltipHTML(n);
    el.tooltip.hidden = false;
    const r = el.tooltip.getBoundingClientRect();
    const left = Math.min(x + 14, window.innerWidth - r.width - 8);
    const top = y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14;
    el.tooltip.style.left = Math.max(4, left) + 'px';
    el.tooltip.style.top = Math.max(4, top) + 'px';
  }
  function hideTooltip() { el.tooltip.hidden = true; }

  // ---------- context menu ----------
  const SWATCHES = ['#e15759', '#f28e2b', '#edc948', '#59a14f', '#76b7b2', '#4e79a7', '#b07aa1', '#ff9da7', '#9c755f', '#1d2430'];
  let ctxTarget = 'clade';
  let ctxNode = null;

  function openContextMenu(node, x, y) {
    hideTooltip();
    ctxNode = node;
    const leaf = !node.children.length, root = !node.parent;
    const targets = leaf ? [['branch', 'Branch'], ['label', 'Label'], ['range', 'Highlight'], ['labelBg', 'Label bg']]
      : [['clade', 'Clade'], ['branch', 'Branch'], ['label', 'Labels'], ['range', 'Highlight']];
    if (!targets.some(t => t[0] === ctxTarget)) ctxTarget = targets[0][0];
    const selected = state.selection.includes(node.id);
    const sub = leaf ? (node.length != null ? `Branch length ${fmt(node.length)}` : 'Leaf')
      : `${T.leaves(node).length} leaves${node.support != null ? ` · support ${fmt(node.support)}` : ''}`;
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
        case 'clade': T.setCladeStyle(node, { branchColor: c }); break;
        case 'branch': T.setStyle(node, { branchColor: c }); break;
        case 'label': for (const l of T.leaves(node)) T.setStyle(l, { labelColor: c }); break;
        case 'labelBg': T.setStyle(node, { labelBg: c }); break;
        case 'range': T.setStyle(node, { range: c, rangeLabel: c ? ((node.style && node.style.rangeLabel) || (node.children.length ? node.name : '') || null) : null }); break;
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
    const act = b.dataset.ctx;
    closeContextMenu();
    switch (act) {
      case 'select': toggleSelect(node.id); render(); break;
      case 'collapse': mutate(() => { node.collapsed = !node.collapsed; }); break;
      case 'reroot': mutate(() => T.reroot(state.tree, node), { fit: true }); break;
      case 'rotate': mutate(() => T.rotate(node)); break;
      case 'ladderize': mutate(() => T.ladderize(node, false)); break;
      case 'clear-style': mutate(() => {
        for (const d of node.children.length ? T.preorder(node) : [node]) {
          if (d.style) T.setStyle(d, { branchColor: null, branchWidth: null, branchDashed: null, labelColor: null, labelBg: null, labelStyle: null, labelSize: null, range: null, rangeLabel: null });
        }
      }); break;
      case 'rename': {
        const v = prompt('Display name (leave empty to reset)', (node.style && node.style.displayName) || node.name);
        if (v != null) mutate(() => T.setStyle(node, { displayName: v.trim() && v.trim() !== node.name ? v.trim() : null }));
        break;
      }
      case 'range-label': {
        const v = prompt('Label shown in the legend', node.style.rangeLabel || '');
        if (v != null) mutate(() => T.setStyle(node, { rangeLabel: v.trim() || null }));
        break;
      }
      case 'copy-newick': copyText(N.toNewick(node), 'Subtree Newick copied'); break;
      case 'copy-names': copyText(T.leaves(node).map(l => l.name).join('\n'), 'Leaf names copied'); break;
      case 'copy-name': copyText(node.name, 'Name copied'); break;
      case 'extract': mutate(() => T.extractClade(state.tree, node), { fit: true }); break;
      case 'delete': mutate(() => T.removeClade(state.tree, node), { fit: true }); break;
    }
  }

  // ---------- canvas interaction ----------
  // Nodes are hit-tested in scene coordinates with a uniform grid, which keeps the
  // DOM small (no invisible hit targets) and gives a constant on-screen tolerance.
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

  function toScene(clientX, clientY) {
    const rect = el.canvas.getBoundingClientRect();
    const t = d3.zoomTransform(el.canvas);
    return { p: t.invert([clientX - rect.left, clientY - rect.top]), k: t.k };
  }

  function nearestNode(clientX, clientY) {
    if (!hitGrid) return null;
    const { p: [x, y], k } = toScene(clientX, clientY);
    const r = 9 / k;
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
    return best == null ? null : state.index.byId.get(best) || null;
  }

  function nodeFromEvent(e) {
    const t = e.target.closest && e.target.closest('[data-id]');
    if (t) return state.index.byId.get(+t.dataset.id) || null;
    return nearestNode(e.clientX, e.clientY);
  }

  const hoverDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hoverDot.setAttribute('class', 'hover-dot');
  hoverDot.style.display = 'none';
  el.viewport.appendChild(hoverDot);
  function showHover(node) {
    const p = node && hitGrid && hitGrid.pos.get(node.id);
    if (!p) { hoverDot.style.display = 'none'; el.canvas.classList.remove('over-node'); return; }
    const k = d3.zoomTransform(el.canvas).k;
    hoverDot.setAttribute('cx', p[1]); hoverDot.setAttribute('cy', p[2]);
    hoverDot.setAttribute('r', 6 / k); hoverDot.setAttribute('stroke-width', 1.5 / k);
    hoverDot.style.display = '';
    el.canvas.classList.add('over-node');
  }

  let lastClickId = null, suppressClick = false, pressTimer = null, pressStart = null;

  function onCanvasClick(e) {
    if (suppressClick) { suppressClick = false; return; }
    closeContextMenu();
    const node = nodeFromEvent(e);
    if (!node) {
      if (e.detail === 1 && state.selection.length) { state.selection = []; render(); }
      return;
    }
    if (e.detail === 2 && lastClickId === node.id) {
      toggleSelect(node.id);
      if (node.children.length) mutate(() => { node.collapsed = !node.collapsed; });
      else render();
      return;
    }
    lastClickId = node.id;
    toggleSelect(node.id);
    render();
  }

  function bindCanvas() {
    el.canvas.addEventListener('click', onCanvasClick);
    el.canvas.addEventListener('contextmenu', e => {
      const node = nodeFromEvent(e);
      if (!node) return;
      e.preventDefault();
      openContextMenu(node, e.clientX, e.clientY);
    });
    el.canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' && !e.buttons) {
        const node = nodeFromEvent(e);
        showHover(node);
        if (node) showTooltip(node, e.clientX, e.clientY); else hideTooltip();
      }
      if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart[0], e.clientY - pressStart[1]) > 10) {
        clearTimeout(pressTimer); pressTimer = null;
      }
    });
    el.canvas.addEventListener('pointerleave', () => { hideTooltip(); showHover(null); });
    el.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      const node = nodeFromEvent(e);
      if (!node) return;
      pressStart = [e.clientX, e.clientY];
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressTimer = null; suppressClick = true;
        openContextMenu(node, pressStart[0], pressStart[1]);
      }, 550);
    });
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    el.canvas.addEventListener('pointerup', cancelPress);
    el.canvas.addEventListener('pointercancel', cancelPress);
  }

  // ---------- table import ----------
  const COLUMN_TYPES = [
    ['colorstrip', 'Color strip (categories)'], ['gradient', 'Color gradient (numbers)'], ['simplebar', 'Bar chart'],
    ['heatmap', 'Heatmap column'], ['multibar', 'Stacked bars'], ['binary', 'Presence / absence'],
    ['text', 'Text'], ['rename', 'Display name (rename leaves)'],
  ];

  function openTableWizard(table, name) {
    return new Promise(resolve => {
      const dlg = $('#table-dialog');
      const idSel = $('#tbl-id'), body = $('#tbl-cols');
      const sample = table.rows.slice(0, 3000);
      const matchCount = i => sample.filter(r => r[i] && T.lookupName(state.index, r[i])).length;
      let best = 0, bestCount = -1;
      table.header.forEach((h, i) => { const c = matchCount(i); if (c > bestCount) { best = i; bestCount = c; } });
      $('#tbl-summary').textContent = `${name || 'Table'}: ${table.rows.length.toLocaleString()} rows, ${table.header.length} columns.`;
      idSel.innerHTML = table.header.map((h, i) => `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`).join('');
      idSel.value = best;
      const fill = () => {
        const idCol = +idSel.value;
        const c = matchCount(idCol);
        const leaves = T.leaves(state.tree.root).length;
        $('#tbl-match').innerHTML = `<span class="${c ? 'ok' : 'warn'}">${c.toLocaleString()} of ${sample.length.toLocaleString()} rows match a node (tree has ${leaves.toLocaleString()} leaves)</span>`;
        let shown = 0;
        body.innerHTML = table.header.map((h, i) => {
          if (i === idCol) return '';
          const vals = table.rows.map(r => r[i]);
          const type = A.inferColumnType(vals);
          const ex = [...new Set(vals.filter(v => v))].slice(0, 5).join(', ');
          const checked = shown++ < 3;
          return `<tr data-col="${i}"><td><input type="checkbox" ${checked ? 'checked' : ''} aria-label="Use column"></td>
            <td>${esc(h || 'Column ' + (i + 1))}</td>
            <td><select class="select">${COLUMN_TYPES.map(([k, l]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
            <td class="ex" title="${esc(ex)}">${esc(ex)}</td></tr>`;
        }).join('');
      };
      idSel.onchange = fill;
      fill();
      dlg.returnValue = '';
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        if (dlg.returnValue === 'import') {
          const cols = $$('#tbl-cols tr').filter(tr => tr.querySelector('input').checked)
            .map(tr => ({ index: +tr.dataset.col, type: tr.querySelector('select').value }));
          if (cols.length) {
            const res = A.datasetsFromTable(table, +idSel.value, cols);
            mutate(() => {
              state.datasets.push(...res.datasets);
              if (res.rename) {
                for (const [id, nm] of res.rename) {
                  const node = T.resolveSpec(state.index, id);
                  if (node && nm) T.setStyle(node, { displayName: nm });
                }
              }
            });
            toast(`Added ${res.datasets.length} dataset(s)${res.rename ? ' and display names' : ''}`);
          }
        }
        resolve();
      });
      dlg.showModal();
    });
  }

  // ---------- export ----------
  function exportSVGString() {
    const res = R.renderScene(model(true), { theme: theme(true), interactive: false });
    const b = res.bounds, pad = 16;
    const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad), w = Math.ceil(b.w + 2 * pad), h = Math.ceil(b.h + 2 * pad);
    return {
      svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family="Helvetica, Arial, sans-serif">` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>${res.html}</svg>`,
      w, h,
    };
  }

  async function exportPNG() {
    const { svg, w, h } = exportSVGString();
    const scale = Math.max(0.25, Math.min(4, Math.sqrt(120e6 / (w * h)), 16000 / Math.max(w, h)));
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(blob => (blob ? download(blob, safeName() + '.png') : toast('PNG export failed (image too large)', 'error')), 'image/png');
  }

  function doExport(kind) {
    if (!state.tree) { toast('Nothing to export'); return; }
    try {
      if (kind === 'svg') download(exportSVGString().svg, safeName() + '.svg', 'image/svg+xml');
      else if (kind === 'png') exportPNG().catch(e => toast('PNG export failed: ' + e.message, 'error'));
      else if (kind === 'newick') download(N.toNewick(state.tree.root) + '\n', safeName() + '.nwk', 'text/plain');
      else if (kind === 'copy-newick') copyText(N.toNewick(state.tree.root), 'Newick copied');
      else if (kind === 'session') download(JSON.stringify(sessionObject()), safeName() + '.session.json', 'application/json');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }

  // ---------- theme ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    render();
  }

  // ---------- wiring ----------
  function onSettingInput(e) {
    const inp = e.target.closest('[data-setting]');
    if (!inp) return;
    const k = inp.dataset.setting;
    let v;
    if (inp.type === 'checkbox') v = inp.checked;
    else if (inp.type === 'range' || inp.type === 'number') { v = parseFloat(inp.value); if (!isFinite(v)) return; }
    else v = inp.value;
    state.settings[k] = v;
    if (k === 'dimNonHits' && !state.hits.size) { syncControls(); return; }
    syncControls();
    requestRender();
  }

  function setMode(mode) {
    state.settings.mode = mode;
    syncControls();
    render({ fit: true });
  }

  function bind() {
    $('#btn-open').onclick = () => el.fileInput.click();
    el.fileInput.onchange = () => { handleFiles(el.fileInput.files); el.fileInput.value = ''; };
    $('#btn-import-annot').onclick = () => el.fileInput.click();
    $('#btn-import-table').onclick = () => el.fileInput.click();
    $('#btn-paste').onclick = () => { $('#paste-dialog').returnValue = ''; $('#paste-dialog').showModal(); $('#paste-text').focus(); };
    $('#paste-dialog').addEventListener('close', async () => {
      const dlg = $('#paste-dialog');
      if (dlg.returnValue !== 'load') return;
      const text = $('#paste-text').value;
      if (!text.trim()) return;
      try { await ingest(text, detectKind(text), 'Pasted tree'); $('#paste-text').value = ''; } catch (e) { toast(e.message, 'error'); }
    });
    $('#btn-help').onclick = () => $('#help-dialog').showModal();
    $('#btn-theme').onclick = toggleTheme;
    el.undo.onclick = undo;
    el.redo.onclick = redo;
    $('#btn-panel').onclick = () => document.body.classList.toggle('panel-open');

    const sampleSel = $('#sample-select');
    sampleSel.innerHTML += Samples.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
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

    $('#panel').addEventListener('input', onSettingInput);
    $('#panel').addEventListener('change', e => { if (e.target.matches('select[data-setting], input[type=checkbox][data-setting], input[type=number][data-setting]')) onSettingInput(e); });
    for (const b of $$('#mode-seg button')) b.onclick = () => setMode(b.dataset.mode);

    for (const b of $$('[data-action]')) {
      b.onclick = () => {
        const a = b.dataset.action;
        if (a === 'fit') { fit(); return; }
        if (!state.tree) return;
        if (a === 'midpoint') {
          if (!T.hasBranchLengths(state.tree.root)) { toast('Midpoint rooting needs branch lengths', 'error'); return; }
          mutate(() => T.midpointRoot(state.tree), { fit: true });
        } else if (a === 'ladderize-down') mutate(() => T.ladderize(state.tree.root, false));
        else if (a === 'ladderize-up') mutate(() => T.ladderize(state.tree.root, true));
        else if (a === 'expand-all') mutate(() => { let any = false; for (const n of T.preorder(state.tree.root)) if (n.collapsed) { n.collapsed = false; any = true; } return any; });
        else if (a === 'clear-styles') mutate(() => { for (const n of T.preorder(state.tree.root)) n.style = n.style && n.style.displayName ? { displayName: n.style.displayName } : null; });
      };
    }

    el.dsList.addEventListener('input', onDatasetEvent);
    el.dsList.addEventListener('change', onDatasetEvent);
    el.dsList.addEventListener('click', onDatasetEvent);

    let searchTimer = null;
    el.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshSearch(), 150); });
    el.searchMode.addEventListener('change', () => refreshSearch());
    for (const b of $$('[data-search-action]')) b.onclick = () => searchAction(b.dataset.searchAction);

    el.selPanel.addEventListener('click', onSelectionPanel);
    el.ctx.addEventListener('click', onContextMenu);
    el.ctx.addEventListener('change', e => {
      if (e.target.matches('[data-ctx-custom]') && ctxNode) { applyColor(ctxNode, e.target.value); closeContextMenu(); }
    });

    $('#zoom-in').onclick = () => svgSel.transition().duration(200).call(zoom.scaleBy, 1.5);
    $('#zoom-out').onclick = () => svgSel.transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
    $('#zoom-fit').onclick = () => fit();

    document.addEventListener('pointerdown', e => {
      if (!el.ctx.hidden && !el.ctx.contains(e.target)) closeContextMenu();
      if (!e.target.closest('.menu-wrap')) $('#export-menu').classList.add('hidden');
      if (document.body.classList.contains('panel-open') && !e.target.closest('#panel') && !e.target.closest('#btn-panel')) {
        document.body.classList.remove('panel-open');
      }
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
      if (modes[e.key]) setMode(modes[e.key]);
      else if (e.key === 'f' || e.key === 'F') fit();
      else if (e.key === '+' || e.key === '=') svgSel.transition().duration(200).call(zoom.scaleBy, 1.5);
      else if (e.key === '-') svgSel.transition().duration(200).call(zoom.scaleBy, 1 / 1.5);
      else if (e.key === '/') { e.preventDefault(); document.body.classList.add('panel-open'); el.search.focus(); }
      else if (e.key === '?') $('#help-dialog').showModal();
      else if (e.key === 'Escape') {
        closeContextMenu(); hideTooltip();
        if (state.selection.length) { state.selection = []; render(); }
      }
    });

    // Drag and drop anywhere.
    let dragDepth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; el.drop.hidden = false; });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
      handleFiles(e.dataTransfer.files);
    });

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
    bindCanvas();
  }

  function init() {
    try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* ignore */ }
    bind();
    syncControls();
    renderDatasetList();
    let restored = false;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) { loadSession(JSON.parse(saved)); restored = true; }
    } catch (e) { console.warn('Could not restore session:', e); }
    if (!restored) loadSample(0);
  }

  // Exposed for debugging and automated tests.
  window.PTV.app = { state, render, fit, ingest, loadSample, undo, redo, mutate, exportSVGString };
  init();
})();
