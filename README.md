# Phylogenetic Tree Viewer

Interactive tree viewer and annotator modelled on [iTOL](https://itol.embl.de/), running entirely in the browser.
No server, no account, no uploads: open `index.html` directly or host the folder on any static server (e.g. GitHub Pages).

## Features

**Input**
- Trees: Newick, NHX and BEAST/FigTree `[&key=value]` comments, NEXUS (TRANSLATE tables, multiple trees), phyloXML.
- iTOL annotation files: `DATASET_COLORSTRIP`, `SIMPLEBAR`, `MULTIBAR`, `HEATMAP`, `GRADIENT`, `BINARY`, `TEXT`, `SYMBOL`,
  `DATASET_STYLE`, `TREE_COLORS`, `LABELS`, `COLLAPSE`. Node IDs can be names or `A|B` (last common ancestor).
- CSV/TSV metadata tables, with automatic ID-column detection and per-column choice of strip, gradient, bars, heatmap,
  stacked bars, presence/absence, text, or display-name mapping.
- Drag and drop, file picker, or paste. The file type is detected automatically.

**Display**
- Rectangular, circular (arc, rotation, inner radius), slanted and unrooted (equal-angle) layouts.
- Phylogram or cladogram, aligned labels, support values as text or scaled symbols, branch length values, scale bar, legend.
- Clade highlights, branch/clade/label colors, label backgrounds, collapsed clades.
- Dark mode.

**Editing** (all undoable)
- Reroot on any branch, midpoint rooting, ladderize, rotate, collapse/expand, remove or extract clades, rename labels.

**Analysis**
- Multi-term search (contains, exact, regex) with a "not found" report for gene lists, then select, color, highlight or prune to the matches.
- Select nodes to see root paths, their last common ancestor and a patristic distance matrix (copyable as TSV).
- Hover for branch length, support, root distance, NHX attributes and dataset values.

**Output**
- SVG and high-resolution PNG, Newick, and session JSON (tree, styles, datasets, settings).
- The current session is autosaved in the browser.

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+O` | Open files |
| `1`–`4` | Rectangular, circular, slanted, unrooted |
| `F` | Fit to view |
| `+` / `-` | Zoom |
| `/` | Search |
| `Esc` | Clear selection |

## Development

No build step. Code layout:

| File | Purpose |
| --- | --- |
| `js/tree.js` | Tree model and operations (reroot, midpoint, prune, ladderize, snapshots) |
| `js/newick.js` | Newick/NHX, NEXUS and phyloXML parsers; Newick writer |
| `js/annotations.js` | iTOL annotation and CSV/TSV import |
| `js/layout.js` | Leaf order, depths, equal-angle layout |
| `js/render.js` | SVG scene generation (shared by the canvas and exports) |
| `js/app.js` | UI, interaction, persistence |
| `vendor/d3.min.js` | d3 v7.9.0 (pan/zoom and color interpolation), vendored so the app works offline |

Run the tests (Node 18+):

```sh
npm test
```
