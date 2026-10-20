/* Residue color schemes for alignments (Jalview-style). '.' marks residues hidden by highlighting. */
import { ramp } from './color.js';

const fill = (groups) => {
  const out = {};
  for (const [chars, color] of groups) for (const c of chars) out[c] = color;
  return out;
};

const NUCLEOTIDE = fill([['A', '#5cb85c'], ['C', '#3d7dd8'], ['G', '#f0a030'], ['TU', '#e05050'], ['N', '#b0b0b0']]);
const CLUSTAL = fill([['AILMFWV', '#80a0f0'], ['KR', '#f01505'], ['ED', '#c048c0'], ['NQST', '#15c015'], ['C', '#f08080'], ['G', '#f09048'], ['P', '#c0c000'], ['HY', '#15a4a4'], ['X', '#b0b0b0']]);
const ZAPPO = fill([['AVLIM', '#ffafaf'], ['FWY', '#ffc800'], ['KRH', '#6464ff'], ['DE', '#ff0000'], ['STNQ', '#00ff00'], ['PG', '#ff00ff'], ['C', '#ffff00']]);
const TAYLOR = fill([['A', '#ccff00'], ['R', '#0000ff'], ['N', '#cc00ff'], ['D', '#ff0000'], ['C', '#ffff00'], ['Q', '#ff00cc'], ['E', '#ff0066'], ['G', '#ff9900'], ['H', '#0066ff'], ['I', '#66ff00'], ['L', '#33ff00'], ['K', '#6600ff'], ['M', '#00ff00'], ['F', '#00ff66'], ['P', '#ffcc00'], ['S', '#ff3300'], ['T', '#ff6600'], ['W', '#00ccff'], ['Y', '#00ffcc'], ['V', '#99ff00']]);
const KD = { I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8, G: -0.4, T: -0.7, S: -0.8, W: -0.9, Y: -1.3, P: -1.6, H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5 };
const kdRamp = ramp(['#2166ac', '#f7f7f7', '#b2182b']);
const HYDROPHOBICITY = Object.fromEntries(Object.entries(KD).map(([k, v]) => [k, kdRamp((v + 4.5) / 9)]));

export const SCHEMES = { nucleotide: NUCLEOTIDE, clustal: CLUSTAL, protein: CLUSTAL, zappo: ZAPPO, taylor: TAYLOR, hydrophobicity: HYDROPHOBICITY };
export const HIDDEN_COLOR = '#e6e6e6';

function looksNucleotide(rows) {
  let nuc = 0, tot = 0;
  for (const s of rows) {
    if (!s) continue;
    for (let i = 0; i < s.length && tot < 5000; i++) {
      const c = s[i];
      if (c === '-' || c === '.') continue;
      tot++;
      if ('ACGTUN'.includes(c)) nuc++;
    }
  }
  return tot > 0 && nuc / tot > 0.9;
}

// scheme: 'auto' | a SCHEMES name | a custom {residue: color} map.
export function resolveScheme(scheme, rows) {
  let map;
  if (scheme && typeof scheme === 'object') map = scheme;
  else if (SCHEMES[scheme]) map = SCHEMES[scheme];
  else map = looksNucleotide(rows) ? NUCLEOTIDE : CLUSTAL;
  return { ...map, '.': HIDDEN_COLOR };
}

// Column consensus and conservation (fraction of the most common residue).
export function consensus(rows, thresholdPct = 50, ignoreGaps = false) {
  const len = rows.reduce((m, s) => Math.max(m, s ? s.length : 0), 0);
  let cons = '';
  const cons_ = new Array(len);
  for (let i = 0; i < len; i++) {
    const counts = new Map();
    let tot = 0;
    for (const s of rows) {
      if (!s) continue;
      const c = s[i] || '-';
      if (ignoreGaps && (c === '-' || c === '.')) continue;
      counts.set(c, (counts.get(c) || 0) + 1);
      tot++;
    }
    let best = '-', bc = 0;
    for (const [c, k] of counts) if (k > bc && c !== '.') { best = c; bc = k; }
    const frac = tot ? bc / tot : 0;
    cons += frac * 100 >= thresholdPct ? best : '-';
    cons_[i] = frac;
  }
  return { consensus: cons, conservation: cons_ };
}
