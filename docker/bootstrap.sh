#!/bin/sh
# Entrypoint of both n8n containers in docker-compose.yml.
# First start only: import the lab workflows and the apply workflow, publish
# the apply workflow. Everything else stays unpublished, the way workflows
# arrive from a Git pull. Later starts leave your changes alone.
set -eu

MARK=/home/node/.n8n/.activation-manifest-imported

if [ ! -f "$MARK" ]; then
  STAGE=$(mktemp -d)
  node /bootstrap/docker/prepare.mjs "$STAGE"
  n8n import:credentials --input="$STAGE/credentials.json"
  n8n import:workflow --separate --input="$STAGE/workflows"
  n8n publish:workflow --id=amApply000000001
  rm -rf "$STAGE"
  touch "$MARK"
  echo "activation-manifest: workflows imported"
fi

exec n8n start
