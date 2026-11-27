#!/usr/bin/env bash
# The CI hosts' Vite+ CLI (vp), for the toolchain in ci-hosts.json:
# marscode runs workspace install, lint, format,
# typecheck and tests through vp. Every CI host installs the same pinned
# release from voidzero-dev/vite-plus GitHub Releases, kept current by
# `ship-queue deps` through sq_pins.json. User-level, no sudo, and never the
# floating https://vite.plus installer script.
#
#   ci-vp.sh VP_VERSION linux-x64=SHA256 linux-arm64=SHA256 darwin-arm64=SHA256
#       VP_VERSION: MAJOR.MINOR.PATCH
#
# The release and its sha256 come from the manifest's install line, never from
# here; the download is checked against it before anything is installed
# (ci-download.sh). Both the unpacked release (<data root>/ship-queue-ci/vp-<version>)
# and Vite+'s own home (<data root>/ship-queue-ci/vite-plus, linked from
# ~/.local/share/ship-queue-ci/vite-plus) stay on the host's data root, never on
# / and never touching a desktop user's ~/.vite-plus or shell startup files
# (VP_HOME is always ~/.local/share/ship-queue-ci/vite-plus here and in
# CI_PATH_SETUP, and self-setup runs with a temporary HOME on the data root so
# Vite+ cannot edit ~/.bashrc, ~/.profile, ~/.zshenv or ~/.zshrc). Only vp, vpr
# and vpx are linked in ~/.local/share/ship-queue-ci/bin (never node or pnpm
# shims, so other repos keep ship-queue-ci's pinned Node and pnpm), and
# `vp env on` puts Vite+ in managed mode for Node and package managers.
set -euo pipefail

ci_tool_name="ci-vp"
# shellcheck source=ship-queue/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage="usage: ci-vp.sh VP_VERSION PLATFORM=SHA256..."

[ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
vp_rel=$1
shift
[[ "$vp_rel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$vp_rel' is not a vp release (MAJOR.MINOR.PATCH); nothing installed"
for a in "$@"; do case "$a" in *=*) ;; *) echo "$usage" >&2; exit 2 ;; esac; done
ci_store_init
plat=$(ci_platform) || exit 1
vp_sum=$(ci_sum_for "$plat" "$@") || exit 1
case "$plat" in
  linux-x64) target=x86_64-unknown-linux-gnu ;;
  linux-arm64) target=aarch64-unknown-linux-gnu ;;
  darwin-arm64) target=aarch64-apple-darwin ;;
esac

d="" setup_home=""
trap 'for t in "$d" "$setup_home"; do [ -z "$t" ] || rm -rf "$t"; done' EXIT
vp_name="vp-$vp_rel"
vp_url="https://github.com/voidzero-dev/vite-plus/releases/download/v$vp_rel/vp-$target.tar.gz"
vp_home_real="$store/vite-plus"

mkdir -p "$store" "$vp_home_real" "$ci" "$bin"
# If vp ran under CI_PATH_SETUP before ci-vp.sh ever ran, Vite+ created
# $ci/vite-plus as a real directory; replace it so swap_link succeeds.
if [ -d "$ci/vite-plus" ] && [ ! -L "$ci/vite-plus" ]; then
  rm -rf "$ci/vite-plus"
fi
for stale in "$ci"/vite-plus.next.[0-9]*; do
  [ -L "$stale" ] || [ -e "$stale" ] || continue
  kill -0 "${stale##*.}" 2>/dev/null || rm -f "$stale"
done
[ "$(readlink "$ci/vite-plus" 2>/dev/null)" = "$vp_home_real" ] || swap_link "$vp_home_real" "$ci/vite-plus"
vp_home="$ci/vite-plus"
# Record the version active before self-setup moves current, so upgrades keep
# current + previous and prune older vite-plus/<version> trees on the data root.
prev_vp_ver=$(readlink "$vp_home/current" 2>/dev/null || true)
setup_home=$(mktemp -d "$vp_home_real/.setup-home.XXXXXX")
chmod 0755 "$setup_home"

