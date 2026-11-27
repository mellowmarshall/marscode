#!/usr/bin/env bash
# The CI hosts' Playwright and its browsers, for the toolchain in ci-hosts.json:
# always npm's latest stable release, never a pinned one. An old
# Playwright keeps an old browser build, and an old browser carries the CVEs
# fixed after it.
#
#   ci-playwright.sh install BROWSER   install npm's latest stable playwright-core
#                                      (its `latest` dist-tag) in
#                                      ~/.local/share/ship-queue-ci/npm when the
#                                      one there is older, then BROWSER's build for it
#   ci-playwright.sh latest            print npm's latest stable playwright-core
#
# BROWSER is chromium or webkit:
# - chromium (with its headless shell and ffmpeg) goes to Playwright's default
#   cache (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on
#   macOS), where a repo's own Playwright and a repo that drives the newest build
#   there (lifetasks' tests/browser) find it.
# - webkit goes to ship-queue-ci/ms-playwright, where devdeck's design check
#   finds it (devdeck/design/checkEngine.mjs).
#
# A build counts only when Playwright marked it complete and its host check
# passed; an install that leaves one without both fails, naming the admin's
# step. Each install runs with Playwright's browser GC on: Playwright deletes each
# build in that cache that no live install references, so the build an older
# playwright-core wanted goes once nothing uses it. ci-hosts.json marks both
# tools `refresh`, so every provision runs this, and a host moves to a new
# stable release at its next provision. npm checks the package's registry
# integrity; Playwright downloads its own builds.
set -euo pipefail

t="$HOME/.local/share/ship-queue-ci"
p="$t/npm/lib/node_modules/playwright-core"

die() { echo "ci-playwright: $*" >&2; exit 1; }

# A.B.C X.Y.Z: true when the first is older
older() {
  local a b i IFS=.
  read -r -a a <<<"${1%%[!0-9.]*}"; read -r -a b <<<"${2%%[!0-9.]*}"
  for i in 0 1 2; do
    [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 0
    [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 1
  done
  return 1
}

latest() {
  local v
  v=$(npm view playwright-core@latest version 2>/dev/null) || die "npm cannot name playwright-core's latest release"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "npm's latest playwright-core is '$v', not a stable release"
  echo "$v"
}

installed() { [ -f "$p/package.json" ] && node -p "require('$p/package.json').version" 2>/dev/null; }

# The install locations of BROWSER's builds, one per line, from Playwright's dry run.
locations() { # BROWSER
  if [ "$1" = chromium ]; then env -u PLAYWRIGHT_BROWSERS_PATH node "$p/cli.js" install --dry-run chromium
  else PLAYWRIGHT_BROWSERS_PATH="$t/ms-playwright" node "$p/cli.js" install --dry-run webkit; fi 2>/dev/null | sed -n 's/^ *Install location: *//p'
}

# A cache folder that is missing behind a link (7c56 keeps its caches on /data,
# linked from ~/.cache) is made where the links lead: Playwright cannot make it
# through a link to a folder that is gone.
cache_ready() {
  local dir
  dir=$(locations chromium)
  dir=${dir%%$'\n'*}
  [ -n "$dir" ] || die "playwright-core $(installed) names no chromium install location"
  dir=$(dirname "$dir")
  [ -d "$dir" ] || mkdir -p -- "$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$dir")"
}

# Every build BROWSER needs is in place: Playwright wrote INSTALLATION_COMPLETE
# after its download and DEPENDENCIES_VALIDATED after its host check passed.
# The ci-hosts.json probes check the same two markers.
complete() { # BROWSER
  local l
  l=$(locations "$1")
  [ -n "$l" ] && printf '%s\n' "$l" | xargs -I{} sh -c 'test -f "$1/INSTALLATION_COMPLETE" && test -f "$1/DEPENDENCIES_VALIDATED"' _ {}
}

install() {
  local want have
  case "${1:-}" in chromium | webkit) ;; *) die "usage: ci-playwright.sh install chromium|webkit" ;; esac
  want=$(latest)
  have=$(installed) || have=""
  if [ -z "$have" ] || older "$have" "$want"; then
    npm install -g --prefix "$t/npm" "playwright-core@$want"
  fi
  if [ "$1" = chromium ]; then
    cache_ready
    env -u PLAYWRIGHT_BROWSERS_PATH -u PLAYWRIGHT_SKIP_BROWSER_GC node "$p/cli.js" install chromium
  else
    env -u PLAYWRIGHT_SKIP_BROWSER_GC PLAYWRIGHT_BROWSERS_PATH="$t/ms-playwright" node "$p/cli.js" install webkit
  fi
  complete "$1" || die "playwright-core $(installed) has no complete $1 build: Playwright's host check found a system library missing, which an admin installs (as root: npx playwright-core@$(installed) install-deps $1)"
}

case "${1:-}" in
  install) shift; install "$@" ;;
  latest) latest ;;
  *) die "usage: ci-playwright.sh install chromium|webkit | latest" ;;
esac
