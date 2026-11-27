#!/usr/bin/env bash
# The CI hosts' Node, for the toolchain in ci-hosts.json (private-repo).
#
#   ci-node.sh PLATFORM=SHA256...   install the manifest's Node release in
#                                   ~/.local/share/ship-queue-ci
#   ci-node.sh real-node            print the provisioned node when the host
#                                   guards' node shim should move to it (the
#                                   provision's guards step passes it as
#                                   --real-node); print nothing otherwise
#
# The release is read from ci-hosts.json beside this script, never written
# here: toolchain.node's range is ">=X.Y.Z", and X.Y.Z is both the floor every
# host is held to and the build installed. The manifest's install line gives the
# release's sha256 per platform (linux-x64 for Linux x86_64, WSL included;
# linux-arm64 for Linux aarch64; darwin-arm64 for macOS arm64), from the release's own SHASUMS256.txt; the
# download is checked against it before anything is installed, so a range
# raised without its sums installs nothing. Each build has its own
# node-v<version>-<platform> directory; the `node` link there switches to the
# new one (the CI PATH's last directory) and ~/.local/bin gets node, npm and npx
# links only where it has none.
#
# A CI step finds node in ~/.local/bin first, and on every CI host that is the
# host guards' shim, which runs the REAL_NODE its install recorded (a resolved,
# versioned path). The guards' install keeps that record, so a new build alone
# never reaches the shim: `real-node` names the provisioned build when the
# recorded node is older than it or is gone, and only then. A recorded node at
# or above the build (an nvm Node the owner keeps current) stays.
set -euo pipefail

t="$HOME/.local/share/ship-queue-ci"

# vA.B.C vX.Y.Z: true when the first is older
older() {
  local a b i IFS=.
  read -r -a a <<<"${1#v}"; read -r -a b <<<"${2#v}"
  for i in 0 1 2; do
    a[i]=${a[i]//[!0-9]/}; b[i]=${b[i]//[!0-9]/}
    [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 0
    [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 1
  done
  return 1
}

real_node() {
  local p="$t/node/bin/node" rec pv rv
  pv=$("$p" --version 2>/dev/null) || return 0
  rec=$(LC_ALL=C sed -n "s/^REAL_NODE='\\(.*\\)'\$/\\1/p" "$HOME/.local/bin/node" 2>/dev/null) || true
  # No shim yet: the guards' install finds node itself.
  [ -n "$rec" ] || return 0
  if ! rv=$("$rec" --version 2>/dev/null) || older "$rv" "$pv"; then echo "$p"; fi
}

if [ "${1:-}" = real-node ]; then real_node; exit 0; fi
case "$(uname -sm)" in
  "Linux x86_64") plat=linux-x64 ;;
  "Linux aarch64") plat=linux-arm64 ;;
  "Darwin arm64") plat=darwin-arm64 ;;
  *) echo "ci-node: no Node build for $(uname -sm)" >&2; exit 1 ;;
esac
sum=""
for arg in "$@"; do
  case "$arg" in
    "$plat="*) sum=${arg#*=} ;;
    *=*) ;;
    *) echo "usage: ci-node.sh PLATFORM=SHA256... | real-node" >&2; exit 2 ;;
  esac
done
[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || { echo "ci-node: no sha256 for $plat in the manifest's install line; nothing installed" >&2; exit 1; }
range=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["toolchain"]["node"]["version"])' "$(dirname "${BASH_SOURCE[0]}")/ci-hosts.json")
[[ "$range" =~ ^\>=([0-9]+\.[0-9]+\.[0-9]+)$ ]] || { echo "ci-node: the manifest's node range '$range' names no release (>=X.Y.Z); nothing installed" >&2; exit 1; }
v=${BASH_REMATCH[1]}
n="node-v$v-$plat"
mkdir -p "$t" "$HOME/.local/bin"
if [ "$("$t/$n/bin/node" --version 2>/dev/null)" != "v$v" ]; then
  d=$(mktemp -d "$t/.$n.XXXXXX")
  trap 'rm -rf "$d"' EXIT
  curl -fsSL --retry 2 -o "$d/dl.tar.xz" "https://nodejs.org/dist/v$v/$n.tar.xz"
  if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$d/dl.tar.xz"); else have=$(shasum -a 256 "$d/dl.tar.xz"); fi
  [ "${have%% *}" = "$sum" ] || { echo "ci-node: $n.tar.xz has sha256 ${have%% *}, not the pinned $sum; nothing installed" >&2; exit 1; }
  tar -xJf "$d/dl.tar.xz" -C "$d"
  [ "$("$d/$n/bin/node" --version)" = "v$v" ] || { echo "ci-node: the unpacked $n does not run as v$v; nothing installed" >&2; exit 1; }
  rm -rf "${t:?}/$n"
  mv "$d/$n" "$t/$n"
fi
ln -sfn "$t/$n" "$t/node"
for b in node npm npx; do [ -e "$HOME/.local/bin/$b" ] || ln -s "$t/node/bin/$b" "$HOME/.local/bin/$b"; done
echo "installed node: $("$t/node/bin/node" --version) in $t/$n"
