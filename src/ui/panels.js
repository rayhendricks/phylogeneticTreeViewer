/* Side panel: settings controls, colors & palettes, dataset list with color editors, table import wizard. */
import * as Tree from '../core/tree.js';
import * as Ann from '../io/annotations.js';
import { RAMPS, PALETTES, paletteColor, parseColor, toHex } from '../render/color.js';
import { esc } from '../render/svg.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const PALETTE_KEY = 'localtree-palettes';

const TYPE_NAMES = {
  colorstrip: 'strip', simplebar: 'bars', multibar: 'stacked', heatmap: 'heatmap', binary: 'binary', shapes: 'shapes',
  text: 'text', symbol: 'symbols', pie: 'pie', domains: 'domains', alignment: 'alignment', boxplot: 'box plot',
  linechart: 'line chart', connection: 'connections', image: 'images', range: 'ranges', arrows: 'arrows',
  timescale: 'timescale', tanglegram: 'tanglegram',
};

const hex = c => { const p = parseColor(c); return p ? toHex(p) : '#888888'; };
const gradientCss = stops => `linear-gradient(90deg, ${stops.join(', ')})`;

export function initPanels(app) {
  const { state } = app;
  const expanded = new Set();

  // ----- palettes -----
  function customPalettes() {
    try { return JSON.parse(localStorage.getItem(PALETTE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveCustom(obj) { try { localStorage.setItem(PALETTE_KEY, JSON.stringify(obj)); } catch (e) { app.toast('Could not save palette', 'error'); } }
  const allPalettes = () => ({ ...PALETTES, ...customPalettes() });
  const currentPalette = () => allPalettes()[state.settings.palette] || PALETTES['Tableau 10'];
  const paletteOptions = sel => Object.keys(allPalettes()).map(n => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');

  function renderPaletteList() {
    const custom = customPalettes();
    const names = Object.keys(custom);
    $('#palette-list').innerHTML = names.length
      ? names.map(n => `<div class="pal-row"><span class="pal-sw">${custom[n].map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span><span class="pal-name">${esc(n)}</span><button class="mini" data-pal-del="${esc(n)}" title="Delete">✕</button></div>`).join('')
      : '<div class="ds-empty">No saved palettes yet.</div>';
  }

  $('#palette-save').onclick = () => {
    const name = $('#palette-name').value.trim();
    const colors = ($('#palette-colors').value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || []).map(hex);
    if (!name) return app.toast('Give the palette a name', 'error');
    if (colors.length < 2) return app.toast('Enter at least two colors, e.g. #1b9e77, #d95f02', 'error');
    saveCustom({ ...customPalettes(), [name]: colors });
    $('#palette-name').value = ''; $('#palette-colors').value = '';
    state.settings.palette = name;
    sync();
    app.toast(`Palette "${name}" saved`);
  };
  $('#palette-list').addEventListener('click', e => {
    const b = e.target.closest('[data-pal-del]');
    if (!b) return;
    const c = customPalettes();
    delete c[b.dataset.palDel];
    saveCustom(c);
    if (state.settings.palette === b.dataset.palDel) state.settings.palette = 'Tableau 10';
    sync();
  });

  // ----- settings controls -----
  function readInput(inp) {
    if (inp.type === 'checkbox') return inp.checked;
    if (inp.type === 'range' || inp.type === 'number') { const v = parseFloat(inp.value); return isFinite(v) ? v : undefined; }
    return inp.value;
  }
  const panel = $('#panel');
  panel.addEventListener('input', e => {
    const inp = e.target.closest('[data-setting]');
    if (inp) {
      const v = readInput(inp);
      if (v === undefined) return;
      app.liveEdit(() => { state.settings[inp.dataset.setting] = v; });
      return;
    }
    const ci = e.target.closest('[data-color-setting]');
    if (ci) app.liveEdit(() => { state.settings[ci.dataset.colorSetting] = ci.value; });
  });
  panel.addEventListener('change', e => {
    if (e.target.closest('[data-setting], [data-color-setting]')) {
      const inp = e.target.closest('[data-setting]');
      if (inp && (inp.tagName === 'SELECT' || inp.type === 'checkbox')) {
        const v = readInput(inp);
        app.liveEdit(() => {
          state.settings[inp.dataset.setting] = v;
          // The global palette recolors datasets whose colors it chose (tables, MEME), not hand-picked ones.
          if (inp.dataset.setting === 'palette') {
            const pal = allPalettes()[v];
            state.datasets.forEach((d, i) => { if (d.autoColor && pal) cow(i, x => applyPaletteTo(x, pal)); });
          }
        });
      }
      app.commitLive();
    }
  });
  panel.addEventListener('click', e => {
    const r = e.target.closest('[data-reset]');
    if (!r) return;
    app.liveEdit(() => { state.settings[r.dataset.reset] = null; });
    app.commitLive();
  });

  function colorByOptions() {
    const s = state.settings;
    const opts = [['none', 'Nothing (single color)']];
    if (state.tree) {
      const nodes = Tree.preorder(state.tree.root);
      if (nodes.some(n => n.children.length && n.support != null)) opts.push(['support', 'Support value']);
      if (nodes.some(n => n.parent && n.length != null)) opts.push(['length', 'Branch length']);
      const attrs = new Set();
      for (const n of nodes) if (n.attrs) for (const [k, v] of Object.entries(n.attrs)) if (v !== '' && isFinite(parseFloat(v))) attrs.add(k);
      for (const k of [...attrs].slice(0, 30)) opts.push(['attr:' + k, `Attribute: ${k}`]);
    }
    for (const d of state.datasets) if (d.type === 'colorstrip') opts.push(['cat:' + d.id, `Categories: ${d.label}`]);
    if (!opts.some(o => o[0] === s.branchColorBy)) s.branchColorBy = 'none';
    return opts.map(([v, l]) => `<option value="${esc(v)}" ${v === s.branchColorBy ? 'selected' : ''}>${esc(l)}</option>`).join('');
  }

  // Options for selects that pick a node metadata field: values (numbers) or ranges ("{a,b}" / "a-b").
  function metaOptions(sel) {
    const kind = sel.dataset.meta || 'width';
    const s = state.settings, key = sel.dataset.setting;
    const opts = kind === 'values' ? [['support', 'Support']] : [['none', kind === 'ranges' ? 'None' : 'Nothing (uniform)']];
    if (kind === 'width' && state.tree) opts.push(['support', 'Support value'], ['length', 'Branch length']);
    if (state.tree) {
      const num = new Set(), rng = new Set();
      for (const n of Tree.preorder(state.tree.root)) if (n.attrs) for (const [k, v] of Object.entries(n.attrs)) {
        if (/^\s*[{[]?\s*-?[\d.eE+-]+\s*[,;]\s*-?[\d.eE+-]+\s*[}\]]?\s*$/.test(String(v))) rng.add(k);
        else if (v !== '' && isFinite(parseFloat(v))) num.add(k);
      }
      if (kind === 'ranges') for (const k of [...rng].slice(0, 30)) opts.push([k, k]);
      else for (const k of [...num].slice(0, 30)) opts.push(['attr:' + k, `Attribute: ${k}`]);
    }
    if (!opts.some(o => o[0] === s[key])) s[key] = opts[0][0];
    return opts.map(([v, l]) => `<option value="${esc(v)}" ${v === s[key] ? 'selected' : ''}>${esc(l)}</option>`).join('');
  }

  function syncLight() {
    const s = state.settings;
    for (const o of $$('output[data-for]')) {
      const k = o.dataset.for, v = s[k];
      o.textContent = k === 'arc' || k === 'rotation' ? v + '°' : k === 'rangeOpacity' ? Math.round(v * 100) + '%' : v;
    }
  }

  function sync() {
    const s = state.settings;
    $('#branch-color-by').innerHTML = colorByOptions();
    $('#branch-ramp').innerHTML = Object.keys(RAMPS).map(n => `<option ${n === s.branchRamp ? 'selected' : ''}>${n}</option>`).join('');
    $('#branch-ramp-row').hidden = s.branchColorBy === 'none' || s.branchColorBy.startsWith('cat:');
    $('#palette-select').innerHTML = paletteOptions(s.palette);
    for (const sel of $$('.meta-select')) sel.innerHTML = metaOptions(sel);
    for (const inp of $$('[data-setting]')) {
      const k = inp.dataset.setting;
      if (inp.type === 'checkbox') inp.checked = !!s[k];
      else if (s[k] != null) inp.value = s[k];
      else if (inp.type === 'number') inp.value = '';
    }
    const cs = getComputedStyle(document.documentElement);
    const defaults = { bgColor: '--canvas', branchColor: '--tree-branch', labelColor: '--tree-text' };
    for (const inp of $$('[data-color-setting]')) {
      const k = inp.dataset.colorSetting;
      inp.value = hex(s[k] || cs.getPropertyValue(defaults[k]).trim());
      inp.closest('label').classList.toggle('custom', !!s[k]);
    }
    for (const b of $$('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === s.mode);
    for (const e of $$('[data-modes]')) e.hidden = !e.dataset.modes.split(' ').includes(s.mode);
    syncLight();
    renderDatasetList();
    renderPaletteList();
  }

  // ----- dataset list & editors -----
  function editor(ds, i) {
    const palSel = `<select class="select sm" data-ds-act="palette"><option value="">Apply palette…</option>${paletteOptions('')}</select>`;
    const colorRow = (attr, val, label) => `<label class="ed-row"><input type="color" ${attr} value="${hex(val)}"><span title="${esc(label)}">${esc(label)}</span></label>`;
    switch (ds.type) {
      case 'colorstrip': {
        const cats = new Map();
        for (const r of ds.rows) if (!cats.has(r.label || r.color)) cats.set(r.label || r.color, r.color);
        const list = [...cats].slice(0, 80);
        return `<div class="ed-grid">${list.map(([lab, c]) => colorRow(`data-cat="${esc(lab)}"`, c, lab)).join('')}</div>
          ${cats.size > 80 ? `<div class="ds-empty">${cats.size - 80} more categories not shown</div>` : ''}
          <div class="ed-actions">${palSel}<button class="btn sm" data-ds-act="color-labels">Color labels</button>
          <button class="btn sm" data-ds-act="color-branches">Color branches</button></div>`;
      }
      case 'heatmap': {
        const stops = (ds.opts && ds.opts.stops) || RAMPS.Viridis;
        const o = ds.opts || {};
        return `<div class="ramp-preview" style="background:${gradientCss(stops)}"></div>
          <div class="ed-actions"><select class="select sm" data-ds-act="ramp"><option value="">Color ramp…</option>${Object.keys(RAMPS).map(n => `<option>${n}</option>`).join('')}</select>
          <button class="btn sm" data-ds-act="reverse">Reverse</button></div>
          <div class="ed-actions">${[0, Math.floor((stops.length - 1) / 2), stops.length - 1].filter((v, j, a) => a.indexOf(v) === j).map(j => `<input type="color" data-stop="${j}" value="${hex(stops[j])}" title="${j === 0 ? 'Low' : j === stops.length - 1 ? 'High' : 'Middle'}">`).join('')}
          <input class="input num sm" type="number" step="any" data-minmax="min" placeholder="min" value="${o.min ?? ''}" title="Value mapped to the low color (blank = data minimum)">
          <input class="input num sm" type="number" step="any" data-minmax="max" placeholder="max" value="${o.max ?? ''}" title="Value mapped to the high color (blank = data maximum)"></div>`;
      }
      case 'multibar': case 'binary': case 'shapes': case 'pie':
        return `<div class="ed-grid">${ds.fields.map((f, j) => colorRow(`data-field="${j}"`, f.color, f.label)).join('')}</div><div class="ed-actions">${palSel}</div>`;
      case 'domains': {
        const labs = new Map();
        for (const r of ds.rows) for (const d of r.domains) { const k = d.label || d.shape; if (!labs.has(k)) labs.set(k, d.color); }
        return `<div class="ed-grid">${[...labs].slice(0, 60).map(([l, c]) => colorRow(`data-dom="${esc(l)}"`, c, l)).join('')}
          ${colorRow('data-ds-act="backbone"', ds.opts.backbone, 'Backbone')}</div><div class="ed-actions">${palSel}</div>`;
      }
      case 'alignment':
        return `<div class="ed-actions"><select class="select sm" data-ds-act="scheme">
          ${[['auto', 'Auto-detect colors'], ['nucleotide', 'Nucleotide'], ['protein', 'Amino acid (Clustal)']].map(([v, l]) => `<option value="${v}" ${ds.opts.scheme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <label class="ed-row wide">Column width <input type="range" min="0.5" max="16" step="0.5" value="${ds.opts.cell || 4}" data-ds-act="cell"></label>`;
      case 'simplebar': case 'boxplot': case 'linechart':
        return `<div class="ed-grid">${colorRow('data-ds-act="color"', ds.color, 'Color')}</div>`;
      case 'connection':
        return `<div class="ed-grid">${colorRow('data-ds-act="conn-color"', ds.rows[0] && ds.rows[0].color, 'Color (all)')}</div>`;
      default:
        return '<div class="ds-empty">No color options for this dataset type.</div>';
    }
  }

  function renderDatasetList() {
    const list = state.datasets;
    $('#ds-count').textContent = list.length ? `(${list.length})` : '';
    const box = $('#ds-list');
    if (!list.length) {
      box.innerHTML = '<div class="ds-empty">No datasets yet. Import an iTOL annotation file, a FASTA alignment or a CSV/TSV table, or drop files onto the tree.</div>';
      return;
    }
    box.innerHTML = list.map((ds, i) => {
      const sized = !['symbol', 'text', 'connection', 'alignment'].includes(ds.type);
      const open = expanded.has(ds.id);
      return `<div class="ds-item" data-ds="${i}">
        <div class="ds-head">
          <input type="checkbox" data-ds-act="visible" ${ds.visible !== false ? 'checked' : ''} title="Show">
          <span class="ds-name" title="${esc(ds.label)}">${esc(ds.label)}</span>
          <span class="ds-type">${TYPE_NAMES[ds.type] || ds.type}</span>
        </div>
        <div class="ds-tools">
          ${sized ? `<input type="range" min="4" max="400" step="1" value="${Math.round(ds.width || 20)}" data-ds-act="width" title="Width" aria-label="Width">` : '<span style="flex:1"></span>'}
          <button data-ds-act="edit" title="Colors" class="${open ? 'on' : ''}">🎨</button>
          <button data-ds-act="rename" title="Rename">✎</button>
          <button data-ds-act="up" title="Move closer to tree">↑</button>
          <button data-ds-act="down" title="Move outward">↓</button>
          <button data-ds-act="remove" title="Remove">✕</button>
        </div>
        ${open ? `<div class="ds-editor">${editor(ds, i)}</div>` : ''}</div>`;
    }).join('');
  }

  // Copy-on-write edit of dataset i so undo snapshots stay intact.
  function cow(i, fn) {
    const ds = state.datasets[i];
    const d = {
      ...ds, fields: ds.fields && ds.fields.map(f => ({ ...f })),
      opts: ds.opts && { ...ds.opts, stops: ds.opts.stops && [...ds.opts.stops] },
    };
    fn(d);
    state.datasets[i] = d;
  }

  function applyPaletteTo(d, pal) {
    if (d.type === 'colorstrip') {
      const cats = [...new Set(d.rows.map(r => r.label || r.color))];
      const m = new Map(cats.map((c, j) => [c, paletteColor(j, pal)]));
      d.rows = d.rows.map(r => ({ ...r, color: m.get(r.label || r.color) }));
    } else if (d.type === 'domains') {
      const labs = [...new Set(d.rows.flatMap(r => r.domains.map(x => x.label || x.shape)))];
      const m = new Map(labs.map((c, j) => [c, paletteColor(j, pal)]));
      d.rows = d.rows.map(r => ({ ...r, domains: r.domains.map(x => ({ ...x, color: m.get(x.label || x.shape) })) }));
    } else if (d.fields) {
      d.fields.forEach((f, j) => { f.color = paletteColor(j, pal); });
    }
  }

  const dsBox = $('#ds-list');
  function onDs(e) {
    const item = e.target.closest('[data-ds]');
    if (!item) return;
    const i = +item.dataset.ds;
    const ds = state.datasets[i];
    if (!ds) return;
    const t = e.target;
    const act = t.dataset.dsAct;
    const live = fn => app.liveEdit(() => cow(i, fn));
    const recolor = fn => live(d => { fn(d); d.autoColor = false; });

    if (e.type === 'input') {
      if (act === 'width') live(d => { d.width = +t.value; });
      else if (act === 'color') recolor(d => { d.color = t.value; });
      else if (act === 'backbone') live(d => { d.opts.backbone = t.value; });
      else if (act === 'cell') live(d => { d.opts.cell = +t.value; });
      else if (act === 'conn-color') live(d => { d.rows = d.rows.map(r => ({ ...r, color: t.value })); });
      else if (t.dataset.cat != null) recolor(d => { const k = t.dataset.cat; d.rows = d.rows.map(r => ((r.label || r.color) === k ? { ...r, color: t.value } : r)); });
      else if (t.dataset.field != null) recolor(d => { d.fields[+t.dataset.field].color = t.value; });
      else if (t.dataset.dom != null) recolor(d => { const k = t.dataset.dom; d.rows = d.rows.map(r => ({ ...r, domains: r.domains.map(x => ((x.label || x.shape) === k ? { ...x, color: t.value } : x)) })); });
      else if (t.dataset.stop != null) live(d => { d.opts.stops[+t.dataset.stop] = t.value; });
      else if (t.dataset.minmax) { const v = t.value === '' ? null : parseFloat(t.value); live(d => { d.opts[t.dataset.minmax] = isFinite(v) ? v : null; }); }
      return;
    }
    if (e.type === 'change') {
      if (act === 'visible') { app.liveEdit(() => cow(i, d => { d.visible = t.checked; })); app.commitLive(); }
      else if (act === 'palette' && t.value) { const pal = allPalettes()[t.value]; app.mutate(() => cow(i, d => { applyPaletteTo(d, pal); d.autoColor = false; })); }
      else if (act === 'ramp' && t.value) app.mutate(() => cow(i, d => { d.opts.stops = [...RAMPS[t.value]]; }));
      else if (act === 'scheme') app.mutate(() => cow(i, d => { d.opts.scheme = t.value; }));
      else app.commitLive();
      return;
    }
    if (e.type !== 'click' || !act || t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
    if (act === 'edit') { expanded.has(ds.id) ? expanded.delete(ds.id) : expanded.add(ds.id); renderDatasetList(); }
    else if (act === 'remove') app.mutate(() => { state.datasets.splice(i, 1); });
    else if (act === 'up' && i > 0) app.mutate(() => { [state.datasets[i - 1], state.datasets[i]] = [state.datasets[i], state.datasets[i - 1]]; });
    else if (act === 'down' && i < state.datasets.length - 1) app.mutate(() => { [state.datasets[i + 1], state.datasets[i]] = [state.datasets[i], state.datasets[i + 1]]; });
    else if (act === 'rename') {
      const name = prompt('Dataset name', ds.label);
      if (name != null && name.trim()) app.mutate(() => cow(i, d => { d.label = name.trim(); }));
    } else if (act === 'reverse') app.mutate(() => cow(i, d => { d.opts.stops = (d.opts.stops || RAMPS.Viridis).slice().reverse(); }));
    else if (act === 'color-labels') {
      app.mutate(() => {
        for (const r of ds.rows) {
          const node = Tree.resolveSpec(state.index, r.id);
          if (!node) continue;
          for (const l of node.children.length ? Tree.leaves(node) : [node]) Tree.setStyle(l, { labelColor: r.color });
        }
      });
    } else if (act === 'color-branches') {
      app.liveEdit(() => { state.settings.branchColorBy = 'cat:' + ds.id; });
      app.commitLive();
      app.toast('Branches colored where all descendant leaves share a category');
    }
  }
  dsBox.addEventListener('input', onDs);
  dsBox.addEventListener('change', onDs);
  dsBox.addEventListener('click', onDs);

  // ----- table import -----
  const COLUMN_TYPES = [
    ['colorstrip', 'Color strip (categories)'], ['gradient', 'Color gradient (numbers)'], ['simplebar', 'Bar chart'],
    ['heatmap', 'Heatmap column'], ['multibar', 'Stacked bars'], ['pie', 'Pie chart slice'], ['binary', 'Presence / absence'],
    ['text', 'Text'], ['rename', 'Display name (rename leaves)'],
  ];

  function openTableWizard(table, name) {
    return new Promise(resolve => {
      const dlg = $('#table-dialog');
      const idSel = $('#tbl-id'), body = $('#tbl-cols');
      const sample = table.rows.slice(0, 3000);
      const matchCount = i => sample.filter(r => r[i] && Tree.lookupName(state.index, r[i])).length;
      let best = 0, bestCount = -1;
      table.header.forEach((h, i) => { const c = matchCount(i); if (c > bestCount) { best = i; bestCount = c; } });
      $('#tbl-summary').textContent = `${name || 'Table'}: ${table.rows.length.toLocaleString()} rows, ${table.header.length} columns. New categories use the "${state.settings.palette}" palette.`;
      idSel.innerHTML = table.header.map((h, i) => `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`).join('');
      idSel.value = best;
      const fill = () => {
        const idCol = +idSel.value;
        const c = matchCount(idCol);
        $('#tbl-match').innerHTML = `<span class="${c ? 'ok' : 'warn'}">${c.toLocaleString()} of ${sample.length.toLocaleString()} rows match a node</span>`;
        let shown = 0;
        body.innerHTML = table.header.map((h, i) => {
          if (i === idCol) return '';
          const vals = table.rows.map(r => r[i]);
          const type = Ann.inferColumnType(vals);
          const ex = [...new Set(vals.filter(v => v))].slice(0, 5).join(', ');
          return `<tr data-col="${i}"><td><input type="checkbox" ${shown++ < 3 ? 'checked' : ''} aria-label="Use column"></td>
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
            const res = Ann.datasetsFromTable(table, +idSel.value, cols, currentPalette());
            app.mutate(() => {
              state.datasets.push(...res.datasets);
              if (res.rename) for (const [id, nm] of res.rename) {
                const node = Tree.resolveSpec(state.index, id);
                if (node && nm) Tree.setStyle(node, { displayName: nm });
              }
            });
            app.toast(`Added ${res.datasets.length} dataset(s)${res.rename ? ' and display names' : ''}`);
          }
        }
        resolve();
      });
      dlg.showModal();
    });
  }

  return { sync, syncLight, openTableWizard, renderDatasetList };
}
