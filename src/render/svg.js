/* Scene -> standalone SVG document (for vector export). */
import { alignmentBitmap } from './canvas.js';

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = v => Math.round(v * 100) / 100;

function bitmapDataUrl(bmp) {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c.toDataURL('image/png');
}

export function sceneToSVG(prims, { bounds, bg = '#ffffff', font, pad = 16 }) {
  const x = Math.floor(bounds.x - pad), y = Math.floor(bounds.y - pad);
  const w = Math.ceil(bounds.w + 2 * pad), h = Math.ceil(bounds.h + 2 * pad);
  const out = [];
  let gid = 0;
  for (const p of prims) {
    const op = p.alpha != null && p.alpha < 1 ? ` opacity="${n2(p.alpha)}"` : '';
    switch (p.k) {
      case 'p': {
        let a = `d="${p.d}" fill="${p.fill ? esc(p.fill) : 'none'}"`;
        if (p.stroke) {
          a += ` stroke="${esc(p.stroke)}" stroke-width="${n2(p.lw || 1)}"`;
          if (p.dash) a += ` stroke-dasharray="${p.dash.join(',')}"`;
          if (p.cap && p.cap !== 'butt') a += ` stroke-linecap="${p.cap}" stroke-linejoin="round"`;
        }
        out.push(`<path ${a}${op}/>`);
        break;
      }
      case 't': {
        const pos = p.rot ? `transform="translate(${n2(p.x)},${n2(p.y)}) rotate(${n2(p.rot)})"` : `x="${n2(p.x)}" y="${n2(p.y)}"`;
        const anchor = p.anchor && p.anchor !== 'start' ? ` text-anchor="${p.anchor}"` : '';
        const st = (p.bold ? ' font-weight="bold"' : '') + (p.italic ? ' font-style="italic"' : '');
        out.push(`<text ${pos}${anchor} dominant-baseline="central" font-size="${n2(p.size)}"${st} fill="${esc(p.fill)}"${op}>${esc(p.text)}</text>`);
        break;
      }
      case 'i': {
        const t = `translate(${n2(p.x)},${n2(p.y)})${p.rot ? ` rotate(${n2(p.rot)})` : ''}`;
        out.push(`<image href="${esc(p.url)}" x="${n2(-p.w / 2)}" y="${n2(-p.h / 2)}" width="${n2(p.w)}" height="${n2(p.h)}" transform="${t}" preserveAspectRatio="xMidYMid meet"/>`);
        break;
      }
      case 'a': {
        const url = bitmapDataUrl(alignmentBitmap(p));
        if (url) out.push(`<image href="${url}" x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
        break;
      }
      case 'g': {
        const id = `lg${gid++}`;
        out.push(`<defs><linearGradient id="${id}">${p.stops.map((c, i) => `<stop offset="${n2(i / (p.stops.length - 1))}" stop-color="${esc(c)}"/>`).join('')}</linearGradient></defs>` +
          `<rect x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}" fill="url(#${id})"/>`);
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
