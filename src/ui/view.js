/* Pan / zoom / pinch controller for the canvas. Screen = scene * k + (x, y). */

export class View {
  constructor(el, onChange) {
    this.el = el;
    this.onChange = onChange;
    this.k = 1; this.x = 0; this.y = 0;
    this.minK = 0.002; this.maxK = 200;
    this.pointers = new Map();
    this.dragged = false;
    this.anim = null;

    el.addEventListener('wheel', e => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const f = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
      const r = el.getBoundingClientRect();
      this.zoomAt(f, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      this.dragged = false;
      this.stop();
      el.classList.add('grabbing');
    });
    el.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const pts = [...this.pointers.values()];
      if (pts.length === 1) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 4) this.dragged = true;
        if (this.dragged) this.set(this.k, this.x + e.clientX - p.x, this.y + e.clientY - p.y);
      } else if (pts.length === 2) {
        const other = pts.find(q => q !== p);
        const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        const r = el.getBoundingClientRect();
        const mx = (e.clientX + other.x) / 2 - r.left, my = (e.clientY + other.y) / 2 - r.top;
        const pmx = (p.x + other.x) / 2 - r.left, pmy = (p.y + other.y) / 2 - r.top;
        this.dragged = true;
        this.set(this.k, this.x + mx - pmx, this.y + my - pmy, true);
        if (d0 > 0) this.zoomAt(d1 / d0, mx, my);
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const end = e => {
      this.pointers.delete(e.pointerId);
      if (!this.pointers.size) el.classList.remove('grabbing');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // A drag must not also count as a click.
    el.addEventListener('click', e => { if (this.dragged) { e.stopImmediatePropagation(); this.dragged = false; } }, true);
  }

  set(k, x, y, silent) {
    this.k = Math.max(this.minK, Math.min(this.maxK, k));
    this.x = x; this.y = y;
    if (!silent) this.onChange();
  }

  zoomAt(f, sx, sy) {
    const k = Math.max(this.minK, Math.min(this.maxK, this.k * f));
    const r = k / this.k;
    this.set(k, sx - (sx - this.x) * r, sy - (sy - this.y) * r);
  }

  zoomCenter(f, animate = true) {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!animate) return this.zoomAt(f, w / 2, h / 2);
    const k = Math.max(this.minK, Math.min(this.maxK, this.k * f)), r = k / this.k;
    this.animateTo(k, w / 2 - (w / 2 - this.x) * r, h / 2 - (h / 2 - this.y) * r);
  }

  fit(b, animate = true, pad = 28) {
    if (!b || !(b.w > 0) || !(b.h > 0)) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const k = Math.min((W - 2 * pad) / b.w, (H - 2 * pad) / b.h, 4);
    const x = (W - b.w * k) / 2 - b.x * k, y = (H - b.h * k) / 2 - b.y * k;
    if (animate) this.animateTo(k, x, y); else this.set(k, x, y);
  }

  animateTo(k, x, y, ms = 280) {
    this.stop();
    const k0 = this.k, x0 = this.x, y0 = this.y, t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      // Interpolate scale geometrically so zooming feels uniform.
      const kk = k0 * (k / k0) ** e;
      this.set(kk, x0 + (x - x0) * e, y0 + (y - y0) * e);
      this.anim = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  stop() { if (this.anim) cancelAnimationFrame(this.anim); this.anim = null; }

  toScene(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.x) / this.k, (clientY - r.top - this.y) / this.k];
  }
}
