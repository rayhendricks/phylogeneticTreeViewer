/* Example trees. Annotation values marked "synthetic" are illustrative only. */

// Approximate divergence times (Myr); topology follows the placental mammal consensus.
const hominidae = '(((Homo_sapiens:6.5,Pan_troglodytes:6.5)100:2,Gorilla_gorilla:8.5)100:6.5,Pongo_abelii:15)';
const primates = `((${hominidae}100:14,Macaca_mulatta:29)100:14,Callithrix_jacchus:43)`;
const glires = '(((Mus_musculus:20,Rattus_norvegicus:20)100:50,Cavia_porcellus:70)98:12,Oryctolagus_cuniculus:82)';
const laurasia = '((((Canis_lupus:55,Felis_catus:55)100:23,Equus_caballus:78)64:2,' +
  '((Bos_taurus:55,Tursiops_truncatus:55)100:7,Sus_scrofa:62)100:18)72:5,Myotis_lucifugus:85)';
const mammals = `((((${primates}100:47,${glires}95:8)87:6,${laurasia}91:11)100:4,Loxodonta_africana:100)100:60,Monodelphis_domestica:160);`;

const order = [
  ['Homo_sapiens|Callithrix_jacchus', '#e15759', 'Primates'],
  ['Mus_musculus|Cavia_porcellus', '#4e79a7', 'Rodentia'],
  ['Oryctolagus_cuniculus', '#76b7b2', 'Lagomorpha'],
  ['Canis_lupus|Felis_catus', '#f28e2b', 'Carnivora'],
  ['Equus_caballus', '#edc948', 'Perissodactyla'],
  ['Bos_taurus|Sus_scrofa', '#59a14f', 'Artiodactyla'],
  ['Myotis_lucifugus', '#b07aa1', 'Chiroptera'],
  ['Loxodonta_africana', '#9c755f', 'Proboscidea'],
  ['Monodelphis_domestica', '#bab0ac', 'Didelphimorphia'],
];

