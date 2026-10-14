// Bundles the app into one self-contained, minified HTML file: dist/localtree.html.
// It works offline and when opened directly from disk (file://).
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const js = await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: 'es2022', write: false,
});
const css = await build({ entryPoints: ['styles.css'], bundle: true, minify: true, write: false, loader: { '.css': 'css' } });
let html = await readFile('index.html', 'utf8');
const code = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
html = html
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css.outputFiles[0].text}</style>`)
  .replace('<script type="module" src="src/main.js"></script>', '')
  .replace('</body>', () => `<script>${code}</script>\n</body>`);
await mkdir('dist', { recursive: true });
await writeFile('dist/localtree.html', html);
console.log(`dist/localtree.html  ${(html.length / 1024).toFixed(0)} KB`);
