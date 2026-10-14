/* Annotation import: iTOL annotation files, CSV/TSV tables and FASTA. No DOM dependencies. */
import * as Tree from '../core/tree.js';

import { safeColor, paletteColor, RAMPS } from '../render/color.js';

function splitCsvLine(line, d) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"' && cur === '') q = true;
    else if (c === d) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function splitBy(line, sep) {
  if (sep === '\t') return line.split('\t');
  if (sep === ' ') return line.trim().split(/ +/);
  return splitCsvLine(line, sep);
}

function detectSeparator(line) {
  const counts = { '\t': 0, ',': 0, ';': 0 };
  for (const c of line) if (c in counts) counts[c]++;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '\t';
}

function parseTable(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() && !/^#/.test(l));
  if (!lines.length) throw new Error('Table is empty');
  const sep = detectSeparator(lines[0]);
  const rows = lines.map(l => splitBy(l, sep).map(v => v.trim()));
  return { header: rows[0], rows: rows.slice(1), sep };
}

const ITOL_TYPES = [
  'DATASET_COLORSTRIP', 'DATASET_SIMPLEBAR', 'DATASET_MULTIBAR', 'DATASET_HEATMAP', 'DATASET_BINARY',
  'DATASET_TEXT', 'DATASET_SYMBOL', 'DATASET_GRADIENT', 'DATASET_STYLE', 'TREE_COLORS', 'LABELS', 'COLLAPSE',
  'DATASET_PIECHART', 'DATASET_DOMAINS', 'DATASET_ALIGNMENT', 'DATASET_BOXPLOT', 'DATASET_LINECHART',
  'DATASET_CONNECTION', 'DATASET_IMAGE', 'DATASET_EXTERNALSHAPE',
];

