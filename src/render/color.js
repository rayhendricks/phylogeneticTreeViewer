/* Colors: parsing, perceptual (OKLab) interpolation, categorical palettes and continuous ramps. */

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%+-]+\)|[a-z]{3,20})$/i;

export function safeColor(c, fallback = null) {
  const s = c == null ? '' : String(c).trim();
  return SAFE_COLOR.test(s) ? s : fallback;
}

let probe = null;
const cache = new Map();

// Returns [r, g, b, a] with r,g,b in 0..255 and a in 0..1, or null.
export function parseColor(input) {
  const s = String(input || '').trim().toLowerCase();
  if (cache.has(s)) return cache.get(s);
  let out = null;
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      out = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
      out.push(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
    }
  } else if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    out = p.slice(0, 3).map(v => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)));
    out.push(p[3] != null ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1);
  } else if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
    // Named colors, hsl(), etc.: let the browser normalise them.
    if (!probe) {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      probe = c.getContext('2d');
    }
    probe.fillStyle = '#000';
    probe.fillStyle = s;
    const norm = probe.fillStyle;
    if (norm !== '#000000' || s === 'black') out = norm.startsWith('#') ? parseColor(norm) : parseColor(norm);
  }
  if (out && out.some(v => !isFinite(v))) out = null;
  cache.set(s, out);
  return out;
}

const toHex2 = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
export function toHex([r, g, b]) { return '#' + toHex2(r) + toHex2(g) + toHex2(b); }

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const delin = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    delin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    delin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    delin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

// Piecewise OKLab interpolation through color stops; returns t => '#rrggbb'.
export function ramp(stops) {
  const labs = stops.map(c => rgbToOklab(parseColor(c) || [128, 128, 128]));
  if (labs.length === 1) { const h = toHex(oklabToRgb(labs[0])); return () => h; }
  const n = labs.length - 1;
  return t => {
    const x = Math.max(0, Math.min(1, isFinite(t) ? t : 0)) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i, a = labs[i], b = labs[i + 1];
    return toHex(oklabToRgb([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]));
  };
}

export const PALETTES = {
  'Tableau 10': ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
  'Okabe-Ito (colorblind safe)': ['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#000000'],
  'Set2': ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  'Dark2': ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
  'Paired': ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'],
  'Set3': ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'],
  'Pastel': ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6', '#ffffcc', '#e5d8bd', '#fddaec', '#f2f2f2'],
};

export const RAMPS = {
  Viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  Magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  Inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  Plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  Cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
  'Blue-Red': ['#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b'],
  'Brown-Teal': ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#80cdc1', '#35978f', '#01665e'],
  'Orange-Purple': ['#b35806', '#e08214', '#fdb863', '#fee0b6', '#f7f7f7', '#d8daeb', '#b2abd2', '#8073ac', '#542788'],
  Spectral: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'],
  'Yellow-Green-Blue': ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'],
  Blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  Reds: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
  Greys: ['#f0f0f0', '#d9d9d9', '#bdbdbd', '#969696', '#737373', '#525252', '#252525', '#000000'],
};

export const DEFAULT_PALETTE = PALETTES['Tableau 10'];

// Categorical color i from a palette; extends with golden-angle hues when it runs out.
export function paletteColor(i, palette = DEFAULT_PALETTE) {
  if (i < palette.length) return palette[i];
  return toHex(oklabToRgb([0.68, 0.13 * Math.cos(i * 2.39996), 0.13 * Math.sin(i * 2.39996)]));
}

// Readable text color on a given background.
export function contrastText(bg) {
  const c = parseColor(bg);
  if (!c) return '#000000';
  const L = rgbToOklab(c)[0];
  return L > 0.65 ? '#111111' : '#ffffff';
}

export function withAlpha(c, a) {
  const p = parseColor(c);
  return p ? `rgba(${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${a})` : c;
}
