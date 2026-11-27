# shellcheck shell=bash
# The pinned download and store switching of the native-tool installs,
# ci-jvm.sh, ci-rust.sh, ci-uv.sh and ci-vp.sh (private-repo, #821, #1371), sourced by each.
# Bash 3.2 (a Mac CI host's /bin/bash).
#
#   ci_platform                 linux-x64 (Linux x86_64, WSL included),
#                               linux-arm64 (Linux aarch64: a Linux machine on
#                               a Mac, private-repo) or darwin-arm64 (macOS
#                               arm64); 1 on any other
#   ci_fetch URL SHA256 OUT     download the vendor's HTTPS URL to OUT and keep
#                               it only when its sha256 is SHA256
#   ci_store_init               check SHIP_QUEUE_DATA_ROOT and set store, ci, bin
#   new_dir NAME                temporary build directory in $store/.NAME.XXXXXX
#   marked DIR SHA256           0 when DIR/.ship-queue-sha256 holds SHA256
#   swap_link TARGET LINK       point LINK to TARGET in one rename
#   switch_to TOOL TARGET LINK  point LINK to TARGET in $store and keep only
#                               the current and previous TOOL-* builds
#
# Bounded: 20 s to connect, 30 minutes for the whole download (a JDK is 190 MB).
# Only HTTPS, redirects included: the pin is a vendor release, never a mirror.
# A test serves its fixtures from a local server instead (SHIP_QUEUE_CI_MIRROR,
# a URL that stands in for "https://", so https://github.com/a/b is fetched as
# MIRROR/github.com/a/b), and only in a test's sandbox: DEVTOOLS_INSTALL_SANDBOX=1
# with a HOME that is not the account's own. Anywhere else the mirror is refused,
# and nothing is installed.

ci_say() { echo "${ci_tool_name:-ci}: $*" >&2; }

ci_py3() {
  if command -v python3 >/dev/null 2>&1 && python3 -c '' 2>/dev/null; then python3 "$@"; else /usr/bin/python3 "$@"; fi
}

ci_platform() {
  case "$(uname -sm)" in
    "Linux x86_64") echo linux-x64 ;;
    "Linux aarch64") echo linux-arm64 ;;
    "Darwin arm64") echo darwin-arm64 ;;
    *) ci_say "no pinned build for $(uname -sm)"; return 1 ;;
  esac
}

ci_sha256() { # FILE
  local s
  if command -v sha256sum >/dev/null 2>&1; then s=$(sha256sum "$1"); else s=$(shasum -a 256 "$1"); fi
  echo "${s%% *}"
}

# KEY ARGS...: the SHA256 of the KEY=SHA256 argument; 1 when there is none or it is malformed.
ci_sum_for() {
  local key=$1 a s=""
  shift
  for a in "$@"; do case "$a" in "$key="*) s=${a#*=} ;; esac; done
  [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { ci_say "no sha256 for $key in the manifest's install line; nothing installed"; return 1; }
  echo "$s"
}

# 0 when the mirror may be used: a test's sandbox, whose HOME is not the account's.
ci_mirror_ok() {
  local home acct
  if [ "${DEVTOOLS_INSTALL_SANDBOX:-}" = 1 ]; then
    home=$(cd "$HOME" 2>/dev/null && pwd -P) || home=$HOME
    acct=$(ci_py3 -c 'import os, pwd; print(os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir))' 2>/dev/null) || acct=""
    [ -n "$acct" ] && [ "$home" != "$acct" ] && return 0
  fi
  ci_say "SHIP_QUEUE_CI_MIRROR is a test's: it needs DEVTOOLS_INSTALL_SANDBOX=1 and a HOME of its own; refusing, nothing installed"
  return 1
}

ci_fetch() { # URL SHA256 OUT
  local url=$1 want=$2 out=$3 have
  case "$url" in https://*) ;; *) ci_say "$url is not an HTTPS URL; nothing installed"; return 1 ;; esac
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { ci_say "no sha256 pinned for $url; nothing installed"; return 1; }
  if [ -n "${SHIP_QUEUE_CI_MIRROR:-}" ]; then
    ci_mirror_ok || return 1
    curl -fsSL --connect-timeout 20 --max-time 1800 --retry 2 -o "$out" "${SHIP_QUEUE_CI_MIRROR%/}/${url#https://}" || { ci_say "cannot download $url from the test's mirror; nothing installed"; return 1; }
  else
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 1800 --retry 2 -o "$out" "$url" || { ci_say "cannot download $url; nothing installed"; return 1; }
  fi
  have=$(ci_sha256 "$out")
  [ "$have" = "$want" ] || { rm -f "$out"; ci_say "$url has sha256 $have, not the pinned $want; nothing installed"; return 1; }
}

ci_mark=.ship-queue-sha256
store="" ci="" bin=""
ci_store_init() {
  local root=${SHIP_QUEUE_DATA_ROOT:-}
  case "$root" in /?*) ;; *) ci_say "SHIP_QUEUE_DATA_ROOT ('$root') is not an absolute directory: provision exports the host's data root; nothing installed"; exit 1 ;; esac
  # shellcheck disable=SC2034 # read by ci-jvm.sh, ci-uv.sh and ci-vp.sh
  store="$root/ship-queue-ci" ci="$HOME/.local/share/ship-queue-ci" bin="$ci/bin"
}
# BUILD-DIR: the temporary directory a build is made in, beside its final place.
new_dir() { local d; d=$(mktemp -d "$store/.$1.XXXXXX"); chmod 0755 "$d"; echo "$d"; }
# BUILD SHA256: BUILD records that it came from the archive with SHA256.
marked() { [ "$(cat "$1/$ci_mark" 2>/dev/null)" = "$2" ]; }
# TARGET LINK: LINK names TARGET, switched in one rename (os.replace never
# follows LINK into a directory, on Linux and macOS alike).
swap_link() {
  ln -sfn "$1" "$2.next.$$"
  ci_py3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$2.next.$$" "$2"
}
# LINK: the store build LINK names now, by its name (none: empty).
build_of() { local t; t=$(readlink "$1" 2>/dev/null) || return 0; t=${t#"$store"/}; [ "$t" = "$(readlink "$1")" ] || echo "${t%%/*}"; }
# TOOL TARGET LINK: switch LINK to TARGET (one of TOOL's builds). Only when
# the link really changes are old builds removed: all but TARGET's build and
# the build LINK named until now, the previous distinct one, which a job that
# started before the switch may still run. A repeat install (the link already
# names TARGET) removes no build, so the previous one survives it. Two
# provisions of one release at once both read the same previous build and
# both keep it. Then the tool's temporary directories more than a day old go.
switch_to() {
  local cur prev o
  if [ "$(readlink "$3" 2>/dev/null)" != "$2" ]; then
    cur=${2#"$store"/}; cur=${cur%%/*}
    prev=$(build_of "$3")
    swap_link "$2" "$3"
    for o in "$store/$1"-*; do
      [ -e "$o" ] || continue
      case "${o##*/}" in "$cur"|"$prev") ;; *) rm -rf "$o" ;; esac
    done
  fi
  find "$store" -maxdepth 1 -name ".$1-*" -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
}
