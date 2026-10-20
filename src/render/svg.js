/* Scene -> standalone SVG document (for vector export). */
import { alignmentBitmap, schemeFor } from './canvas.js';

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = v => Math.round(v * 100) / 100;

function bitmapDataUrl(bmp) {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c.toDataURL('image/png');
}

// Alignments as runs of same-colored residues (used without a canvas, or with uneven row spacing).
function alignmentVector(p) {
  const scheme = schemeFor(p);
  const cw = p.w / p.len, rh = p.rowH;
  const byColor = new Map();
  p.rows.forEach((s, r) => {
    if (!s) return;
    const y = p.ys[r] - rh / 2;
    let i = 0;
    while (i < s.length) {
      const col = scheme[s[i]];
      let j = i + 1;
      while (j < s.length && scheme[s[j]] === col) j++;
      if (col) {
        if (!byColor.has(col)) byColor.set(col, []);
        byColor.get(col).push(`M${n2(p.x + i * cw)},${n2(y)}h${n2((j - i) * cw)}v${n2(rh)}h${n2(-(j - i) * cw)}Z`);
      }
      i = j;
    }
  });
  return [...byColor].map(([c, d]) => `<path d="${d.join('')}" fill="${c}"/>`).join('');
}

const fontAttrs = (size, bold, italic, family) =>
  `font-size="${n2(size)}"${bold ? ' font-weight="bold"' : ''}${italic ? ' font-style="italic"' : ''}${family ? ` font-family="${esc(family)}"` : ''}`;

export function sceneToSVG(prims, { bounds, bg = '#ffffff', font, pad = 16 }) {
  const x = Math.floor(bounds.x - pad), y = Math.floor(bounds.y - pad);
  const w = Math.ceil(bounds.w + 2 * pad), h = Math.ceil(bounds.h + 2 * pad);
  const out = [];
  let gid = 0;
  const gradient = g => {
    const id = `g${gid++}`;
    out.push(`<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(g.x0)}" y1="${n2(g.y0)}" x2="${n2(g.x1)}" y2="${n2(g.y1)}">` +
      g.stops.map((c, i) => `<stop offset="${n2(g.stops.length > 1 ? i / (g.stops.length - 1) : 0)}" stop-color="${esc(c)}"/>`).join('') + '</linearGradient></defs>');
    return `url(#${id})`;
  };
  for (const p of prims) {
    const op = p.alpha != null && p.alpha < 1 ? ` opacity="${n2(p.alpha)}"` : '';
    switch (p.k) {
      case 'p': {
        const paint = c => (c === 'grad' ? gradient(p.grad) : esc(c));
        let a = `d="${p.d}" fill="${p.fill ? paint(p.fill) : 'none'}"`;
        if (p.stroke) {
          a += ` stroke="${paint(p.stroke)}" stroke-width="${n2(p.lw || 1)}"`;
          if (p.dash && p.dash.length) a += ` stroke-dasharray="${p.dash.join(',')}"`;
          if (p.cap && p.cap !== 'butt') a += ` stroke-linecap="${p.cap}" stroke-linejoin="round"`;
        }
        out.push(`<path ${a}${op}/>`);
        break;
      }
      case 't': {
        const pos = p.rot ? `transform="translate(${n2(p.x)},${n2(p.y)}) rotate(${n2(p.rot)})"` : `x="${n2(p.x)}" y="${n2(p.y)}"`;
        const anchor = p.anchor && p.anchor !== 'start' ? ` text-anchor="${p.anchor}"` : '';
        const outline = p.outline ? ` stroke="${esc(p.outline)}" stroke-width="${n2(p.outlineWidth || 2)}" paint-order="stroke" stroke-linejoin="round"` : '';
        out.push(`<text ${pos}${anchor} dominant-baseline="central" ${fontAttrs(p.size, p.bold, p.italic, p.font)} fill="${esc(p.fill)}"${outline}${op}>${esc(p.text)}</text>`);
        break;
      }
      case 'r': {
        let cx = p.anchor === 'end' ? -p.w : p.anchor === 'middle' ? -p.w / 2 : 0;
        const runs = p.runs.map(r => {
          const t = `<text x="${n2(cx + (r.dx || 0))}" y="${n2(r.dy || 0)}" dominant-baseline="central" ${fontAttrs(r.size, r.bold, r.italic, r.font)} fill="${esc(r.color)}" xml:space="preserve">${esc(r.text)}</text>`;
          cx += r.w;
          return t;
        }).join('');
        out.push(`<g transform="translate(${n2(p.x)},${n2(p.y)})${p.rot ? ` rotate(${n2(p.rot)})` : ''}"${op}>${runs}</g>`);
        break;
      }
      case 'i': {
        const t = `translate(${n2(p.x)},${n2(p.y)})${p.rot ? ` rotate(${n2(p.rot)})` : ''}`;
        out.push(`<image href="${esc(p.url)}" x="${n2(-p.w / 2)}" y="${n2(-p.h / 2)}" width="${n2(p.w)}" height="${n2(p.h)}" transform="${t}" preserveAspectRatio="xMidYMid meet"/>`);
        break;
      }
      case 'a': {
        if (typeof document !== 'undefined' && p.uniform) {
          const url = bitmapDataUrl(alignmentBitmap(p));
          out.push(`<image href="${url}" x="${n2(p.x)}" y="${n2(p.ys[0] - p.rowH / 2)}" width="${n2(p.w)}" height="${n2(p.rowH * p.rows.length)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
        } else {
          out.push(alignmentVector(p));
        }
        break;
      }
      case 'g': {
        out.push(`<rect x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}" fill="${gradient({ x0: p.x, y0: 0, x1: p.x + p.w, y1: 0, stops: p.stops })}"/>`);
        break;
      }
    }
  }
  return {
    svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family="${esc(font)}">` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${esc(bg)}"/>${out.join('')}</svg>`,
    x, y, w, h,
  };
}
