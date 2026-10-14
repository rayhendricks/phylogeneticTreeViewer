/* Text width estimates without a browser, from Helvetica/Arial advance widths (units per 1000 em). */

// Printable ASCII 32..126.
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

export function measureText(text, size, bold, italic, font) {
  const mono = /mono|courier/i.test(font || '');
  let u = 0;
  for (const ch of String(text)) {
    if (mono) { u += 600; continue; }
    const c = ch.codePointAt(0);
    u += c >= 32 && c <= 126 ? W[c - 32] : 556;
  }
  return u / 1000 * size * (bold ? 1.06 : 1) * (/times|georgia|serif/i.test(font || '') && !/sans/i.test(font || '') ? 0.92 : 1);
}