function isItol(text) {
  const first = String(text).replace(/^﻿/, '').split(/\r?\n/).find(l => l.trim() && !/^#/.test(l.trim()));
  if (!first) return false;
  const tok = first.trim().split(/[\t, ]/)[0].toUpperCase();
  return ITOL_TYPES.includes(tok);
}

function parseItol(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let k = 0;
  while (k < lines.length && (!lines[k].trim() || /^#/.test(lines[k].trim()))) k++;
  const type = (lines[k] || '').trim().split(/[\t, ]/)[0].toUpperCase();
  if (!ITOL_TYPES.includes(type)) throw new Error(`Unsupported annotation type "${type || '(empty)'}"`);
  let sep = null;
  for (const l of lines) {
    const m = /^SEPARATOR[\t, ]+(TAB|COMMA|SPACE)/i.exec(l.trim());
    if (m) { sep = { TAB: '\t', COMMA: ',', SPACE: ' ' }[m[1].toUpperCase()]; break; }
  }
  const body = lines.slice(k + 1).filter(l => l.trim() && !/^#/.test(l.trim()) && !/^SEPARATOR\b/i.test(l.trim()));
  if (!sep) sep = body.some(l => l.includes('\t')) ? '\t' : ',';
  const opts = {}, rows = [];
  const dataAt = body.findIndex(l => /^DATA\s*$/i.test(l.trim()));
  if (type === 'DATASET_ALIGNMENT') {
    body.slice(0, Math.max(0, dataAt)).forEach(l => { const parts = splitBy(l, sep).map(v => v.trim()); opts[parts[0].toUpperCase()] = parts.slice(1); });
    return { type, opts, rows: [], fasta: parseFasta(body.slice(dataAt + 1).join('\n')) };
  }
  body.forEach((l, i) => {
    if (i === dataAt) return;
    const parts = splitBy(l, sep).map(v => v.trim());
    if (dataAt >= 0 && i < dataAt) opts[parts[0].toUpperCase()] = parts.slice(1);
    else rows.push(parts);
  });
  return { type, opts, rows };
}

const first = (o, key, def) => (o[key] && o[key].length && o[key][0] !== '') ? o[key][0] : def;
const num = (v, def) => { const x = parseFloat(v); return isFinite(x) ? x : def; };

let dsCounter = 0;
const newId = () => 'ds' + Date.now().toString(36) + (dsCounter++);

function customLegend(o) {
  if (!o.LEGEND_LABELS || !o.LEGEND_COLORS) return null;
  return {
    title: first(o, 'LEGEND_TITLE', ''),
    items: o.LEGEND_LABELS.map((label, i) => ({
      label, color: safeColor(o.LEGEND_COLORS[i], '#888'), shape: num(o.LEGEND_SHAPES && o.LEGEND_SHAPES[i], 1),
    })),
  };
}

function datasetFromItol(p) {
  const o = p.opts;
  const label = first(o, 'DATASET_LABEL', p.type.replace('DATASET_', '').toLowerCase());
  const color = safeColor(first(o, 'COLOR'), '#4e79a7');
  const fieldLabels = o.FIELD_LABELS || [];
  const fieldColors = o.FIELD_COLORS || [];
  const base = { id: newId(), label, visible: true, color, legend: customLegend(o) };
  const rows = p.rows.filter(r => r.length >= 2 && r[0]);
  switch (p.type) {
    case 'DATASET_COLORSTRIP':
      return { ...base, type: 'colorstrip', width: num(first(o, 'STRIP_WIDTH'), 20),
        rows: rows.map(r => ({ id: r[0], color: safeColor(r[1], '#cccccc'), label: r[2] || '' })) };
    case 'DATASET_SIMPLEBAR':
      return { ...base, type: 'simplebar', width: num(first(o, 'WIDTH'), 120),
        rows: rows.map(r => ({ id: r[0], value: num(r[1], NaN) })).filter(r => isFinite(r.value)) };
    case 'DATASET_MULTIBAR':
      return { ...base, type: 'multibar', width: num(first(o, 'WIDTH'), 150),
        fields: fieldLabels.map((l, i) => ({ label: l, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, 0)) })) };
    case 'DATASET_GRADIENT':
    case 'DATASET_HEATMAP': {
      const fields = p.type === 'DATASET_GRADIENT' ? [{ label }] : fieldLabels.map(l => ({ label: l }));
      const useMid = first(o, 'USE_MID_COLOR', '0') === '1' || !!o.COLOR_MID;
      return { ...base, type: 'heatmap', fields,
        width: fields.length * num(first(o, 'STRIP_WIDTH'), 18),
        opts: {
          stops: [safeColor(first(o, 'COLOR_MIN'), '#deebf7'), useMid ? safeColor(first(o, 'COLOR_MID'), null) : null,
            safeColor(first(o, 'COLOR_MAX'), '#08306b')].filter(Boolean),
          min: num(first(o, 'USER_MIN_VALUE'), null), max: num(first(o, 'USER_MAX_VALUE'), null),
        },
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, null)) })) };
    }
    case 'DATASET_BINARY': {
      const shapes = o.FIELD_SHAPES || [];
      const nF = Math.max(fieldLabels.length, shapes.length, 1);
      const fields = Array.from({ length: nF }, (_, i) => ({
        label: fieldLabels[i] || `Field ${i + 1}`, color: safeColor(fieldColors[i], paletteColor(i)), shape: num(shapes[i], 2),
      }));
      return { ...base, type: 'binary', fields, width: nF * 16,
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, -1)) })) };
    }
    case 'DATASET_TEXT':
      return { ...base, type: 'text', width: 0,
        rows: rows.map(r => ({ id: r[0], label: r[1], color: safeColor(r[3], null), style: r[4] || 'normal', size: num(r[5], 1) })) };
    case 'DATASET_SYMBOL':
      return { ...base, type: 'symbol', width: 0, maxSize: num(first(o, 'MAXIMUM_SIZE'), 10),
        rows: p.rows.filter(r => r.length >= 5).map(r => ({
          id: r[0], shape: num(r[1], 2), size: num(r[2], 5), color: safeColor(r[3], '#888'),
          filled: r[4] !== '0', position: num(r[5], 1), label: r[6] || '',
        })) };
    case 'DATASET_PIECHART':
      return { ...base, type: 'pie', width: num(first(o, 'MAXIMUM_SIZE'), 20) * 2,
        fields: fieldLabels.map((l, i) => ({ label: l, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: p.rows.filter(r => r.length >= 4).map(r => ({
          id: r[0], position: num(r[1], -1), radius: num(r[2], 10), values: r.slice(3).map(v => Math.max(0, num(v, 0))),
        })) };
    case 'DATASET_DOMAINS':
      return { ...base, type: 'domains', width: num(first(o, 'WIDTH'), 200),
        opts: { backbone: safeColor(first(o, 'BACKBONE_COLOR'), '#aaaaaa'), backboneHeight: num(first(o, 'BACKBONE_HEIGHT'), 2) },
        rows: rows.map(r => ({
          id: r[0], length: num(r[1], 0),
          domains: r.slice(2).map(d => d.split('|')).filter(d => d.length >= 3).map(d => ({
            shape: (d[0] || 'RE').toUpperCase(), start: num(d[1], 0), end: num(d[2], 0),
            color: safeColor(d[3], '#888888'), label: d[4] || '',
          })),
        })).filter(r => r.length > 0) };
    case 'DATASET_ALIGNMENT':
      return { ...base, type: 'alignment', width: 0, opts: { scheme: 'auto', cell: 4 },
        rows: p.fasta.map(f => ({ id: f.id, seq: f.seq })) };
    case 'DATASET_BOXPLOT':
      return { ...base, type: 'boxplot', width: num(first(o, 'WIDTH'), 150),
        rows: p.rows.filter(r => r.length >= 6).map(r => ({
          id: r[0], min: num(r[1], 0), q1: num(r[2], 0), median: num(r[3], 0), q3: num(r[4], 0), max: num(r[5], 0),
          extremes: r.slice(6).map(v => num(v, NaN)).filter(isFinite),
        })) };
    case 'DATASET_LINECHART':
      return { ...base, type: 'linechart', width: num(first(o, 'WIDTH'), 150),
        rows: rows.map(r => ({
          id: r[0], points: r.slice(1).map(v => v.split('|').map(x => num(x, NaN))).filter(q => q.length === 2 && q.every(isFinite)),
        })).filter(r => r.points.length) };
    case 'DATASET_CONNECTION':
      return { ...base, type: 'connection', width: 0,
        rows: p.rows.filter(r => r.length >= 2 && r[0] && r[1]).map(r => ({
          id: r[0], to: r[1], width: num(r[2], 1), color: safeColor(r[3], color), dashed: /dash/i.test(r[4] || ''), label: r[5] || '',
        })) };
    case 'DATASET_IMAGE':
      return { ...base, type: 'image', width: num(first(o, 'IMAGE_WIDTH'), 40),
        rows: p.rows.filter(r => r.length >= 7).map(r => ({
          id: r[0], position: num(r[1], -1), size: num(r[2], 1), rotation: num(r[3], 0), dx: num(r[4], 0), dy: num(r[5], 0),
          url: safeUrl(r[6]),
        })).filter(r => r.url) };
    case 'DATASET_EXTERNALSHAPE': {
      const nF = Math.max(fieldLabels.length, 1);
      return { ...base, type: 'shapes', width: nF * 16, opts: { shape: num(first(o, 'SHAPE_TYPE'), 2), filled: first(o, 'COLOR_FILL', '1') !== '0' },
        fields: Array.from({ length: nF }, (_, i) => ({ label: fieldLabels[i] || `Field ${i + 1}`, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, 0)) })) };
    }
    default:
      throw new Error(`${p.type} is not a dataset type`);
  }
}

