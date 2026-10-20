/* Small shared helpers for the renderers. */
import { safeColor } from './color.js';
export const fmtNum = v => {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : String(+v.toPrecision(4));
};
export const maxOf = (arr, init = -Infinity) => arr.reduce((m, v) => (v > m ? v : m), init);
export const minOf = (arr, init = Infinity) => arr.reduce((m, v) => (v < m ? v : m), init);

// iTOL text tags: <b>bold</b><i>italic</i><sup size='0.5' color='red'>x</sup> ... -> runs, or null.
const TAG_RE = /<(n|b|i|bi|sub|sup)((?:\s+\w+\s*=\s*(?:'[^']*'|"[^"]*"))*)\s*>([\s\S]*?)<\/\1>/g;
export function parseTags(text) {
  if (!/<(n|b|i|bi|sub|sup)[\s>]/.test(text)) return null;
  const runs = [];
  for (const m of String(text).matchAll(TAG_RE)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)\s*=\s*['"]([^'"]*)['"]/g)].map(a => [a[1].toLowerCase(), a[2]]));
    runs.push({
      text: m[3], bold: m[1] === 'b' || m[1] === 'bi', italic: m[1] === 'i' || m[1] === 'bi',
      position: m[1] === 'sub' ? 'subscript' : m[1] === 'sup' ? 'superscript' : 'normal',
      color: safeColor(attrs.color, null), sizeFactor: parseFloat(attrs.size) || 1, font: attrs.font || null,
    });
  }
  return runs.length ? runs : null;
}

