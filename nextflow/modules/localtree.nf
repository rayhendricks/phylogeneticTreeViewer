// LocalTree Nextflow module: per-family figures + interactive viewer, and a combined dashboard.
//
// Requires the `localtree` command on PATH. The simplest way: copy dist/localtree-cli.mjs to your
// pipeline's bin/ folder as `localtree` (Nextflow adds bin/ to PATH); then any image with Node 18+ works.

process LOCALTREE_RENDER {
    tag "${meta.id}"
    label 'process_single'
    container 'docker.io/library/node:22-slim'

    input:
    // meta: map with at least `id`; other keys become dashboard columns (e.g. species, expansion).
    tuple val(meta), path(tree), path(annotations, stageAs: 'annot/*')
    // Files added to every family, e.g. a gene-to-species table. Use [] for none.
    path(shared_annotations, stageAs: 'shared/*')

    output:
    tuple val(meta), path("${meta.id}.session.json"), emit: session
    tuple val(meta), path("${meta.id}.svg"),          emit: svg,  optional: true
    tuple val(meta), path("${meta.id}.html"),         emit: html, optional: true
    path "versions.yml",                              emit: versions

    script:
    def args   = task.ext.args ?: ''
    def files  = [annotations, shared_annotations].flatten().findAll { it }
    def annots = files.collect { "--annot '${it}'" }.join(' ')
    def extra  = meta.findAll { k, v -> k != 'id' && v != null }.collect { k, v -> "--meta '${k}=${v}'" }.join(' ')
    """
    localtree render \\
        --tree '${tree}' \\
        ${annots} \\
        --id '${meta.id}' --name '${meta.id}' \\
        ${extra} \\
        ${args} \\
        --out '${meta.id}'

    cat <<-END_VERSIONS > versions.yml
    "${task.process}":
        localtree: \$(localtree --version)
    END_VERSIONS
    """
}

process LOCALTREE_DASHBOARD {
    label 'process_single'
    container 'docker.io/library/node:22-slim'

    input:
    path(sessions, stageAs: 'sessions/*')

    output:
    path "localtree_dashboard", emit: dashboard
    path "versions.yml",        emit: versions

    script:
    def args = task.ext.args ?: ''
    """
    localtree dashboard --out localtree_dashboard ${args} sessions/*

    cat <<-END_VERSIONS > versions.yml
    "${task.process}":
        localtree: \$(localtree --version)
    END_VERSIONS
    """
}
