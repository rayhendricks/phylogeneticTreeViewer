/* Tree file parsers (Newick/NHX, NEXUS, phyloXML) and Newick writer. */
import * as Tree from '../core/tree.js';

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const STOP = new Set(['(', ')', ',', ':', ';', '[']);
const isWs = c => c === ' ' || c === '\n' || c === '\r' || c === '\t';
const SUPPORT_KEYS = ['b', 'bootstrap', 'support', 'posterior', 'prob', 'confidence'];

function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0, cur = '', q = null;
  for (const ch of str) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function applyComment(node, text) {
  const t = text.trim();
  if (!t) return;
  let pairs = null;
  if (/^&&NHX/i.test(t)) pairs = t.slice(5).split(':');
  else if (t[0] === '&') pairs = splitTopLevel(t.slice(1), ',');
  else if (NUMERIC.test(t)) { if (node.support == null) node.support = parseFloat(t); return; }
  if (!pairs) return;
  for (const p of pairs) {
    if (!p.trim()) continue;
    const eq = p.indexOf('=');
    const k = (eq < 0 ? p : p.slice(0, eq)).trim();
    const v = eq < 0 ? 'true' : p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!k) continue;
    (node.attrs || (node.attrs = {}))[k] = v;
    const lk = k.toLowerCase();
    if (SUPPORT_KEYS.includes(lk) && node.support == null && NUMERIC.test(v)) node.support = parseFloat(v);
    if ((lk === '!color' || lk === 'color') && /^#[0-9a-f]{3,8}$/i.test(v)) {
      Tree.setStyle(node, { branchColor: v });
    }
  }
}

function parseNewick(str) {
  const s = String(str).trim();
  const n = s.length;
  if (!n) throw new Error('Empty tree string');
  const root = Tree.createNode();
  let node = root, i = 0;
  const labels = new Map(), quoted = new Set();
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === '(') { node = Tree.createNode(node); i++; }
    else if (c === ',') {
      if (!node.parent) throw new Error(`Unexpected "," at position ${i + 1}`);
      node = Tree.createNode(node.parent); i++;
    } else if (c === ')') {
      if (!node.parent) throw new Error(`Unbalanced ")" at position ${i + 1}`);
      node = node.parent; i++;
    } else if (c === ':') {
      i++;
      while (i < n && isWs(s[i])) i++;
      let j = i;
      while (j < n && !STOP.has(s[j]) && !isWs(s[j])) j++;
      const tok = s.slice(i, j);
      if (tok && !NUMERIC.test(tok)) throw new Error(`Invalid branch length "${tok}" at position ${i + 1}`);
      node.length = tok ? parseFloat(tok) : null;
      i = j;
    } else if (c === '[') {
      let depth = 0, j = i;
      for (; j < n; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']' && --depth === 0) break;
      }
      if (j >= n) throw new Error('Unterminated comment "["');
      applyComment(node, s.slice(i + 1, j));
      i = j + 1;
    } else if (c === ';') {
      break;
    } else if (c === "'" || c === '"') {
      let j = i + 1, out = '';
      while (j < n) {
        if (s[j] === c) { if (s[j + 1] === c) { out += c; j += 2; continue; } break; }
        out += s[j++];
      }
      if (j >= n) throw new Error('Unterminated quoted label');
      labels.set(node, (labels.get(node) || '') + out);
      quoted.add(node);
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !STOP.has(s[j]) && s[j] !== "'") j++;
      labels.set(node, (labels.get(node) || '') + s.slice(i, j).trim());
      i = j;
    }
  }
  if (node !== root) throw new Error('Unbalanced parentheses: missing ")"');
  for (const [nd, lab] of labels) {
    if (nd.children.length && !quoted.has(nd) && NUMERIC.test(lab)) nd.support = parseFloat(lab);
    else nd.name = lab;
  }
  if (root.children.length === 1 && !root.name) {
    const tree = { root };
    Tree.collapseUnary(tree, root);
    return tree.root;
  }
  return root;
}