const mammalAnnotations = [
  ['TREE_COLORS', 'SEPARATOR COMMA', 'DATA',
    'Homo_sapiens|Callithrix_jacchus,range,#fde2e2,Euarchonta',
    'Mus_musculus|Oryctolagus_cuniculus,range,#dbe8f6,Glires',
    'Canis_lupus|Myotis_lucifugus,range,#e3f1df,Laurasiatheria',
    'Homo_sapiens,label,#c0392b,bold,1'].join('\n'),
  ['DATASET_COLORSTRIP', 'SEPARATOR COMMA', 'DATASET_LABEL,Order', 'COLOR,#4e79a7', 'DATA',
    ...order.map(r => r.join(','))].join('\n'),
  ['DATASET_SIMPLEBAR', 'SEPARATOR COMMA', 'DATASET_LABEL,Synthetic score', 'COLOR,#76b7b2', 'WIDTH,110', 'DATA',
    'Homo_sapiens,9.1', 'Pan_troglodytes,8.4', 'Gorilla_gorilla,7.9', 'Pongo_abelii,7.2', 'Macaca_mulatta,6.1',
    'Callithrix_jacchus,4.2', 'Mus_musculus,2.3', 'Rattus_norvegicus,2.6', 'Cavia_porcellus,3.1',
    'Oryctolagus_cuniculus,3.5', 'Canis_lupus,5.8', 'Felis_catus,5.1', 'Equus_caballus,6.6', 'Bos_taurus,6.0',
    'Tursiops_truncatus,8.8', 'Sus_scrofa,5.4', 'Myotis_lucifugus,1.9', 'Loxodonta_africana,8.2',
    'Monodelphis_domestica,1.4'].join('\n'),
  ['DATASET_HEATMAP', 'SEPARATOR COMMA', 'DATASET_LABEL,Synthetic heatmap', 'FIELD_LABELS,s1,s2,s3,s4,s5',
    'COLOR_MIN,#2166ac', 'COLOR_MID,#f7f7f7', 'COLOR_MAX,#b2182b', 'DATA',
    'Homo_sapiens,2.1,1.4,-0.3,-1.2,0.4', 'Pan_troglodytes,1.9,1.2,-0.1,-1.0,0.6', 'Gorilla_gorilla,1.6,1.1,0.2,-0.8,0.3',
    'Pongo_abelii,1.2,0.7,0.4,-0.6,0.1', 'Macaca_mulatta,0.9,0.3,0.6,-0.2,-0.2', 'Callithrix_jacchus,0.4,-0.1,0.9,0.1,-0.5',
    'Mus_musculus,-1.1,-0.9,1.6,0.8,-1.2', 'Rattus_norvegicus,-1.0,-0.7,1.4,0.9,-1.0', 'Cavia_porcellus,-0.6,-0.4,1.1,0.5,-0.7',
    'Oryctolagus_cuniculus,-0.2,-0.3,0.8,0.4,-0.4', 'Canis_lupus,0.3,0.9,-0.8,1.4,0.8', 'Felis_catus,0.2,1.1,-0.9,1.6,0.9',
    'Equus_caballus,0.5,0.6,-0.4,1.1,1.3', 'Bos_taurus,0.1,0.4,-0.2,0.9,1.7', 'Tursiops_truncatus,0.8,0.2,-0.5,0.6,1.9',
    'Sus_scrofa,0.0,0.5,-0.1,0.7,1.5', 'Myotis_lucifugus,-0.5,1.3,0.2,1.8,-0.9', 'Loxodonta_africana,1.0,-0.6,0.0,-0.4,1.1',
    'Monodelphis_domestica,-1.8,-1.5,-1.2,-1.6,-1.4'].join('\n'),
  ['DATASET_BINARY', 'SEPARATOR COMMA', 'DATASET_LABEL,Synthetic traits', 'FIELD_LABELS,trait A,trait B,trait C',
    'FIELD_SHAPES,2,1,3', 'FIELD_COLORS,#e15759,#4e79a7,#59a14f', 'DATA',
    'Homo_sapiens,1,0,1', 'Pan_troglodytes,1,0,1', 'Gorilla_gorilla,1,0,0', 'Pongo_abelii,1,1,0', 'Macaca_mulatta,1,1,0',
    'Callithrix_jacchus,0,1,0', 'Mus_musculus,0,1,1', 'Rattus_norvegicus,0,1,1', 'Cavia_porcellus,0,1,-1',
    'Oryctolagus_cuniculus,0,0,1', 'Canis_lupus,1,0,1', 'Felis_catus,1,0,1', 'Equus_caballus,0,0,1', 'Bos_taurus,0,1,0',
    'Tursiops_truncatus,1,1,0', 'Sus_scrofa,0,1,0', 'Myotis_lucifugus,0,0,1', 'Loxodonta_africana,1,0,0',
    'Monodelphis_domestica,0,0,-1'].join('\n'),
];

