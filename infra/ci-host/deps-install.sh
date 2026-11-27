#!/usr/bin/env bash
# One pinned Renovate install on the queue hub. Does not enable any repo.
set -euo pipefail
data_root="${SHIP_QUEUE_DATA_ROOT:-$HOME/.local/share/ship-queue-ci}"
runtime="$data_root/renovate-runtime"
version=44.236.5
mkdir -p "$runtime" "$HOME/.local/share/ship-queue-ci"
installed_version="$(node -e "const p = require('node:path'); try { process.stdout.write(require(p.join(process.argv[1], 'node_modules/renovate/package.json')).version); } catch {}" "$runtime")"
if [ "$installed_version" != "$version" ]; then
  npm install --prefix "$runtime" --ignore-scripts --no-audit --no-fund "renovate@$version"
  npm rebuild --prefix "$runtime" re2
fi
link="$HOME/.local/share/ship-queue-ci/renovate"
if [ -e "$link" ] || [ -L "$link" ]; then
  [ "$(readlink -f "$link")" = "$runtime" ] || { echo "Refusing to replace $link" >&2; exit 1; }
else
  ln -s "$runtime" "$link"
fi
"$runtime/node_modules/.bin/renovate" --version
