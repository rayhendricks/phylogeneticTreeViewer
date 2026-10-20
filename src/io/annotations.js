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
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !/^#/.test(l));
  if (!lines.length) throw new Error('Table is empty');
  const sep = detectSeparator(lines[0]);
  const rows = lines.map(l => splitBy(l, sep).map(v => v.trim()));
  return { header: rows[0], rows: rows.slice(1), sep };
}

const DATASET_TYPES = [
  'DATASET_COLORSTRIP', 'DATASET_SIMPLEBAR', 'DATASET_MULTIBAR', 'DATASET_HEATMAP', 'DATASET_BINARY',
  'DATASET_TEXT', 'DATASET_SYMBOL', 'DATASET_GRADIENT', 'DATASET_PIECHART', 'DATASET_DOMAINS', 'DATASET_ALIGNMENT',
  'DATASET_BOXPLOT', 'DATASET_LINECHART', 'DATASET_CONNECTION', 'DATASET_IMAGE', 'DATASET_EXTERNALSHAPE',
  'DATASET_RANGE', 'DATASET_ARROWS', 'DATASET_TIMESCALE', 'DATASET_TANGLEGRAM',
];
const TREE_TYPES = [
  'TREE_COLORS', 'LABELS', 'COLLAPSE', 'DATASET_STYLE', 'METADATA', 'POPUP_INFO', 'SPACING', 'PRUNE', 'MULTI_STYLE', 'AUTO_TAXONOMY',
];
const ITOL_TYPES = [...DATASET_TYPES, ...TREE_TYPES];

function isItol(text) {
  const first = String(text).replace(/^﻿/, '').split(/\r?\n/).find(l => l.trim() && !/^#/.test(l.trim()));
  if (!first) return false;
  const tok = first.trim().split(/[\t, ]/)[0].toUpperCase();
  return ITOL_TYPES.includes(tok);
}

// Returns { type, opts, all, rows, fasta?, tree? }.
// opts[KEY] holds the values of the last KEY line; all[KEY] holds every occurrence (for repeatable keys).
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
  // A tanglegram tree spans several lines between TANGLEGRAM_TREE and END_TANGLEGRAM_TREE.
  let tree = null;
  const rest = [];
  for (let i = k + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^TANGLEGRAM_TREE\b/i.test(t)) {
      const buf = [t.replace(/^TANGLEGRAM_TREE[\t, ]*/i, '')];
      while (++i < lines.length && !/^END_TANGLEGRAM_TREE\b/i.test(lines[i].trim())) buf.push(lines[i].trim());
      tree = buf.join('');
      continue;
    }
    rest.push(lines[i]);
  }
  const body = rest.filter(l => l.trim() && !/^#/.test(l.trim()) && !/^SEPARATOR\b/i.test(l.trim()));
  if (!sep) sep = body.some(l => l.includes('\t')) ? '\t' : ',';
  const opts = {}, all = {}, rows = [];
  const dataAt = body.findIndex(l => /^DATA\s*$/i.test(l.trim()));
  const header = l => {
    const parts = splitBy(l, sep).map(v => v.trim());
    const key = parts[0].toUpperCase();
    opts[key] = parts.slice(1);
    (all[key] || (all[key] = [])).push(parts.slice(1));
  };
  if (type === 'DATASET_ALIGNMENT') {
    body.slice(0, Math.max(0, dataAt)).forEach(header);
    return { type, sep, opts, all, rows: [], fasta: parseFasta(body.slice(dataAt + 1).join('\n')) };
  }
  body.forEach((l, i) => {
    if (i === dataAt) return;
    if (dataAt >= 0 && i < dataAt) header(l);
    else rows.push(splitBy(l, sep).map(v => v.trim()));
  });
  return { type, sep, opts, all, rows, tree };
}

const first = (o, key, def) => (o[key] && o[key].length && o[key][0] !== '') ? o[key][0] : def;
const num = (v, def) => { const x = parseFloat(String(v).replace(/^&minus;/, '-')); return isFinite(x) ? x : def; };
const flag = (o, key, def = false) => { const v = first(o, key, null); return v == null ? def : v === '1' || /^(true|yes)$/i.test(v); };

