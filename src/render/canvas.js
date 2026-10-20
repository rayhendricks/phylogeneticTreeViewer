/* Canvas 2D painter for scenes: viewport culling, text level-of-detail, cached Path2D and bitmaps. */
import { resolveScheme } from './residues.js';

export function schemeFor(prim) {
  if (!prim._scheme) prim._scheme = resolveScheme(prim.scheme, prim.rows);
  return prim._scheme;
}

const rgb = hex => {
  const h = hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};

const newCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

// One pixel per residue; scaled up with smoothing disabled when drawn.
export function alignmentBitmap(prim) {
  if (prim._bmp) return prim._bmp;
  const scheme = schemeFor(prim);
  const W = Math.max(1, prim.len), H = Math.max(1, prim.rows.length);
  const c = newCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const lut = {};
  for (const [k, v] of Object.entries(scheme)) if (/^#[0-9a-f]{3,6}$/i.test(v)) lut[k] = rgb(v);
  prim.rows.forEach((s, y) => {
    if (!s) return;
    for (let x = 0; x < s.length && x < W; x++) {
      const col = lut[s[x]];
      if (!col) continue;
      const o = (y * W + x) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  });
  ctx.putImageData(img, 0, 0);
  prim._bmp = c;
  return c;
}

const images = new Map();
function getImage(url, onLoad) {
  let e = images.get(url);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false };
    images.set(url, e);
    img.decoding = 'async';
    img.onload = () => { e.ok = true; onLoad(); };
    img.onerror = () => { e.failed = true; };
    img.src = url;
  }
  return e;
}

const MIN_TEXT_PX = 2.5;
const fontOf = (size, bold, italic, family) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;

function gradientOf(ctx, g) {
  const lg = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1);
  g.stops.forEach((c, i) => lg.addColorStop(g.stops.length > 1 ? i / (g.stops.length - 1) : 0, c));
  return lg;
}

// Paint prims with a view transform {k, x, y} (screen = scene * k + offset), in CSS pixels.
export function paint(ctx, prims, view, opts = {}) {
  const { width, height, font, onImageLoad = () => {} } = opts;
  const { k, x: tx, y: ty } = view;
  const vx0 = -tx / k, vy0 = -ty / k, vx1 = (width - tx) / k, vy1 = (height - ty) / k;
  let curFont = '';
  const setFont = f => { if (f !== curFont) { ctx.font = f; curFont = f; } };
  for (const p of prims) {
    const b = p.box;
    if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
    switch (p.k) {
      case 'p': {
        const path = p._p || (p._p = new Path2D(p.d));
        if (p.fill) { ctx.fillStyle = p.fill === 'grad' ? gradientOf(ctx, p.grad) : p.fill; ctx.fill(path); }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke === 'grad' ? gradientOf(ctx, p.grad) : p.stroke;
          ctx.lineWidth = p.lw || 1;
          ctx.lineCap = p.cap || 'butt';
          ctx.lineJoin = p.cap === 'round' ? 'round' : 'miter';
          ctx.setLineDash(p.dash || []);
          ctx.stroke(path);
        }
        break;
      }
      case 't': {
        if (p.size * k < MIN_TEXT_PX) break;
        setFont(fontOf(p.size, p.bold, p.italic, p.font || font));
        ctx.fillStyle = p.fill;
        ctx.textAlign = p.anchor === 'middle' ? 'center' : p.anchor === 'end' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        if (p.outline) { ctx.strokeStyle = p.outline; ctx.lineWidth = p.outlineWidth || 2; ctx.lineJoin = 'round'; ctx.setLineDash([]); }
        if (p.rot) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot * Math.PI / 180);
          if (p.outline) ctx.strokeText(p.text, 0, 0);
          ctx.fillText(p.text, 0, 0);
          ctx.restore();
        } else {
          if (p.outline) ctx.strokeText(p.text, p.x, p.y);
          ctx.fillText(p.text, p.x, p.y);
        }
        break;
      }
      case 'r': {
        // Rich text: runs with their own style, laid out left to right in a rotated frame.
        if (p.size * k < MIN_TEXT_PX) break;
        ctx.save();
        ctx.translate(p.x, p.y);
        if (p.rot) ctx.rotate(p.rot * Math.PI / 180);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let cx = p.anchor === 'end' ? -p.w : p.anchor === 'middle' ? -p.w / 2 : 0;
        for (const r of p.runs) {
          setFont(fontOf(r.size, r.bold, r.italic, r.font || font));
          ctx.fillStyle = r.color;
          ctx.fillText(r.text, cx + (r.dx || 0), (r.dy || 0));
          cx += r.w;
        }
        ctx.restore();
        curFont = '';
        break;
      }
      case 'i': {
        const e = getImage(p.url, onImageLoad);
        if (!e.ok) break;
        const iw = e.img.naturalWidth || 1, ih = e.img.naturalHeight || 1;
        const s = Math.min(p.w / iw, p.h / ih);
        ctx.save();
        ctx.translate(p.x, p.y);
        if (p.rot) ctx.rotate(p.rot * Math.PI / 180);
        ctx.drawImage(e.img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
        ctx.restore();
        break;
      }
      case 'a': {
        const bmp = alignmentBitmap(p);
        const smooth = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        const rh = p.rowH;
        if (p.uniform) {
          ctx.drawImage(bmp, p.x, p.ys[0] - rh / 2, p.w, rh * p.rows.length);
        } else {
          p.rows.forEach((s, r) => {
            if (!s) return;
            const y = p.ys[r] - rh / 2;
            if (y > vy1 || y + rh < vy0) return;
            ctx.drawImage(bmp, 0, r, p.len, 1, p.x, y, p.w, rh);
          });
        }
        ctx.imageSmoothingEnabled = smooth;
        const cw = p.w / p.len;
        if (cw * k >= 7 && rh * k >= 8) {
          const c0 = Math.max(0, Math.floor((vx0 - p.x) / cw)), c1 = Math.min(p.len - 1, Math.ceil((vx1 - p.x) / cw));
          const fs = Math.min(rh * 0.75, cw * 1.1);
          setFont(`${fs}px ui-monospace, Menlo, Consolas, monospace`);
          ctx.fillStyle = '#1a1a1a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          p.rows.forEach((s, r) => {
            if (!s) return;
            const y = p.ys[r];
            if (y < vy0 - rh || y > vy1 + rh) return;
            for (let c = c0; c <= c1 && c < s.length; c++) ctx.fillText(s[c], p.x + (c + 0.5) * cw, y);
          });
        }
        break;
      }
      case 'g': {
        ctx.fillStyle = gradientOf(ctx, { x0: p.x, y0: 0, x1: p.x + p.w, y1: 0, stops: p.stops });
        ctx.fillRect(p.x, p.y, p.w, p.h);
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}