# Run vp with a throwaway HOME/ZDOTDIR/XDG_CONFIG_HOME on the data root while
# keeping VP_HOME at $ci/vite-plus so self-setup never edits the CI user's real
# shell startup files (~/.bashrc, ~/.profile, ~/.zshenv, ~/.zshrc, config.fish).
vp_run() {
  HOME="$setup_home" \
  ZDOTDIR="$setup_home" \
  XDG_CONFIG_HOME="$setup_home/.config" \
  XDG_DATA_HOME="$vp_home_real/xdg-data" \
  XDG_CACHE_HOME="$vp_home_real/xdg-cache" \
  npm_config_store_dir="$SHIP_QUEUE_DATA_ROOT/pnpm-store" \
  VP_HOME="$vp_home" \
    "$@"
}

# Read the whole version output before taking line 1: piping into head -1 can
# send SIGPIPE to vp under pipefail.
vp_first_line() {
  local o
  o=$(vp_run "$1" --version 2>/dev/null) || return 1
  printf '%s\n' "${o%%$'\n'*}"
}
vp_setup_done() {
  [ -f "$vp_home/$vp_rel/bin/.vp-setup-complete" ] && [ -f "$vp_home/$vp_rel/node_modules/.vp-install-complete" ]
}
vp_ready() {
  [ -x "$1/vp" ] && vp_setup_done && [ "$(vp_first_line "$1/vp")" = "vp v$vp_rel" ]
}

if ! { marked "$store/$vp_name" "$vp_sum" && vp_ready "$store/$vp_name"; }; then
  d=$(new_dir "$vp_name")
  ci_fetch "$vp_url" "$vp_sum" "$d/vp.tar.gz" || exit 1
  mkdir -p "$d/unpacked"
  tar -xzf "$d/vp.tar.gz" -C "$d/unpacked"
  rm -f "$d/vp.tar.gz"
  [ -x "$d/unpacked/vp" ] || die "the unpacked $vp_name has no executable vp; nothing installed"
  # Move into the final store path before running vp: Vite+ keys self-setup on
  # the binary's path, so staging first would run self-setup twice. On failure
  # the prior directory (if any) is put back before any link switches.
  if [ -e "$store/$vp_name" ] || [ -L "$store/$vp_name" ]; then mv "$store/$vp_name" "$d/old"; fi
  if ! mv "$d/unpacked" "$store/$vp_name"; then
    [ ! -e "$d/old" ] && [ ! -L "$d/old" ] || mv "$d/old" "$store/$vp_name"
    die "cannot move $vp_name into $store/$vp_name; the entry there before is back"
  fi
  if [ "$(vp_first_line "$store/$vp_name/vp")" != "vp v$vp_rel" ] || ! vp_setup_done; then
    rm -rf "${store:?}/$vp_name"
    [ ! -e "$d/old" ] && [ ! -L "$d/old" ] || mv "$d/old" "$store/$vp_name"
    [ -z "$prev_vp_ver" ] || swap_link "$prev_vp_ver" "$vp_home/current"
    die "the unpacked $vp_name does not run as vp v$vp_rel; nothing installed"
  fi
  echo "$vp_sum" > "$store/$vp_name/$ci_mark"
  rm -rf "$d"; d=""
fi

switch_to vp "$store/$vp_name" "$ci/vp"
[ "$(readlink "$vp_home/current" 2>/dev/null)" = "$vp_rel" ] || swap_link "$vp_rel" "$vp_home/current"
if [ "$prev_vp_ver" != "$vp_rel" ]; then
  for o in "$vp_home_real"/[0-9]*.[0-9]*.[0-9]*; do
    [ -d "$o" ] || continue
    case "${o##*/}" in "$vp_rel"|"$prev_vp_ver") ;; *) rm -rf "$o" ;; esac
  done
fi
for b in vp vpr vpx; do
  [ "$(readlink "$bin/$b" 2>/dev/null)" = "$ci/vp/vp" ] || swap_link "$ci/vp/vp" "$bin/$b"
done

vp_run "$bin/vp" env on >/dev/null
ci_py3 -c "import json, sys; c = json.load(open(sys.argv[1])); pm = c.get('packageManagerShimModes') or {}; sys.exit(0 if c.get('nodeShimMode', 'managed') == 'managed' and pm.get('pnpm') == 'managed' and pm.get('npm') == 'managed' else 1)" "$vp_home/config.json" ||
  die "vp env on did not enable managed mode for node, pnpm and npm in $vp_home/config.json"
vp_ready "$bin" || die "the installed $vp_name at $bin/vp does not run as vp v$vp_rel"
echo "installed vp: $(vp_first_line "$bin/vp") in $store/$vp_name"
