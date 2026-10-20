/* Display settings shared by the browser app and the command line. */
import * as Tree from './tree.js';

export const DEFAULTS = {
  mode: 'rectangular', branchLengths: true, alignLabels: false, showLeafLabels: true, showInternalLabels: false,
  support: 'none', supportMin: 0, showBranchLengths: false, fontSize: 12, spacing: 18, treeWidth: 500,
  arc: 360, rotation: 0, innerRadius: 0, lineWidth: 1.5, nodeDots: false, italic: false, showLegend: true,
  showScale: true, dimNonHits: true, rangeOpacity: 0.35, datasetGap: 6,
  fontFamily: 'Helvetica, Arial, sans-serif', bgColor: null, branchColor: null, labelColor: null,
  branchColorBy: 'none', branchRamp: 'Viridis', branchRampReverse: false, palette: 'Tableau 10',
  curved: false, flip: false, daylight: 0, branchGradient: false,
  branchWidthBy: 'none', widthMin: 0.5, widthMax: 4,
  scaleGrid: false, scaleAxis: 'distance', timeFactor: 1, branchLengthMode: 'length',
  rangeMeta: 'none', rangeMetaColor: '#4e79a7', supportSource: 'support', supportShape: 2,
  nodeShape: 2, nodeSize: null, multiStyle: null,
};

// Size-dependent defaults for a freshly loaded tree.
export function autoSettings(s, root) {
  const n = Tree.leaves(root).length;
  s.spacing = n > 3000 ? 3 : n > 1000 ? 5 : n > 300 ? 9 : n > 100 ? 14 : 20;
  s.fontSize = Math.max(3, Math.min(13, Math.round(s.spacing * 0.7 * 2) / 2));
  s.treeWidth = Math.round(Math.min(2400, Math.max(450, n * 2)) / 10) * 10;
  s.branchLengths = Tree.hasBranchLengths(root);
  s.support = 'none';
  s.branchColorBy = 'none';
  for (const nd of Tree.preorder(root)) if (nd.children.length && nd.support != null) { s.support = n <= 200 ? 'text' : 'symbol'; break; }
  return s;
}
