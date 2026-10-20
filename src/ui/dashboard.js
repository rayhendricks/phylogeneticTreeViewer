/* Dashboard mode: a filterable, sortable list of families; each loads into the viewer on click.
   Family data lives in data/<id>.js files that call LocalTreeLoad(session, id), so the dashboard
   works from a web server and when opened straight from disk. */
import { esc } from '../render/svg.js';
import { fmtNum } from '../render/scene.js';

export function initDashboard(cfg, app) {
  const families = cfg.families || [];
  const metaKeys = [];
  for (const f of families) for (const k of Object.keys(f.meta || {})) if (!metaKeys.includes(k) && k !== 'rooted') metaKeys.push(k);
  const cols = ['name', ...metaKeys.slice(0, 6)];
  let sortKey = 'name', sortDir = 1, filter = '', current = null, pending = null;

  document.title = cfg.title || document.title;
  const brand = document.querySelector('.brand span');
  if (brand && cfg.title) brand.textContent = cfg.title;

  const sec = document.createElement('details');
  sec.className = 'section families';
  sec.open = true;
  sec.innerHTML = `<summary>Families <span class="count">(${families.length})</span></summary>
    <div class="field row"><input class="input" id="fam-filter" placeholder="Filter by name or value" aria-label="Filter families">
      <button class="mini" id="fam-prev" title="Previous family ([)">‹</button><button class="mini" id="fam-next" title="Next family (])">›</button></div>
    <label class="check"><input type="checkbox" id="fam-keep" checked> Keep my display settings when switching</label>
    <div class="fam-wrap"><table class="tbl fam"><thead><tr>${cols.map(c => `<th data-sort="${esc(c)}">${esc(c === 'name' ? 'Family' : c)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
  const panel = document.getElementById('panel');
  panel.insertBefore(sec, panel.firstChild);
  const tbody = sec.querySelector('tbody');

  const val = (f, k) => (k === 'name' ? f.name : (f.meta || {})[k]);
  const fmt = v => (typeof v === 'number' ? fmtNum(v) : v == null ? '' : String(v));
  function visible() {
    const q = filter.toLowerCase();
    const list = families.filter(f => !q || [f.name, ...Object.values(f.meta || {})].some(v => String(v).toLowerCase().includes(q)));
    return list.sort((a, b) => {
      const x = val(a, sortKey), y = val(b, sortKey);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
      return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * sortDir;
    });
  }
  function renderTable() {
    const list = visible();
    tbody.innerHTML = list.map(f => `<tr data-id="${esc(f.id)}" class="${f.id === current ? 'current' : ''}">${cols.map(c => `<td>${esc(fmt(val(f, c)))}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="muted">No families match.</td></tr>`;
    for (const th of sec.querySelectorAll('th')) th.classList.toggle('sorted', th.dataset.sort === sortKey);
    const row = tbody.querySelector('tr.current');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function load(id) {
    const f = families.find(x => x.id === id);
    if (!f) return;
    pending = id;
    const s = document.createElement('script');
    s.src = f.file;
    s.onload = () => s.remove();
    s.onerror = () => { s.remove(); app.toast(`Could not load ${f.file}. Keep index.html next to its data folder.`, 'error'); };
    document.head.appendChild(s);
  }

  window.LocalTreeLoad = (session, id) => {
    if (id !== pending) return;
    try {
      app.loadSession(session, sec.querySelector('#fam-keep').checked && !!app.state.tree);
      current = id;
      history.replaceState(null, '', '#family=' + encodeURIComponent(id));
      renderTable();
    } catch (e) { app.toast(`${id}: ${e.message}`, 'error'); }
  };

  const step = d => {
    const list = visible();
    if (!list.length) return;
    const i = list.findIndex(f => f.id === current);
    load(list[(i + d + list.length) % list.length].id);
  };

  tbody.addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) load(tr.dataset.id); });
  sec.querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = sortKey === 'name' ? 1 : -1; }
    renderTable();
  });
  sec.querySelector('#fam-filter').addEventListener('input', e => { filter = e.target.value.trim(); renderTable(); });
  sec.querySelector('#fam-prev').onclick = () => step(-1);
  sec.querySelector('#fam-next').onclick = () => step(1);
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ']') step(1);
    else if (e.key === '[') step(-1);
  });

  renderTable();
  const fromHash = /#family=([^&]+)/.exec(location.hash);
  const first = fromHash && families.some(f => f.id === decodeURIComponent(fromHash[1])) ? decodeURIComponent(fromHash[1]) : (visible()[0] || {}).id;
  if (first) load(first); else app.toast('This dashboard has no families', 'error');
}