let dsCounter = 0;
const newId = () => 'ds' + Date.now().toString(36) + (dsCounter++);

// iTOL legend shapes: 1-6 symbols, 7-9 lines, 10-12 arrows, or any protein domain code (e.g. OC).
function legendShape(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : String(v || '1').toUpperCase();
}

function customLegend(o) {
  if (!o.LEGEND_LABELS || !o.LEGEND_COLORS) return null;
  return {
    title: first(o, 'LEGEND_TITLE', ''),
    visible: first(o, 'LEGEND_VISIBLE', '1') !== '0',
    horizontal: flag(o, 'LEGEND_HORIZONTAL'),
    scale: num(first(o, 'LEGEND_SCALE'), 1),
    items: o.LEGEND_LABELS.map((label, i) => ({
      label, color: safeColor(o.LEGEND_COLORS[i], '#888'), shape: legendShape(o.LEGEND_SHAPES && o.LEGEND_SHAPES[i]),
      scale: num(o.LEGEND_SHAPE_SCALES && o.LEGEND_SHAPE_SCALES[i], 1),
      invert: (o.LEGEND_SHAPE_INVERT && o.LEGEND_SHAPE_INVERT[i]) === '1',
    })),
  };
}

// DATASET_SCALE: "100,200" or "100-label-#color-width-dashed-labelScale".
function datasetScale(o) {
  if (!o.DATASET_SCALE) return null;
  return o.DATASET_SCALE.filter(Boolean).map(def => {
    const [v, label, color, width, dashed, ls] = def.replace(/&minus;/g, '−').split('-').map(x => x.replace('−', '-'));
    return { value: num(v, 0), label: label || null, color: safeColor(color, null), width: num(width, 1), dashed: dashed === '1', labelScale: num(ls, 1) };
  });
}

// Options shared by most datasets, normalised; the raw header is kept in ds.itol for anything else.
function commonOpts(o) {
  return {
    margin: num(first(o, 'MARGIN'), 0),
    scale: datasetScale(o),
    showInternal: flag(o, 'SHOW_INTERNAL'),
    borderWidth: num(first(o, 'BORDER_WIDTH'), 0),
    borderColor: safeColor(first(o, 'BORDER_COLOR'), '#000000'),
    heightFactor: num(first(o, 'HEIGHT_FACTOR'), 1),
    barShift: num(first(o, 'BAR_SHIFT'), 0),
    logScale: flag(o, 'LOG_SCALE'),
    showValue: flag(o, 'SHOW_VALUE') || flag(o, 'SHOW_VALUES'),
    labelPosition: first(o, 'LABEL_POSITION', 'outside-right'),
    labelColor: safeColor(first(o, 'BAR_LABEL_COLOR') || first(o, 'VALUE_COLOR'), null),
    labelAutoColor: flag(o, 'LABEL_AUTO_COLOR') || flag(o, 'VALUE_AUTO_COLOR'),
    labelSizeFactor: num(first(o, 'LABEL_SIZE_FACTOR') || first(o, 'VALUE_SIZE_FACTOR'), 1),
    horizontalGrid: flag(o, 'HORIZONTAL_GRID'),
    verticalGrid: flag(o, 'VERTICAL_GRID'),
    gridColor: safeColor(first(o, 'GRID_COLOR'), '#dddddd'),
    gridWidth: num(first(o, 'GRID_WIDTH'), 1),
    dashedLines: flag(o, 'DASHED_LINES', true),
  };
}

const LINE_STYLE = s => (/dot/i.test(s || '') ? 'dotted' : /dash/i.test(s || '') ? 'dashed' : 'normal');