const LABEL_STYLES = new Set(['normal', 'bold', 'italic', 'bold-italic']);

// Apply tree-level annotation (TREE_COLORS, DATASET_STYLE, LABELS, COLLAPSE) by mutating nodes.
function applyTreeAnnotation(p, index) {
  let applied = 0;
  const missing = [];
  for (const r of p.rows) {
    const node = Tree.resolveSpec(index, r[0]);
    if (!node) { if (r[0]) missing.push(r[0]); continue; }
    applied++;
    if (p.type === 'LABELS') { Tree.setStyle(node, { displayName: r[1] || null }); continue; }
    if (p.type === 'COLLAPSE') { if (node.children.length) node.collapsed = true; continue; }
    if (p.type === 'DATASET_STYLE') {
      const [, what, scope, c, size, style, bg] = r;
      const props = {};
      if ((what || '').toLowerCase() === 'branch') {
        props.branchColor = safeColor(c);
        props.branchWidth = num(size, null);
        if (/dash/i.test(style || '')) props.branchDashed = true;
      } else {
        props.labelColor = safeColor(c);
        props.labelSize = num(size, null);
        if (LABEL_STYLES.has((style || '').toLowerCase())) props.labelStyle = style.toLowerCase();
        if (bg) props.labelBg = safeColor(bg);
      }
      if ((scope || '').toLowerCase() === 'clade') Tree.setCladeStyle(node, props);
      else Tree.setStyle(node, props);
      continue;
    }
    // TREE_COLORS
    const kind = (r[1] || '').toLowerCase();
    const c = safeColor(r[2], null);
    if (kind === 'range') Tree.setStyle(node, { range: c, rangeLabel: r[3] || null });
    else if (kind === 'clade' || kind === 'branch') {
      const props = { branchColor: c, branchWidth: num(r[4], null), branchDashed: /dash/i.test(r[3] || '') || null };
      if (kind === 'clade') Tree.setCladeStyle(node, props); else Tree.setStyle(node, props);
    } else if (kind === 'label') {
      const st = (r[3] || '').toLowerCase();
      Tree.setStyle(node, { labelColor: c, labelStyle: LABEL_STYLES.has(st) ? st : null, labelSize: num(r[4], null) });
    } else if (kind === 'label_background') {
      Tree.setStyle(node, { labelBg: c });
    } else {
      applied--;
    }
  }
  return { applied, missing };
}

