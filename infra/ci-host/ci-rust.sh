#!/usr/bin/env bash
# The CI hosts' Rust, for the toolchain in ci-hosts.json (private-repo): a
# repo's rust-toolchain.toml pins a release with its components, and its CI
# sets RUSTUP_AUTO_INSTALL=0, so a host must hold that release before a job
# comes (the manifest's rust tool). The cargo tool is the same pinned release
# with no components, the host's default only where it has none (never the
# floating stable channel). Provision installs both here, as the CI user,
# through rustup; the manifest's probes only look (and never let rustup install).
#
#   ci-rust.sh TOOLCHAIN COMPONENT... rustup=VERSION TARGET=SHA256...
#       TOOLCHAIN: a release, MAJOR.MINOR.PATCH
#
# First rustup itself: a host whose rustup is older than VERSION (or has none)
# gets rustup-init VERSION for its target (x86_64-unknown-linux-gnu for Linux
# x86_64, WSL included; aarch64-apple-darwin for macOS arm64), from
# static.rust-lang.org's archive, checked against the manifest's sha256 for
# that target (the archive's own rustup-init.sha256) before it runs. It
# updates rustup in place in ~/.cargo and keeps the toolchains and the default
# there (--default-toolchain none); rustup-init saves its own profile, so the
# host's saved profile (`rustup show profile`) is read first and set back after
# it. Then the toolchain, with the
# minimal profile and each COMPONENT, never a rustup self-update (rustup
# update would fetch the newest rustup, unpinned); a host with no default
# toolchain gets this one as its default. Never the sh.rustup.rs script. Bash 3.2.
set -euo pipefail
# Off for the whole script: even `rustup --version` installs a missing active
# toolchain (a rust-toolchain.toml where it runs) when this is on. The explicit
# `rustup toolchain install` below is not an install on use, so it still runs.
export RUSTUP_AUTO_INSTALL=0

ci_tool_name="ci-rust"
# shellcheck source=ship-queue/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage() { echo "usage: ci-rust.sh TOOLCHAIN COMPONENT... rustup=VERSION TARGET=SHA256..." >&2; exit 2; }

# A.B.C X.Y.Z: true when the first is older
older() {
  local a b i IFS=.
  read -r -a a <<<"$1"; read -r -a b <<<"$2"
  for i in 0 1 2; do
    a[i]=${a[i]//[!0-9]/}; b[i]=${b[i]//[!0-9]/}
    [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 0
    [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 1
  done
  return 1
}

[ $# -ge 1 ] || usage
tc=$1
shift
[[ "$tc" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$tc' is not a Rust release (MAJOR.MINOR.PATCH); nothing installed"
rv="" comps="" sums=""
for a in "$@"; do
  case "$a" in
    rustup=*) rv=${a#rustup=} ;;
    *=*) sums="$sums $a" ;;
    *) [[ "$a" =~ ^[a-z][a-z0-9-]*$ ]] || usage; comps="$comps $a" ;;
  esac
done
[[ "$rv" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no rustup=VERSION in the manifest's install line; nothing installed"
case "$(ci_platform)" in
  linux-x64) target=x86_64-unknown-linux-gnu ;;
  linux-arm64) target=aarch64-unknown-linux-gnu ;;
  darwin-arm64) target=aarch64-apple-darwin ;;
  *) exit 1 ;;
esac

have=$(rustup --version 2>/dev/null | sed -n '1s/^rustup \([0-9][0-9.]*\).*/\1/p') || have=""
if [ -z "$have" ] || older "$have" "$rv"; then
  # shellcheck disable=SC2086 # the TARGET=SHA256 words
  sum=$(ci_sum_for "$target" $sums) || exit 1
  d=$(mktemp -d)
  trap 'rm -rf "$d"' EXIT
  ci_fetch "https://static.rust-lang.org/rustup/archive/$rv/$target/rustup-init" "$sum" "$d/rustup-init" || exit 1
  chmod 0755 "$d/rustup-init"
  profile=""
  [ -z "$have" ] || profile=$(rustup show profile 2>/dev/null) || profile=""
  "$d/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  hash -r
  # rustup-init saved "minimal" as the profile: the host's own comes back.
  [ -z "$profile" ] || rustup set profile "$profile"
  now=$(rustup --version 2>/dev/null | sed -n '1s/^rustup \([0-9][0-9.]*\).*/\1/p') || now=""
  [ -n "$now" ] && ! older "$now" "$rv" || die "rustup is ${now:-missing} on PATH after rustup-init $rv ($(command -v rustup || echo none)); the toolchain was not installed"
fi

set --
for c in $comps; do set -- "$@" --component "$c"; done
rustup toolchain install "$tc" --profile minimal --no-self-update "$@"
rustup default >/dev/null 2>&1 || rustup default "$tc"
# Judged as the probe judges it (installs are off).
installed=$(rustup component list --installed --toolchain "$tc")
for c in $comps; do
  grep -qE "^$c(-|\$)" <<<"$installed" || die "toolchain $tc has no $c after the install"
done
echo "installed rust: $(rustc "+$tc" --version) with${comps:- no components}; $(rustup --version 2>/dev/null | head -1)"
