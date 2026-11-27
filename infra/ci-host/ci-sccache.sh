#!/usr/bin/env bash
# The CI hosts' sccache, for the toolchain in ci-hosts.json (marscode#61):
# shares compiled Rust artifacts across ephemeral /data worktrees without
# coupling builds to a single target/ directory. Every CI host installs the
# same pinned release from mozilla/sccache GitHub Releases, kept current by
# `ship-queue deps` through sq_pins.json. User-level, no sudo.
#
#   ci-sccache.sh SCCACHE_VERSION linux-x64=SHA256 linux-arm64=SHA256 darwin-arm64=SHA256
#       SCCACHE_VERSION: MAJOR.MINOR.PATCH
#
# The release and its sha256 come from the manifest's install line, never from
# here; the download is checked against it before anything is installed
# (ci-download.sh). sccache unpacks into the host's data root,
# <data root>/ship-queue-ci/sccache-<version>, switched with switch_to
# (keeping the current and previous build), and links into
# ~/.local/share/ship-queue-ci/bin and ~/.local/bin.
set -euo pipefail

ci_tool_name="ci-sccache"
# shellcheck source=infra/ci-host/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage="usage: ci-sccache.sh SCCACHE_VERSION PLATFORM=SHA256..."

[ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
sc_rel=$1
shift
[[ "$sc_rel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$sc_rel' is not an sccache release (MAJOR.MINOR.PATCH); nothing installed"
for a in "$@"; do case "$a" in *=*) ;; *) echo "$usage" >&2; exit 2 ;; esac; done
ci_store_init
plat=$(ci_platform) || exit 1
sc_sum=$(ci_sum_for "$plat" "$@") || exit 1
case "$plat" in
  linux-x64) target=x86_64-unknown-linux-musl ;;
  linux-arm64) target=aarch64-unknown-linux-musl ;;
  darwin-arm64) target=aarch64-apple-darwin ;;
esac

d=""
trap '[ -z "$d" ] || rm -rf "$d"' EXIT
sc_name="sccache-$sc_rel"
sc_dir="sccache-v$sc_rel-$target"
sc_url="https://github.com/mozilla/sccache/releases/download/v$sc_rel/$sc_dir.tar.gz"

sc_is() { [ -x "$1/sccache" ] && [ "$("$1/sccache" --version 2>/dev/null | awk '{print $1, $2}')" = "sccache $sc_rel" ]; }

mkdir -p "$store" "$bin" "$HOME/.local/bin"
if ! { marked "$store/$sc_name" "$sc_sum" && sc_is "$store/$sc_name"; }; then
  d=$(new_dir "$sc_name")
  ci_fetch "$sc_url" "$sc_sum" "$d/sccache.tar.gz" || exit 1
  tar -xzf "$d/sccache.tar.gz" -C "$d"
  rm -f "$d/sccache.tar.gz"
  sc_is "$d/$sc_dir" || die "the unpacked $sc_name does not run as sccache $sc_rel; nothing installed"
  echo "$sc_sum" > "$d/$sc_dir/$ci_mark"
  rm -rf "${store:?}/$sc_name"
  mv "$d/$sc_dir" "$store/$sc_name"
  rm -rf "$d"; d=""
fi

switch_to sccache "$store/$sc_name" "$ci/sccache"
[ "$(readlink "$bin/sccache" 2>/dev/null)" = "$ci/sccache/sccache" ] || swap_link "$ci/sccache/sccache" "$bin/sccache"
[ "$(readlink "$HOME/.local/bin/sccache" 2>/dev/null)" = "$ci/sccache/sccache" ] || swap_link "$ci/sccache/sccache" "$HOME/.local/bin/sccache"
sc_is "$bin" || die "the installed $sc_name at $bin/sccache does not run as sccache $sc_rel"
echo "installed sccache: $("$bin/sccache" --version) in $store/$sc_name"