function splitStatements(body) {
  const out = [];
  let cur = '', q = null, depth = 0;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ';' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = s => s.trim().replace(/^'(.*)'$/s, (m, x) => x.replace(/''/g, "'")).replace(/^"(.*)"$/s, '$1');

function parseNexus(text) {
  const m = /begin\s+trees\s*;/i.exec(text);
  if (!m) throw new Error('NEXUS file has no TREES block');
  const translate = new Map();
  const trees = [];
  for (let st of splitStatements(text.slice(m.index + m[0].length))) {
    st = st.replace(/^(\s*\[[^\]]*\]\s*)+/, '');
    if (/^end(block)?$/i.test(st)) break;
    if (/^translate\s/i.test(st)) {
      for (const entry of splitTopLevel(st.replace(/^translate\s+/i, ''), ',')) {
        const em = /^\s*(\S+)\s+([\s\S]+?)\s*$/.exec(entry);
        if (em) translate.set(unquote(em[1]), unquote(em[2]));
      }
    } else {
      const tm = /^u?tree\s+(\*\s*)?([^=]+?)\s*=\s*([\s\S]*)$/i.exec(st);
      if (tm) {
        const root = parseNewick(tm[3] + ';');
        if (translate.size) {
          for (const nd of Tree.preorder(root)) if (nd.name && translate.has(nd.name)) nd.name = translate.get(nd.name);
        }
        trees.push({ name: unquote(tm[2]), root });
      }
    }
  }
  if (!trees.length) throw new Error('No trees found in NEXUS TREES block');
  return trees;
}

function parsePhyloXML(text) {
  if (typeof DOMParser === 'undefined') throw new Error('phyloXML parsing requires a browser');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid XML');
  const kids = (el, name) => Array.from(el.children).filter(c => c.localName === name);
  const textOf = (el, name) => { const k = kids(el, name)[0]; return k ? k.textContent.trim() : ''; };
  const trees = [];
  for (const ph of Array.from(doc.getElementsByTagNameNS('*', 'phylogeny'))) {
    const top = kids(ph, 'clade')[0];
    if (!top) continue;
    const root = Tree.createNode();
    const stack = [[top, root]];
    while (stack.length) {
      const [el, nd] = stack.pop();
      const tax = kids(el, 'taxonomy')[0];
      nd.name = textOf(el, 'name') || (tax && (textOf(tax, 'scientific_name') || textOf(tax, 'code'))) || '';
      const bl = el.getAttribute('branch_length') || textOf(el, 'branch_length');
      if (bl && NUMERIC.test(bl)) nd.length = parseFloat(bl);
      const conf = textOf(el, 'confidence');
      if (conf && NUMERIC.test(conf)) nd.support = parseFloat(conf);
      const childEls = kids(el, 'clade');
      const childNodes = childEls.map(() => Tree.createNode(nd));
      for (let i = childEls.length - 1; i >= 0; i--) stack.push([childEls[i], childNodes[i]]);
    }
    trees.push({ name: textOf(ph, 'name') || `Tree ${trees.length + 1}`, root });
  }
  if (!trees.length) throw new Error('No phylogeny found in phyloXML');
  return trees;
}

// Returns [{name, root}] for any supported tree format.
function parseTrees(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  if (/^#nexus/i.test(t)) return parseNexus(t);
  if (t[0] === '<') return parsePhyloXML(t);
  const parts = splitStatements(t).filter(p => p.includes('(') || /^[^\s,()]+$/.test(p));
  if (!parts.length) throw new Error('No Newick tree found');
  return parts.map((p, i) => ({ name: parts.length > 1 ? `Tree ${i + 1}` : '', root: parseNewick(p + ';') }));
}

function quoteLabel(name) {
  return /[\s()[\]':;,]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

const fmt = v => String(+v.toPrecision(10));

function toNewick(root, opts = {}) {
  const { lengths = true, support = true, internalNames = true } = opts;
  const out = [];
  const stack = [{ n: root, i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const n = top.n;
    if (n.children.length && top.i === 0) out.push('(');
    if (top.i < n.children.length) {
      if (top.i > 0) out.push(',');
      stack.push({ n: n.children[top.i], i: 0 });
      top.i++;
      continue;
    }
    if (n.children.length) {
      out.push(')');
      if (internalNames && n.name) out.push(quoteLabel(n.name));
      else if (support && n.support != null) out.push(fmt(n.support));
    } else if (n.name) {
      out.push(quoteLabel(n.name));
    }
    if (lengths && n.parent && n.length != null) out.push(':' + fmt(n.length));
    stack.pop();
  }
  return out.join('') + ';';
}

export { parseNewick, parseNexus, parsePhyloXML, parseTrees, toNewick, splitTopLevel };
