#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Calendry container entrypoint.
# Dispatches to web or worker based on the ENTRYPOINT env var.

case "${ENTRYPOINT:-web}" in
  web)
    echo "Starting Calendry web (Next.js)"
    # In a bun workspace build, Next.js standalone output nests the package path:
    # apps/web/.next/standalone/apps/web/server.js
    exec node apps/web/.next/standalone/apps/web/server.js
    ;;
  worker)
    echo "Starting Calendry worker"
    exec bun run apps/worker/index.ts
    ;;
  *)
    echo "Unknown ENTRYPOINT: ${ENTRYPOINT}. Use 'web' or 'worker'." >&2
    exit 1
    ;;
esac
