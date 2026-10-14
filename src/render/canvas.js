/* Canvas 2D painter for scenes: viewport culling, text level-of-detail, cached Path2D and bitmaps. */

const NUC = { A: '#5cb85c', C: '#3d7dd8', G: '#f0a030', T: '#e05050', U: '#e05050', N: '#b0b0b0' };
const AA = {};
for (const c of 'AILMFWV') AA[c] = '#80a0f0';
for (const c of 'KR') AA[c] = '#f01505';
for (const c of 'ED') AA[c] = '#c048c0';
for (const c of 'NQST') AA[c] = '#15c015';
AA.C = '#f08080'; AA.G = '#f09048'; AA.P = '#c0c000'; AA.H = '#15a4a4'; AA.Y = '#15a4a4'; AA.X = '#b0b0b0';

export function schemeFor(prim) {
  if (prim.scheme === 'nucleotide') return NUC;
  if (prim.scheme === 'protein') return AA;
  let nuc = 0, tot = 0;
  for (const s of prim.rows) {
    if (!s) continue;
    for (let i = 0; i < s.length && tot < 5000; i++) {
      const c = s[i];
      if (c === '-' || c === '.') continue;
      tot++;
      if ('ACGTUN'.includes(c)) nuc++;
    }
  }
  return tot && nuc / tot > 0.9 ? NUC : AA;
}

const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

// One pixel per residue; scaled up with smoothing disabled when drawn.
export function alignmentBitmap(prim) {
  if (prim._bmp) return prim._bmp;
  const scheme = schemeFor(prim);
  prim._scheme = scheme;
  const W = prim.len, H = prim.rows.length;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const lut = {};
  for (const [k, v] of Object.entries(scheme)) lut[k] = rgb(v);
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

// Paint prims with a view transform {k, x, y} (screen = scene * k + offset), in CSS pixels.
export function paint(ctx, prims, view, opts = {}) {
  const { width, height, font, onImageLoad = () => {} } = opts;
  const { k, x: tx, y: ty } = view;
  const vx0 = -tx / k, vy0 = -ty / k, vx1 = (width - tx) / k, vy1 = (height - ty) / k;
  let curFont = '';
  for (const p of prims) {
    const b = p.box;
    if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
    ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
    switch (p.k) {
      case 'p': {
        const path = p._p || (p._p = new Path2D(p.d));
        if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(path); }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
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
        const f = `${p.italic ? 'italic ' : ''}${p.bold ? 'bold ' : ''}${p.size}px ${font}`;
        if (f !== curFont) { ctx.font = f; curFont = f; }
        ctx.fillStyle = p.fill;
        ctx.textAlign = p.anchor === 'middle' ? 'center' : p.anchor === 'end' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        if (p.rot) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot * Math.PI / 180);
          ctx.fillText(p.text, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(p.text, p.x, p.y);
        }
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
        ctx.drawImage(bmp, p.x, p.y, p.w, p.h);
        ctx.imageSmoothingEnabled = smooth;
        const cw = p.w / p.len, ch = p.h / p.rows.length;
        if (cw * k >= 7 && ch * k >= 8) {
          const c0 = Math.max(0, Math.floor((vx0 - p.x) / cw)), c1 = Math.min(p.len - 1, Math.ceil((vx1 - p.x) / cw));
          const r0 = Math.max(0, Math.floor((vy0 - p.y) / ch)), r1 = Math.min(p.rows.length - 1, Math.ceil((vy1 - p.y) / ch));
          const fs = Math.min(ch * 0.75, cw * 1.1);
          ctx.font = curFont = `${fs}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.fillStyle = '#1a1a1a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (let r = r0; r <= r1; r++) {
            const s = p.rows[r];
            if (!s) continue;
            for (let c = c0; c <= c1 && c < s.length; c++) ctx.fillText(s[c], p.x + (c + 0.5) * cw, p.y + (r + 0.5) * ch);
          }
        }
        break;
      }
      case 'g': {
        const g = ctx.createLinearGradient(p.x, 0, p.x + p.w, 0);
        p.stops.forEach((c, i) => g.addColorStop(i / (p.stops.length - 1), c));
        ctx.fillStyle = g;
        ctx.fillRect(p.x, p.y, p.w, p.h);
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

export const residueColors = { NUC, AA };