// Synthetic gene family demonstrating domains, alignment, box plots, pies and connections.
function geneFamilyDemo() {
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const genes = ['KIN1A', 'KIN1B', 'KIN1C', 'KIN2A', 'KIN2B', 'KIN3A', 'KIN3B', 'KIN3C', 'KIN4A', 'KIN4B', 'KIN5', 'KIN6'];
  const newick = '((((KIN1A:0.08,KIN1B:0.11)98:0.06,KIN1C:0.19)91:0.12,(KIN2A:0.09,KIN2B:0.14)99:0.2)76:0.1,' +
    '(((KIN3A:0.05,KIN3B:0.07)100:0.04,KIN3C:0.15)88:0.18,(KIN4A:0.1,KIN4B:0.12)95:0.16)82:0.09,(KIN5:0.3,KIN6:0.34)64:0.12);';
  const AA = 'ACDEFGHIKLMNPQRSTVWY';
  const base = Array.from({ length: 90 }, () => AA[Math.floor(rnd() * 20)]).join('');
  const fasta = genes.map((g, i) => '>' + g + '\n' + [...base].map(c => {
    const r = rnd();
    return r < 0.04 + i * 0.012 ? AA[Math.floor(rnd() * 20)] : r > 0.985 ? '-' : c;
  }).join('')).join('\n');
  const sub = g => g.slice(0, 4);
  const subColor = { KIN1: '#4e79a7', KIN2: '#f28e2b', KIN3: '#59a14f', KIN4: '#b07aa1', KIN5: '#e15759', KIN6: '#9c755f' };
  const domains = genes.map((g, i) => {
    const len = 420 + Math.round(rnd() * 160);
    const parts = [`RE|${30 + i}|${290 + i}|#4e79a7|Kinase`];
    if (i % 3 !== 2) parts.push(`EL|${320 + i * 2}|${380 + i * 2}|#f28e2b|SH2`);
    if (i < 6) parts.push(`HH|${len - 60}|${len - 15}|#59a14f|Coiled coil`);
    if (i % 4 === 0) parts.push(`DI|5|22|#e15759|Signal`);
    return `${g},${len},${parts.join(',')}`;
  });
  const boxes = genes.map(g => {
    const m = 2 + rnd() * 6, q = 0.4 + rnd();
    return [g, (m - 2 * q).toFixed(2), (m - q / 2).toFixed(2), m.toFixed(2), (m + q / 2).toFixed(2), (m + 2 * q).toFixed(2), (m + 3 * q).toFixed(2)].join(',');
  });
  const pies = genes.map(g => `${g},-1,${(5 + rnd() * 10).toFixed(1)},${[0, 0, 0, 0].map(() => Math.round(rnd() * 10)).join(',')}`);
  return {
    name: 'Gene family (synthetic demo)', newick,
    annotations: [
      ['DATASET_COLORSTRIP', 'SEPARATOR COMMA', 'DATASET_LABEL,Subfamily', 'DATA', ...genes.map(g => `${g},${subColor[sub(g)]},${sub(g)}`)].join('\n'),
      ['DATASET_DOMAINS', 'SEPARATOR COMMA', 'DATASET_LABEL,Domain architecture (synthetic)', 'WIDTH,220', 'DATA', ...domains].join('\n'),
      ['DATASET_BOXPLOT', 'SEPARATOR COMMA', 'DATASET_LABEL,Expression (synthetic)', 'COLOR,#76b7b2', 'WIDTH,120', 'DATA', ...boxes].join('\n'),
      ['DATASET_PIECHART', 'SEPARATOR COMMA', 'DATASET_LABEL,Tissue share (synthetic)', 'FIELD_LABELS,brain,liver,muscle,skin',
        'FIELD_COLORS,#4e79a7,#e15759,#59a14f,#edc948', 'MAXIMUM_SIZE,9', 'DATA', ...pies].join('\n'),
      ['DATASET_CONNECTION', 'SEPARATOR COMMA', 'DATASET_LABEL,Interactions (synthetic)', 'DATA',
        'KIN1A,KIN3B,3,#e15759,normal,', 'KIN2A,KIN4B,2,#4e79a7,dashed,', 'KIN5,KIN1C,1,#59a14f,normal,'].join('\n'),
      ['DATASET_ALIGNMENT', 'SEPARATOR COMMA', 'DATASET_LABEL,Alignment (synthetic)', 'DATA', fasta].join('\n'),
    ],
  };
}

export const SAMPLES = [
  { name: 'Mammals (annotated demo)', newick: mammals, annotations: mammalAnnotations, settings: { italic: true } },
  geneFamilyDemo(),
  { name: 'Primates', newick: '((((Homo_sapiens:0.01,Pan_troglodytes:0.01)0.98:0.02,Gorilla_gorilla:0.03)1.00:0.04,Pongo_pygmaeus:0.07)0.95:0.1,Macaca_mulatta:0.17);' },
  { name: 'HSP90 (simulated)', newick: '((((HSP90AA1:0.0352,HSP90AA2:0.0213)0.94:0.1501,(HSP90AA3:0.0481,HSP90AA4:0.0123)0.78:0.0882)0.98:0.2103,(HSP90AA5:0.0094,HSP90AA6:0.0333)0.65:0.1193)1.00:0.05);' },
  { name: 'Small collagen tree', newick: '(((col-1:0.1,col-2:0.2)0.9:0.05,(col-3:0.3,col-4:0.4)0.95:0.1)0.8:0.2,col-5:0.5);' },
  { name: 'Random tree (500 leaves)', random: 500 },
  { name: 'Random tree (5,000 leaves)', random: 5000 },
];
