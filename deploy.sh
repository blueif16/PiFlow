#!/usr/bin/env bash
#
# deploy.sh — run the site-piflow deploy script from the repo root.
#
#   ./deploy.sh            # local hot-reload dev server (default)
#   ./deploy.sh prod       # build locally, then push to Vercel production
#
# Thin forwarder; the real logic lives in site-piflow/deploy.sh.
#
set -euo pipefail
exec "$(dirname "$0")/site-piflow/deploy.sh" "$@"
