#!/usr/bin/env bash
#
# deploy.sh — one entry point for local dev and Vercel production deploys.
#
#   ./deploy.sh            # local hot-reload dev server (default)
#   ./deploy.sh dev        # same as above
#   ./deploy.sh prod       # build locally, then push to Vercel production
#   ./deploy.sh deploy     # alias for prod
#
# The project is already linked to Vercel via ./.vercel — no flags needed.
#
set -euo pipefail

# Always run from this script's directory (the site-piflow root).
cd "$(dirname "$0")"

mode="${1:-dev}"

case "$mode" in
  dev)
    echo "▸ refreshing docs index (public/llms.txt) …"
    npm run docs:index
    echo "▸ starting Next.js dev server — hot reload on http://localhost:3000"
    exec npm run dev
    ;;

  prod | deploy)
    command -v vercel >/dev/null 2>&1 || {
      echo "✗ vercel CLI not found. Install it with: npm i -g vercel" >&2
      exit 1
    }

    echo "▸ syncing Vercel project settings (production) …"
    vercel pull --yes --environment=production

    echo "▸ building production bundle locally …"
    vercel build --prod

    echo "▸ pushing prebuilt output to Vercel (production) …"
    vercel deploy --prebuilt --prod

    echo "✓ deployed."
    ;;

  *)
    echo "usage: ./deploy.sh [dev|prod]" >&2
    exit 1
    ;;
esac
