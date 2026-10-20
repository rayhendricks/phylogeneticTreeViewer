/* File type detection shared by the browser app and the command line. */
import { isItol, isFasta, isMemeXml } from './annotations.js';
import { isJplace } from './jplace.js';

// Returns 'session' | 'jplace' | 'meme' | 'annotation' | 'fasta' | 'tree' | 'table'.
export function detectKind(text, filename = '') {
  const t = String(text).replace(/^﻿/, '').trimStart();
  if (t[0] === '{') {
    try { if (JSON.parse(t).ptvSession) return 'session'; } catch (e) { /* not JSON */ }
    if (isJplace(t)) return 'jplace';
  }
  if (t[0] === '<' && isMemeXml(t)) return 'meme';
  if (isItol(t)) return 'annotation';
  if (isFasta(t) || /\.(fa|fasta|fas|aln|afa|faa|fna)$/i.test(filename)) return 'fasta';
  if (/^#nexus/i.test(t) || t[0] === '<' || t[0] === '(' || t[0] === '[') return 'tree';
  if (/\.(csv|tsv|tab)$/i.test(filename)) return 'table';
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  if (lines.length >= 2 && !t.includes('(') && /[\t,;]/.test(lines[0])) return 'table';
  return 'tree';
}
