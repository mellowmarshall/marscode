#!/usr/bin/env bash
# install.sh: install sandbox-kit into a bin directory (private-repo).
#
# Usage: install.sh [BIN_DIR]       (default: $HOME/.local/bin)
#
# Copies the kit to BIN_DIR/../lib/sandbox-kit and links BIN_DIR/sandbox-kit to it.
# A reinstall replaces them. The tests and their fixture are not installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${1:-$HOME/.local/bin}"
install -d -m 0755 "$BIN_DIR"
LIB_DIR="$(cd "$BIN_DIR/.." && pwd)/lib/sandbox-kit"

if [ -e "$BIN_DIR/sandbox-kit" ] && [ ! -L "$BIN_DIR/sandbox-kit" ]; then
  printf 'sandbox-kit: refusing to replace %s/sandbox-kit, which is not a link this install made\n' "$BIN_DIR" >&2
  exit 1
fi
staged="$(mktemp -d "$BIN_DIR/../.sandbox-kit.XXXXXX")"
chmod 0755 "$staged"
trap 'rm -rf -- "$staged"' EXIT
for file in sandbox-kit sandbox-deploy.sh sandbox-edge.mjs sandbox_declaration.py sandbox_doppler.py; do
  install -m 0755 "$SCRIPT_DIR/$file" "$staged/$file"
done
install -d -m 0755 "$(dirname "$LIB_DIR")"
rm -rf -- "$LIB_DIR"
mv -T -- "$staged" "$LIB_DIR"
trap - EXIT
ln -sfn -- "$LIB_DIR/sandbox-kit" "$BIN_DIR/sandbox-kit"
printf 'Installed %s/sandbox-kit -> %s/sandbox-kit\n' "$BIN_DIR" "$LIB_DIR"