function datasetFromItol(p) {
  const o = p.opts;
  const label = first(o, 'DATASET_LABEL', p.type.replace('DATASET_', '').toLowerCase());
  const color = safeColor(first(o, 'COLOR'), '#4e79a7');
  const fieldLabels = o.FIELD_LABELS || [];
  const fieldColors = o.FIELD_COLORS || [];
  const base = { id: newId(), label, visible: true, color, legend: customLegend(o), itol: o, common: commonOpts(o) };
  const rows = p.rows.filter(r => r.length >= 2 && r[0]);
  switch (p.type) {
    case 'DATASET_COLORSTRIP':
      return { ...base, type: 'colorstrip', width: num(first(o, 'STRIP_WIDTH'), 20),
        opts: {
          colorBranches: flag(o, 'COLOR_BRANCHES'), showLabels: flag(o, 'SHOW_STRIP_LABELS'),
          labelColor: safeColor(first(o, 'STRIP_LABEL_COLOR'), null), labelAuto: flag(o, 'STRIP_LABEL_AUTO_COLOR', true),
          labelSize: num(first(o, 'STRIP_LABEL_SIZE_FACTOR'), 1), labelRotation: num(first(o, 'STRIP_LABEL_ROTATION'), 0),
          completeBorder: flag(o, 'COMPLETE_BORDER'),
        },
        rows: rows.map(r => ({ id: r[0], color: safeColor(r[1], '#cccccc'), label: r[2] || '' })) };
    case 'DATASET_SIMPLEBAR':
      return { ...base, type: 'simplebar', width: num(first(o, 'WIDTH'), 120),
        opts: { barZero: num(first(o, 'BAR_ZERO'), 0) },
        rows: rows.map(r => ({ id: r[0], value: num(r[1], NaN), label: r[2] || '' })).filter(r => isFinite(r.value)) };
    case 'DATASET_MULTIBAR':
      return { ...base, type: 'multibar', width: num(first(o, 'WIDTH'), 150),
        opts: { alignFields: flag(o, 'ALIGN_FIELDS'), sideStacked: flag(o, 'SIDE_STACKED'), onBranch: flag(o, 'ON_BRANCH') },
        fields: fieldLabels.map((l, i) => ({ label: l, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, 0)) })) };
    case 'DATASET_GRADIENT':
    case 'DATASET_HEATMAP': {
      const fields = p.type === 'DATASET_GRADIENT' ? [{ label }] : fieldLabels.map(l => ({ label: l }));
      const useMid = flag(o, 'USE_MID_COLOR') || (p.type === 'DATASET_HEATMAP' && !!o.COLOR_MID && !o.USE_MID_COLOR);
      return { ...base, type: 'heatmap', fields,
        width: Math.max(1, fields.length) * num(first(o, 'STRIP_WIDTH'), 18),
        opts: {
          stops: [safeColor(first(o, 'COLOR_MIN'), '#deebf7'), useMid ? safeColor(first(o, 'COLOR_MID'), null) : null,
            safeColor(first(o, 'COLOR_MAX'), '#08306b')].filter(Boolean),
          min: num(first(o, 'USER_MIN_VALUE'), null), max: num(first(o, 'USER_MAX_VALUE'), null),
          nanColor: safeColor(first(o, 'COLOR_NAN'), null),
          normalize: (first(o, 'DATA_NORMALIZATION', '') || '').toLowerCase() || null,
          normType: (first(o, 'NORMALIZATION_TYPE', 'normal') || 'normal').toLowerCase(),
          normRange: o.NORMALIZATION_RANGE ? o.NORMALIZATION_RANGE.map(v => num(v, 0)) : null,
          displayValues: (first(o, 'DISPLAY_VALUES', '') || '').toLowerCase() || null,
          roundValues: num(first(o, 'ROUND_VALUES'), null), sci: flag(o, 'VALUES_SCI_NOTATION'),
          fieldTree: first(o, 'FIELD_TREE', null),
        },
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, null)) })) };
    }
    case 'DATASET_BINARY': {
      const shapes = o.FIELD_SHAPES || [];
      const nF = Math.max(fieldLabels.length, shapes.length, 1);
      const fields = Array.from({ length: nF }, (_, i) => ({
        label: fieldLabels[i] || `Field ${i + 1}`, color: safeColor(fieldColors[i], paletteColor(i)), shape: num(shapes[i], 2),
      }));
      return { ...base, type: 'binary', fields, width: nF * Math.max(10, num(first(o, 'SYMBOL_SPACING'), 16)),
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, -1)) })) };
    }
    case 'DATASET_TEXT':
      return { ...base, type: 'text', width: 0,
        opts: { alignToTree: flag(o, 'ALIGN_TO_TREE'), sizeFactor: num(first(o, 'SIZE_FACTOR'), 1), straight: flag(o, 'STRAIGHT_LABELS'), below: flag(o, 'LABELS_BELOW') },
        rows: rows.map(r => ({ id: r[0], label: r[1] || '', position: num(r[2], -1), color: safeColor(r[3], null), style: r[4] || 'normal', size: num(r[5], 1), rotation: num(r[6], 0) })) };
    case 'DATASET_SYMBOL':
      return { ...base, type: 'symbol', width: 0, maxSize: num(first(o, 'MAXIMUM_SIZE'), 10),
        opts: { gradient: flag(o, 'GRADIENT_FILL') },
        rows: p.rows.filter(r => r.length >= 5).map(r => ({
          id: r[0], shape: legendShape(r[1]), size: num(r[2], 5), color: safeColor(r[3], '#888'),
          filled: r[4] !== '0', position: num(r[5], 1), label: r[6] || '',
        })) };
    case 'DATASET_PIECHART':
      return { ...base, type: 'pie', width: num(first(o, 'MAXIMUM_SIZE'), 20) * 2,
        opts: { polar: flag(o, 'POLAR_AREA_DIAGRAM') },
        fields: fieldLabels.map((l, i) => ({ label: l, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: p.rows.filter(r => r.length >= 4).map(r => ({
          id: r[0], position: num(r[1], -1), radius: num(r[2], 10), values: r.slice(3).map(v => Math.max(0, num(v, 0))),
        })) };
    case 'DATASET_DOMAINS':
      return { ...base, type: 'domains', width: num(first(o, 'WIDTH'), 200),
        opts: {
          backbone: safeColor(first(o, 'BACKBONE_COLOR'), '#aaaaaa'), backboneHeight: num(first(o, 'BACKBONE_HEIGHT'), 2),
          showLabels: first(o, 'SHOW_DOMAIN_LABELS', '1') !== '0', gradient: flag(o, 'GRADIENT_FILL'),
        },
        rows: rows.map(r => ({
          id: r[0], length: num(r[1], 0),
          domains: r.slice(2).map(d => d.split('|')).filter(d => d.length >= 3).map(d => ({
            shape: (d[0] || 'RE').toUpperCase(), start: num(d[1], 0), end: num(d[2], 0),
            color: safeColor(d[3], '#888888'), label: d[4] || '',
          })),
        })).filter(r => r.length > 0) };
    case 'DATASET_ARROWS':
      return { ...base, type: 'arrows', width: num(first(o, 'WIDTH'), 250),
        opts: {
          backbone: safeColor(first(o, 'BACKBONE_COLOR'), '#aaaaaa'), backboneHeight: num(first(o, 'BACKBONE_HEIGHT'), 2),
          showLabels: first(o, 'SHOW_ARROW_LABELS', '1') !== '0', labelsOnTop: flag(o, 'LABELS_ON_TOP'),
        },
        rows: rows.map(r => ({
          id: r[0], length: num(r[1], 0),
          arrows: r.slice(2).map(d => d.split('|')).filter(d => d.length >= 2).map(d => ({
            start: num(d[0], 0), end: num(d[1], 0), c0: safeColor(d[2], color), c1: safeColor(d[3] || d[2], color),
            label: (d[4] || '').trim(), labelColor: safeColor(d[5], '#000000'), hf: num(d[6], 1), bhf: num(d[7], 1),
            headL: num(d[8], 0), headR: num(d[9], 0),
            marks: d.slice(10).reduce((acc, v, j, arr) => (j % 3 === 0 && arr[j + 2] ? acc.concat({ start: num(arr[j], 0), end: num(arr[j + 1], 0), color: safeColor(arr[j + 2], '#000') }) : acc), []),
          })),
        })).filter(r => r.length > 0) };
    case 'DATASET_ALIGNMENT': {
      const schemes = {};
      for (const def of (p.all.CUSTOM_COLOR_SCHEME || [])) {
        const [name, ...pairs] = def;
        schemes[name] = Object.fromEntries(pairs.map(x => x.split('=')).filter(x => x.length === 2).map(([a, c]) => [a.toUpperCase(), safeColor(c, '#888')]));
      }
      const scheme = (first(o, 'COLOR_SCHEME', '') || '').trim();
      return { ...base, type: 'alignment', width: 0,
        opts: {
          scheme: scheme ? (schemes[scheme] ? scheme : scheme.toLowerCase()) : 'auto', cell: 4, customSchemes: schemes,
          start: num(first(o, 'START_POSITION'), null), end: num(first(o, 'END_POSITION'), null),
          consensus: flag(o, 'DISPLAY_CONSENSUS'), conservation: flag(o, 'DISPLAY_CONSERVATION'),
          threshold: num(first(o, 'CONSENSUS_THRESHOLD'), 50), ignoreGaps: flag(o, 'IGNORE_GAPS'),
          highlight: (first(o, 'HIGHLIGHT_TYPE', '') || '').toLowerCase() || null, disagreements: flag(o, 'HIGHLIGHT_DISAGREEMENTS'),
          references: o.HIGHLIGHT_REFERENCES || [], markReferences: flag(o, 'MARK_REFERENCES'),
          refBorder: safeColor(first(o, 'REFERENCE_BOX_BORDER_COLOR'), '#000000'), refFill: safeColor(first(o, 'REFERENCE_BOX_FILL_COLOR'), null),
        },
        rows: p.fasta.map(f => ({ id: f.id, seq: f.seq })) };
    }
    case 'DATASET_BOXPLOT':
      return { ...base, type: 'boxplot', width: num(first(o, 'WIDTH'), 150),
        rows: p.rows.filter(r => r.length >= 6).map(r => ({
          id: r[0], min: num(r[1], 0), q1: num(r[2], 0), median: num(r[3], 0), q3: num(r[4], 0), max: num(r[5], 0),
          extremes: r.slice(6).map(v => num(v, NaN)).filter(isFinite),
        })) };
    case 'DATASET_LINECHART': {
      const axis = k => (o[k] ? o[k].join(' ').split(/\s+/).filter(Boolean).map(v => num(v, NaN)).filter(isFinite) : []);
      return { ...base, type: 'linechart', width: num(first(o, 'WIDTH'), 150),
        opts: {
          dots: first(o, 'SHOW_DOTS', '1') !== '0', line: first(o, 'SHOW_LINE', '1') !== '0',
          dotSize: num(first(o, 'DOT_SIZE'), 2), lineWidth: num(first(o, 'LINE_WIDTH'), 1),
          dotColor: safeColor(first(o, 'DEFAULT_DOT_COLOR'), null), lineColor: safeColor(first(o, 'DEFAULT_LINE_COLOR'), null),
          axisX: axis('AXIS_X'), axisY: axis('AXIS_Y'),
          lineColors: o.LINE_COLORS ? o.LINE_COLORS.join(' ').split(/\s+/).map(x => x.split('|')).filter(x => x.length === 2).map(([v, c]) => ({ value: num(v, 0), color: safeColor(c, '#000') })).sort((a, b) => a.value - b.value) : null,
        },
        rows: rows.map(r => ({
          id: r[0], points: r.slice(1).join(' ').split(/\s+/).map(v => v.split('|').map(x => num(x, NaN))).filter(q => q.length === 2 && q.every(isFinite)),
        })).filter(r => r.points.length) };
    }
    case 'DATASET_CONNECTION':
      return { ...base, type: 'connection', width: 0,
        opts: {
          arrows: flag(o, 'DRAW_ARROWS'), arrowSize: num(first(o, 'ARROW_SIZE'), 20), curve: num(first(o, 'CURVE_ANGLE'), 0),
          centerCurves: flag(o, 'CENTER_CURVES'), alignToLabels: flag(o, 'ALIGN_TO_LABELS'), loopSize: num(first(o, 'LOOP_SIZE'), 100),
          maxWidth: num(first(o, 'MAXIMUM_LINE_WIDTH'), 10),
        },
        rows: p.rows.filter(r => r.length >= 2 && r[0] && r[1]).map(r => ({
          id: r[0], to: r[1], width: num(r[2], 1), color: safeColor(r[3], color), style: LINE_STYLE(r[4]), dashed: /dash|dot/i.test(r[4] || ''), label: r[5] || '',
        })) };
    case 'DATASET_IMAGE':
      return { ...base, type: 'image', width: num(first(o, 'IMAGE_WIDTH'), 40),
        rows: p.rows.filter(r => r.length >= 7).map(r => ({
          id: r[0], position: num(r[1], -1), size: num(r[2], 1), rotation: num(r[3], 0), dx: num(r[4], 0), dy: num(r[5], 0),
          url: safeUrl(r[6]),
        })).filter(r => r.url) };
    case 'DATASET_EXTERNALSHAPE': {
      const nF = Math.max(fieldLabels.length, 1);
      return { ...base, type: 'shapes', width: nF * Math.max(10, num(first(o, 'SHAPE_SPACING'), 16)),
        opts: { shape: num(first(o, 'SHAPE_TYPE'), 2), filled: first(o, 'COLOR_FILL', '1') !== '0' },
        fields: Array.from({ length: nF }, (_, i) => ({ label: fieldLabels[i] || `Field ${i + 1}`, color: safeColor(fieldColors[i], paletteColor(i)) })),
        rows: rows.map(r => ({ id: r[0], values: r.slice(1).map(v => num(v, 0)) })) };
    }
    case 'DATASET_RANGE':
      return { ...base, type: 'range', width: 0,
        opts: {
          rangeType: (first(o, 'RANGE_TYPE', 'box') || 'box').toLowerCase(), cover: (first(o, 'RANGE_COVER', 'clade') || 'clade').toLowerCase(),
          coverLabels: flag(o, 'COVER_LABELS'), coverDatasets: flag(o, 'COVER_DATASETS'),
          bracketStyle: (first(o, 'BRACKET_STYLE', 'square') || 'square').toLowerCase(), bracketSize: num(first(o, 'BRACKET_SIZE'), 20),
          bracketShift: num(first(o, 'BRACKET_SHIFT'), 50), showLabels: first(o, 'SHOW_LABELS', '1') !== '0',
          labelPosition: (first(o, 'LABEL_POSITION', 'center-center') || '').toLowerCase(), labelSize: num(first(o, 'LABEL_SIZE_FACTOR'), 1),
          labelsVertical: flag(o, 'LABELS_VERTICAL'),
        },
        rows: p.rows.filter(r => r.length >= 2 && r[0]).map(r => ({
          id: r[0], to: r[1] || r[0], fill: safeColor(r[2], null), gradient: safeColor(r[3], null), line: safeColor(r[4], null),
          lineStyle: LINE_STYLE(r[5]), lineWidth: num(r[6], 1), label: r[7] || '', labelColor: safeColor(r[8], '#000000'),
          labelSize: num(r[9], 1), labelStyle: (r[10] || 'normal').toLowerCase(),
        })) };
    case 'DATASET_TIMESCALE':
      return { ...base, type: 'timescale', width: 0,
        opts: {
          scaling: num(first(o, 'SCALING_FACTOR'), 1), autoScale: flag(o, 'AUTO_SCALE'), above: flag(o, 'POSITION_ABOVE'),
          coverTree: flag(o, 'COVER_TREE'), showValues: first(o, 'SHOW_VALUE_LABELS', '1') !== '0', showRanges: first(o, 'SHOW_RANGES', '1') !== '0',
          showRangeLabels: first(o, 'SHOW_RANGE_LABELS', '1') !== '0', rangeLabelSize: num(first(o, 'RANGE_LABEL_SIZE'), 12),
          height: 24 * num(first(o, 'SIZE_FACTOR'), 1),
        },
        rows: p.rows.filter(r => r.length >= 2 && isFinite(num(r[0], NaN))).map(r => ({
          id: null, start: num(r[0], 0), end: num(r[1], 0), fill: safeColor(r[2], '#cccccc'), gradient: safeColor(r[3], null),
          label: r[4] || '', style: (r[5] || 'normal').toLowerCase(),
        })) };
    case 'DATASET_TANGLEGRAM':
      if (!p.tree) throw new Error('Tanglegram file has no TANGLEGRAM_TREE');
      return { ...base, type: 'tanglegram', width: 0,
        opts: {
          tree: p.tree, connColor: safeColor(first(o, 'DEFAULT_CONNECTION_COLOR'), '#999999'),
          connStyle: LINE_STYLE(first(o, 'DEFAULT_CONNECTION_STYLE')), connWidth: num(first(o, 'DEFAULT_CONNECTION_WIDTH'), 1),
          maxWidth: num(first(o, 'MAXIMUM_LINE_WIDTH'), 3), gap: num(first(o, 'TANGLEGRAM_EXTERNAL_MARGIN'), 50) + 150,
          showLabels: first(o, 'SHOW_LABELS', '1') !== '0',
        },
        rows: p.rows.filter(r => r.length >= 3).map(r => ({ kind: r[0].toLowerCase(), id: r[1], fields: r.slice(2) })) };
    default:
      throw new Error(`${p.type} is not a dataset type`);
  }
}

const LABEL_STYLES = new Set(['normal', 'bold', 'italic', 'bold-italic']);

// Apply tree-level annotations by mutating nodes. Returns
// { applied, missing, prune?: Set<node>, multiStyle?: rules, taxonomy?: [[nodeName, taxid]] }.
function applyTreeAnnotation(p, index) {
  let applied = 0;
  const missing = [];
  const out = { applied: 0, missing };
  if (p.type === 'MULTI_STYLE') {
    const o = p.opts;
    const sepKey = (first(o, 'LABEL_SEPARATOR', 'SPACE') || 'SPACE').toUpperCase();
    out.multiStyle = {
      separator: sepKey === 'SPACE' ? ' ' : sepKey === 'COMMA' ? ',' : sepKey === 'TAB' ? '\t' : sepKey,
      partsRequired: num(first(o, 'PARTS_REQUIRED'), null), include: first(o, 'INCLUDE_ONLY', null), exclude: first(o, 'EXCLUDE_LABELS', null),
      parts: Object.fromEntries(p.rows.filter(r => isFinite(num(r[0], NaN))).map(r => [num(r[0], 1), {
        style: (r[1] || 'normal').toLowerCase(), position: (r[2] || 'normal').toLowerCase(), color: safeColor(r[3], null),
        size: num(r[4], 1), dx: num(r[5], 0), dy: num(r[6], 0), font: r[7] && r[7] !== 'default' ? r[7] : null,
      }])),
    };
    out.applied = p.rows.length;
    return out;
  }
  if (p.type === 'AUTO_TAXONOMY') {
    out.taxonomy = p.rows.filter(r => r[0] && /^\d+$/.test(r[1] || '')).map(r => [r[0], r[1]]);
    out.labelFormat = first(p.opts, 'LABEL_FORMAT', null);
    out.applied = out.taxonomy.length;
    return out;
  }
  if (p.type === 'PRUNE') out.prune = new Set();
  const fieldLabels = p.opts.FIELD_LABELS || [];
  for (const r of p.rows) {
    const nodes = Tree.resolveSpecs(index, r[0]);
    if (!nodes.length) { if (r[0]) missing.push(r[0]); continue; }
    for (const node of nodes) {
      applied++;
      switch (p.type) {
        case 'LABELS':
          Tree.setStyle(node, { displayName: r[1] || null, nodeClass: r[2] || null });
          break;
        case 'COLLAPSE':
          if (node.children.length) node.collapsed = true;
          break;
        case 'PRUNE':
          for (const l of Tree.leaves(node)) out.prune.add(l);
          break;
        case 'SPACING':
          for (const l of node.children.length ? Tree.leaves(node) : [node]) Tree.setStyle(l, { spacing: Math.max(0.05, num(r[1], 1)) });
          break;
        case 'POPUP_INFO':
          Tree.setStyle(node, { popupTitle: r[1] || null, popupHtml: r.slice(2).join(p.sep || ',') || null });
          break;
        case 'METADATA': {
          const attrs = { ...(node.attrs || {}) };
          r.slice(1).forEach((v, j) => { if (v !== '') attrs[fieldLabels[j] || `field${j + 1}`] = v; });
          node.attrs = attrs;
          break;
        }
        case 'DATASET_STYLE': {
          const [, what, scope, c, size, style, bg] = r;
          const props = {};
          if ((what || '').toLowerCase() === 'branch') {
            props.branchColor = safeColor(c);
            props.branchWidth = num(size, null);
            if (/dash|dot/i.test(style || '')) props.branchDashed = true;
          } else {
            props.labelColor = safeColor(c);
            props.labelSize = num(size, null);
            if (LABEL_STYLES.has((style || '').toLowerCase())) props.labelStyle = style.toLowerCase();
            if (bg) props.labelBg = safeColor(bg);
          }
          if ((scope || '').toLowerCase() === 'clade') Tree.setCladeStyle(node, props);
          else Tree.setStyle(node, props);
          break;
        }
        default: { // TREE_COLORS
          const kind = (r[1] || '').toLowerCase();
          const c = safeColor(r[2], null);
          if (kind === 'range') Tree.setStyle(node, { range: c, rangeLabel: r[3] || null });
          else if (kind === 'clade' || kind === 'branch') {
            const props = { branchColor: c, branchWidth: num(r[4], null), branchDashed: /dash|dot/i.test(r[3] || '') || null };
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
      }
    }
  }
  out.applied = applied;
  return out;
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

const isFasta = text => /^\s*>\S/.test(String(text).replace(/^﻿/, '')) && !/^\s*>.*\n\s*[(\[]/.test(text);

function datasetFromFasta(text, label = 'Alignment') {
  const rows = parseFasta(text);
  if (!rows.length) throw new Error('No sequences found');
  return { id: newId(), type: 'alignment', label, visible: true, width: 0, opts: { scheme: 'auto', cell: 4 }, rows };
}

// Minimal XML attribute reader (works without a DOM, so the command line can use it too).
const xmlAttrs = s => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));

// MEME suite XML -> protein-domains style dataset of motif sites.
function isMemeXml(text) { return /<MEME\b/i.test(String(text).slice(0, 2000)) && /<scanned_sites_summary\b|<motifs\b/i.test(text); }
function datasetFromMeme(text, label = 'MEME motifs') {
  const seqs = new Map();
  for (const m of text.matchAll(/<sequence\s([^>]*)\/?>/g)) {
    const a = xmlAttrs(m[1]);
    if (a.id) seqs.set(a.id, { name: a.name || a.id, length: num(a.length, 0) });
  }
  const motifs = [...text.matchAll(/<motif\s([^>]*)>/g)].map(m => xmlAttrs(m[1])).filter(a => a.id);
  const motifInfo = new Map(motifs.map((a, i) => [a.id, { name: a.alt || a.name || a.id, width: num(a.width, 10), color: paletteColor(i) }]));
  const rows = [];
  for (const m of text.matchAll(/<scanned_sites\s([^>]*)>([\s\S]*?)<\/scanned_sites>/g)) {
    const a = xmlAttrs(m[1]);
    const seq = seqs.get(a.sequence_id);
    if (!seq) continue;
    const domains = [...m[2].matchAll(/<scanned_site\s([^>]*)\/?>/g)].map(x => xmlAttrs(x[1])).map(s => {
      const mi = motifInfo.get(s.motif_id) || { name: s.motif_id, width: 10, color: '#888' };
      const start = num(s.position, 0);
      return { shape: s.strand === 'minus' ? 'TL' : 'RE', start, end: start + mi.width, color: mi.color, label: mi.name };
    });
    rows.push({ id: seq.name, length: seq.length || Math.max(0, ...domains.map(d => d.end)), domains });
  }
  if (!rows.length) throw new Error('No motif sites found in MEME XML');
  return { id: newId(), type: 'domains', label, visible: true, color: '#4e79a7', width: 220, legend: null, autoColor: true,
    opts: { backbone: '#aaaaaa', backboneHeight: 2, showLabels: true }, rows };
}

const isTreeAnnotation = type => TREE_TYPES.includes(type);

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
// Datasets built here are marked autoColor so a later change of the global palette recolors them.
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
  return { datasets: out.map(d => ({ ...d, autoColor: true })), rename: rename == null ? null : rows.map(r => [r[idCol], r[rename]]) };
}

export {
  parseTable, splitCsvLine, isItol, parseItol, datasetFromItol, applyTreeAnnotation, isTreeAnnotation,
  inferColumnType, datasetsFromTable, parseFasta, isFasta, datasetFromFasta, safeUrl, newId, isMemeXml, datasetFromMeme,
  ITOL_TYPES,
};