// Only http(s) and inline image data URLs are accepted for image datasets.
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);)/i.test(s) && !/["<>\s]/.test(s) ? s : null;
}

// FASTA -> [{id, seq}]; the id is the first word of the header line.
function parseFasta(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l[0] === '>') { cur = { id: l.slice(1).trim().split(/\s+/)[0], seq: '' }; out.push(cur); }
    else if (cur) cur.seq += l.replace(/\s+/g, '').toUpperCase();
  }
  return out;
}

const isFasta = text => /^\s*>\S/.test(String(text).replace(/^\uFEFF/, '')) && !/^\s*>.*\n\s*[(\[]/.test(text);

function datasetFromFasta(text, label = 'Alignment') {
  const rows = parseFasta(text);
  if (!rows.length) throw new Error('No sequences found');
  return { id: newId(), type: 'alignment', label, visible: true, width: 0, opts: { scheme: 'auto', cell: 4 }, rows };
}

const isTreeAnnotation = type => ['TREE_COLORS', 'LABELS', 'COLLAPSE', 'DATASET_STYLE'].includes(type);

const isNumber = v => v !== '' && isFinite(Number(v));

function inferColumnType(values) {
  const vals = values.filter(v => v !== '' && v != null);
  if (!vals.length) return 'text';
  const numeric = vals.filter(isNumber).length / vals.length;
  if (numeric >= 0.9) {
    const uniq = new Set(vals);
    if ([...uniq].every(v => v === '0' || v === '1')) return 'binary';
    return 'simplebar';
  }
  const uniq = new Set(vals).size;
  return uniq <= Math.max(30, vals.length * 0.5) ? 'colorstrip' : 'text';
}

const TRUE = /^(1|yes|y|true|t|\+|present)$/i;
const FALSE = /^(0|no|n|false|f|-|absent)$/i;

// Build datasets from table columns. cols: [{index, type}].
// Types: colorstrip, gradient, simplebar, heatmap, multibar, binary, text, rename.
function datasetsFromTable(table, idCol, cols, palette) {
  const pc = i => paletteColor(i, palette);
  const out = [];
  const rows = table.rows.filter(r => r[idCol]);
  const name = i => table.header[i] || `Column ${i + 1}`;
  const groups = { heatmap: [], multibar: [], binary: [], pie: [] };
  let rename = null;
  for (const c of cols) {
    if (groups[c.type]) { groups[c.type].push(c.index); continue; }
    if (c.type === 'rename') { rename = c.index; continue; }
    const label = name(c.index);
    if (c.type === 'colorstrip') {
      const cats = [...new Set(rows.map(r => r[c.index]).filter(v => v))];
      const colorOf = new Map(cats.map((v, i) => [v, pc(i)]));
      out.push({ id: newId(), type: 'colorstrip', label, visible: true, width: 20,
        rows: rows.filter(r => r[c.index]).map(r => ({ id: r[idCol], color: colorOf.get(r[c.index]), label: r[c.index] })) });
    } else if (c.type === 'gradient') {
      out.push({ id: newId(), type: 'heatmap', label, visible: true, width: 20, fields: [{ label }],
        opts: { stops: RAMPS.Viridis },
        rows: rows.filter(r => isNumber(r[c.index])).map(r => ({ id: r[idCol], values: [Number(r[c.index])] })) });
    } else if (c.type === 'simplebar') {
      out.push({ id: newId(), type: 'simplebar', label, visible: true, width: 120, color: pc(out.length),
        rows: rows.filter(r => isNumber(r[c.index])).map(r => ({ id: r[idCol], value: Number(r[c.index]) })) });
    } else if (c.type === 'text') {
      out.push({ id: newId(), type: 'text', label, visible: true, width: 0,
        rows: rows.filter(r => r[c.index]).map(r => ({ id: r[idCol], label: r[c.index] })) });
    }
  }
  if (groups.heatmap.length) {
    out.push({ id: newId(), type: 'heatmap', label: groups.heatmap.length === 1 ? name(groups.heatmap[0]) : 'Heatmap',
      visible: true, width: groups.heatmap.length * 18, fields: groups.heatmap.map(i => ({ label: name(i) })),
      opts: { stops: RAMPS['Blue-Red'] },
      rows: rows.map(r => ({ id: r[idCol], values: groups.heatmap.map(i => isNumber(r[i]) ? Number(r[i]) : null) })) });
  }
  if (groups.multibar.length) {
    out.push({ id: newId(), type: 'multibar', label: 'Stacked bars', visible: true, width: 150,
      fields: groups.multibar.map((i, k) => ({ label: name(i), color: pc(k) })),
      rows: rows.map(r => ({ id: r[idCol], values: groups.multibar.map(i => isNumber(r[i]) ? Math.max(0, Number(r[i])) : 0) })) });
  }
  if (groups.pie.length) {
    out.push({ id: newId(), type: 'pie', label: 'Pie charts', visible: true, width: 24,
      fields: groups.pie.map((i, k) => ({ label: name(i), color: pc(k) })),
      rows: rows.map(r => ({ id: r[idCol], position: -1, radius: 1, values: groups.pie.map(i => isNumber(r[i]) ? Math.max(0, Number(r[i])) : 0) })) });
  }
  if (groups.binary.length) {
    out.push({ id: newId(), type: 'binary', label: groups.binary.length === 1 ? name(groups.binary[0]) : 'Presence / absence',
      visible: true, width: groups.binary.length * 16,
      fields: groups.binary.map((i, k) => ({ label: name(i), color: pc(k), shape: 2 })),
      rows: rows.map(r => ({ id: r[idCol], values: groups.binary.map(i => TRUE.test(r[i]) ? 1 : FALSE.test(r[i]) ? 0 : -1) })) });
  }
  return { datasets: out, rename: rename == null ? null : rows.map(r => [r[idCol], r[rename]]) };
}

export {
  parseTable, splitCsvLine, isItol, parseItol, datasetFromItol, applyTreeAnnotation, isTreeAnnotation,
  inferColumnType, datasetsFromTable, parseFasta, isFasta, datasetFromFasta, safeUrl, newId,
};
