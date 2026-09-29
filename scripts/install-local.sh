#!/bin/sh
# Run from a trusted source checkout. Does not configure services or credentials.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24 or newer is required"); process.exit(1); }'
npm ci
npm run build
