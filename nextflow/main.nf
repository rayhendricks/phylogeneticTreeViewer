#!/usr/bin/env nextflow
// Example: render every gene family tree with its annotations, then build one dashboard.
//
//   nextflow run nextflow/main.nf --trees 'results/trees/*.treefile' \
//       --annotations 'results/annot/*' --species species.tsv --outdir localtree_out
//
// Annotation files are matched to a family when their name starts with the family id
// (e.g. OG0000123.aln.fasta, OG0000123.domains.txt for OG0000123.treefile).

include { LOCALTREE_RENDER; LOCALTREE_DASHBOARD } from './modules/localtree.nf'

params.trees       = null
params.annotations = null
params.species     = null      // optional table added to every family (e.g. gene -> species)
params.outdir      = 'localtree_out'
params.title       = 'Gene families'

workflow {
    if (!params.trees) error "Set --trees, e.g. --trees 'trees/*.treefile'"

    trees = Channel.fromPath(params.trees, checkIfExists: true)
        .map { f -> [f.name.tokenize('.')[0], f] }

    annots = params.annotations
        ? Channel.fromPath(params.annotations).map { f -> [f.name.tokenize('.')[0], f] }.groupTuple()
        : Channel.empty()

    families = trees
        .join(annots, remainder: true)
        .filter { id, tree, files -> tree != null }
        .map { id, tree, files -> [[id: id], tree, files ?: []] }

    shared = params.species ? file(params.species, checkIfExists: true) : []

    LOCALTREE_RENDER(families, shared)
    LOCALTREE_DASHBOARD(LOCALTREE_RENDER.out.session.map { meta, f -> f }.collect())
}
