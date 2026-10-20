# LocalTree

LocalTree is a fast phylogenetic tree viewer and annotator modelled on [iTOL](https://itol.embl.de/), running entirely in the browser.
No server, no account, no uploads.

- **Hosted:** serve the folder from any static host (e.g. GitHub Pages) and open `index.html`.
- **Offline / double-click:** `npm run build` produces `dist/localtree.html`, a single self-contained file (about 140 KB, 50 KB gzipped) that also works when opened straight from disk.

## Features

**Input**
- Trees: Newick, NHX and BEAST/FigTree `[&key=value]` comments, NEXUS (TRANSLATE tables, multiple trees), phyloXML.
- Taxonomy trees: paste scientific names or NCBI taxonomy IDs; lineages are fetched from NCBI E-utilities.
- iTOL annotation files: `COLORSTRIP`, `SIMPLEBAR`, `MULTIBAR`, `HEATMAP`, `GRADIENT`, `BINARY`, `EXTERNALSHAPE`, `TEXT`, `SYMBOL`,
  `PIECHART`, `DOMAINS`, `ALIGNMENT`, `BOXPLOT`, `LINECHART`, `CONNECTION`, `IMAGE`, `DATASET_STYLE`, `TREE_COLORS`, `LABELS`, `COLLAPSE`.
  Node IDs can be names or `A|B` (last common ancestor).
- FASTA alignments (sequence names matching leaves).
- CSV/TSV metadata tables, with automatic ID-column detection and per-column choice of strip, gradient, bars, heatmap,
  stacked bars, pie slices, presence/absence, text, or display-name mapping.
- Drag and drop, file picker, or paste. The file type is detected automatically.

**Display**
- Rectangular, circular (arc, rotation, inner radius), slanted and unrooted (equal-angle) layouts.
- Phylogram or cladogram, aligned labels, support values as text or scaled symbols, branch length values, scale bar, legend.
- Clade highlights, branch/clade/label colors, label backgrounds, collapsed clades.

**Colors**
- Global background, branch and label colors, and font.
- Color branches by support, branch length, any numeric NHX/BEAST attribute (with perceptual color ramps), or by a
  categorical dataset (a clade is colored when all its leaves share a category).
- Per-dataset color editors: category colors, field colors, heatmap ramps and value ranges, domain colors, alignment schemes.
- Built-in palettes (Tableau, Okabe-Ito colorblind-safe, ColorBrewer) and ramps (Viridis, Magma, Cividis, diverging),
  plus your own saved palettes. Gradients are interpolated in OKLab so they look even.
- Dark mode.

**Editing** (all undoable)
- Reroot on any branch, midpoint rooting, ladderize, rotate, collapse/expand, remove or extract clades, rename labels.

**Analysis**
- Multi-term search (contains, exact, regex) with a "not found" report for gene lists, then select, color, highlight or prune to the matches.
- Select nodes to see root paths, their last common ancestor and a patristic distance matrix (copyable as TSV).
- Hover for branch length, support, root distance, NHX attributes and dataset values.

**Output and sharing**
- SVG and high-resolution PNG, Newick, and session JSON (tree, styles, datasets, settings).
- Shareable links: the whole session is compressed into the link itself (after `#`), so it is never sent to a server.
- The current session is autosaved in the browser.

## Command line and dashboards

`dist/localtree-cli.mjs` is a single file that runs with Node 18+ (no install). Copy it anywhere as `localtree`.

```sh
# One family: SVG figure, self-contained interactive HTML viewer, and a session file
localtree render --tree OG0000123.treefile \
  --annot species.tsv --annot OG0000123.aln.fasta --annot OG0000123.domains.txt \
  --midpoint --color-by species --meta expansion=+12 --out results/OG0000123

# Many families: one dashboard folder (index.html + data/), browsable offline
localtree dashboard --out results/dashboard --title "Gene families" --svg results/*.session.json
```

- `--annot` takes iTOL annotation files, FASTA alignments and CSV/TSV tables (first column matching leaf names is
  used as the ID; other columns become datasets by type). Repeat it for several files.
- `--color-by` takes `support`, `length`, `attr:KEY` or the name of a color-strip dataset (e.g. a table column).
- `--set KEY=VALUE` sets any display option (`--set mode=circular`, `--set alignLabels=false`).
- `--meta KEY=VALUE` adds a column to the dashboard's family table (sortable and filterable).
- The dashboard lists every family; click one (or press `[` / `]`) to open it in the full interactive viewer.
  "Keep my display settings" carries your layout and colors across families. It works from disk or any web server.
- SVG output from the command line estimates label widths from font metrics, so it can differ slightly from the browser.
  Use the viewer's Export for pixel-exact PNG/SVG.

### Nextflow

`nextflow/modules/localtree.nf` provides `LOCALTREE_RENDER` (per family) and `LOCALTREE_DASHBOARD` (collects all).
`nextflow/main.nf` is a working example:

```sh
nextflow run nextflow/main.nf -profile docker \
  --trees 'results/trees/*.treefile' --annotations 'results/annot/*' --species species.tsv --outdir localtree_out
```

Annotation files are matched to a family by name prefix (`OG0000123.*`). The module uses the stock
`node:22-slim` image; `localtree` comes from the pipeline's `bin/` folder (`npm run build` copies it there).
A `Dockerfile` is included if you prefer a dedicated image. Extra options go in `ext.args` (see `nextflow/nextflow.config`).

## Performance

The tree is drawn on a Canvas with viewport culling and level-of-detail (labels too small to read are skipped).
Branches are batched into a few dozen paths, and large trees pan and zoom from a cached frame, then redraw sharply
when the motion stops. A 5,000-leaf tree builds its scene in about 0.1 s and pans at display frame rate.
SVG export uses the same scene description, so exports match the screen.

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

Native ES modules, no runtime dependencies. Serve the folder (`npm run serve`) and open http://localhost:8000.

| Path | Purpose |
| --- | --- |
| `src/core/` | Tree model and operations; abstract layout |
| `src/io/` | Parsers (Newick, NEXUS, phyloXML, iTOL, CSV/TSV, FASTA), NCBI taxonomy, share links, samples |
| `src/render/scene.js` | Builds the drawing primitives for tree and datasets |
| `src/render/canvas.js`, `svg.js` | Canvas painter and SVG writer for those primitives |
| `src/render/color.js` | Palettes, ramps, OKLab interpolation |
| `src/ui/` | App controller, pan/zoom, side panels, dashboard mode |
| `src/cli/` | Command line (`render`, `dashboard`) |
| `nextflow/` | Nextflow module and example pipeline |

```sh
npm test        # unit tests (Node 18+)
npm run build   # dist/localtree.html, dist/localtree-cli.mjs, nextflow/bin/localtree (needs `npm install` once)
```
