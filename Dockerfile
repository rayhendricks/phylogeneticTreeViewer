# Optional: image with the `localtree` command (the Nextflow module also works with plain node:22-slim
# when dist/localtree-cli.mjs is copied into the pipeline's bin/ folder).
FROM node:22-slim
COPY dist/localtree-cli.mjs /usr/local/bin/localtree
RUN chmod +x /usr/local/bin/localtree && localtree --version
