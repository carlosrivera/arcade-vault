#!/usr/bin/env bash
# Transpile the pipeline's TypeScript factory to browser-runnable JS.
#
# The repository is deliberately zero-build-step and img2threejs emits TypeScript, so
# rather than keep two hand-synced copies of the model the TS stays the single source of
# truth and this strips its types. Deno is already a dependency here (the chat backend),
# so no new toolchain is introduced.
#
# three and its addons stay EXTERNAL: the page resolves them through the site's import
# map to the vendored copy, so the bundle must not inline its own three.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
for entry in auricomBuild; do
  deno bundle --platform browser --format esm \
    --external 'three' --external 'three/*' \
    -o "dist/$entry.js" "src/$entry.ts"
done
# The generator writes bare 'three/examples/jsm/...'; the site publishes the same modules
# under 'three/addons/'. Rewrite here rather than widening the import map, so the vendored
# copy stays the only three the page can load.
python3 - <<'PY'
from pathlib import Path
for p in Path('dist').glob('*.js'):
    s = p.read_text()
    n = s.count('three/examples/jsm/')
    p.write_text(s.replace('three/examples/jsm/', 'three/addons/'))
    print(f'{p.name}: rewrote {n} addon specifiers')
PY
ls -l dist/*.js | awk '{printf "  %-34s %8d bytes\n", $NF, $5}'
