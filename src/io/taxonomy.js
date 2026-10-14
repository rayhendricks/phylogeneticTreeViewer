/* Build a tree from NCBI Taxonomy lineages (names or taxonomy IDs) via the public E-utilities API. */
import * as Tree from '../core/tree.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) return res;
    if (res.status !== 429) throw new Error(`NCBI request failed (${res.status})`);
    await sleep(1000 * (attempt + 1));
  }
  throw new Error('NCBI rate limit reached; try again in a minute');
}

// Parse efetch taxonomy XML -> [{id, name, rank, lineage: [{id, name, rank}]}]
export function parseTaxaXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const own = (el, tag) => { const c = Array.from(el.children).find(x => x.tagName === tag); return c ? c.textContent.trim() : ''; };
  return Array.from(doc.documentElement.children).filter(t => t.tagName === 'Taxon').map(t => {
    const lin = Array.from(t.children).find(x => x.tagName === 'LineageEx');
    return {
      id: own(t, 'TaxId'), name: own(t, 'ScientificName'), rank: own(t, 'Rank'),
      lineage: lin ? Array.from(lin.children).map(x => ({ id: own(x, 'TaxId'), name: own(x, 'ScientificName'), rank: own(x, 'Rank') })) : [],
    };
  });
}

// queries: names or numeric taxonomy IDs. Returns { taxa, missing }.
export async function fetchTaxa(queries, { onProgress = () => {}, signal } = {}) {
  const ids = new Set(), names = [];
  for (const q of queries.map(s => s.trim()).filter(Boolean)) (/^\d+$/.test(q) ? ids.add(q) : names.push(q));
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    onProgress(`Looking up names ${i + 1}–${i + batch.length} of ${names.length}…`);
    const term = batch.map(n => `"${n.replace(/["_]/g, ' ')}"[Scientific Name]`).join(' OR ');
    const res = await get(`${EUTILS}esearch.fcgi?db=taxonomy&retmode=json&retmax=500&term=${encodeURIComponent(term)}`, signal);
    const json = await res.json();
    for (const id of (json.esearchresult && json.esearchresult.idlist) || []) ids.add(id);
    await sleep(350);
  }
  const all = [...ids], taxa = [];
  for (let i = 0; i < all.length; i += 150) {
    onProgress(`Fetching lineages ${i + 1}–${Math.min(all.length, i + 150)} of ${all.length}…`);
    const res = await get(`${EUTILS}efetch.fcgi?db=taxonomy&retmode=xml&id=${all.slice(i, i + 150).join(',')}`, signal);
    taxa.push(...parseTaxaXml(await res.text()));
    await sleep(350);
  }
  const found = new Set(taxa.flatMap(t => [t.id, t.name.toLowerCase()]));
  const missing = queries.map(s => s.trim()).filter(Boolean).filter(q => !found.has(/^\d+$/.test(q) ? q : q.replace(/_/g, ' ').toLowerCase()));
  return { taxa, missing };
}

// Lineages -> tree. Internal nodes are named by taxon; single-child ranks are collapsed.
export function treeFromLineages(taxa, { keepRanks = false } = {}) {
  const root = Tree.createNode();
  root.name = '';
  const byId = new Map();
  for (const t of taxa) {
    let parent = root;
    for (const step of [...t.lineage, { id: t.id, name: t.name, rank: t.rank }]) {
      let node = byId.get(step.id);
      if (!node) {
        node = Tree.createNode(parent);
        node.name = step.name;
        node.attrs = { taxid: step.id, rank: step.rank || 'no rank' };
        byId.set(step.id, node);
      }
      parent = node;
    }
  }
  const tree = { root };
  if (!keepRanks) {
    for (const nd of Tree.postorder(root)) if (nd.children.length === 1) Tree.collapseUnary(tree, nd);
  }
  for (const nd of Tree.preorder(tree.root)) nd.length = null;
  return tree.root;
}
