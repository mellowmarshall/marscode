#!/usr/bin/env bash
# The CI hosts' uv and its managed Python 3.12, for the toolchain in
# ci-hosts.json: Ubuntu 24.04 hosts have CPython 3.12.3 linked
# against system SQLite 3.45.1 while Ubuntu 26.04 and macOS hosts used uv's
# standalone CPython builds with newer SQLite, which named an EXPLAIN QUERY
# PLAN step differently. Every CI host runs the same pinned uv and the same
# python-build-standalone CPython 3.12 release (with its bundled SQLite), and
# CI steps export UV_PYTHON_PREFERENCE=only-managed (CI_PATH_SETUP) so uv
# never falls back to a host's /usr/bin/python3.
#
#   ci-uv.sh UV_VERSION linux-x64=SHA256 darwin-arm64=SHA256 \
#            python=PY_REL sqlite=SQLITE_VER \
#            python-linux-x64=SHA256 python-darwin-arm64=SHA256
#       UV_VERSION: MAJOR.MINOR.PATCH
#       PY_REL:     MAJOR.MINOR.PATCH+BUILD (python-build-standalone)
#       SQLITE_VER: MAJOR.MINOR.PATCH (the SQLite bundled in PY_REL)
#
# Each release and its sha256 come from the manifest's install line, never from
# here; each download is checked against it before anything is installed
# (ci-download.sh). uv unpacks into the host's data root,
# <data root>/ship-queue-ci/uv-<version>, switched with switch_to (keeping the
# current and previous build), and uv and uvx link into
# ~/.local/share/ship-queue-ci/bin and ~/.local/bin. CPython unpacks as a real
# directory, ~/.local/share/uv/python/cpython-<ver>-<key>, uv's own layout:
# under only-managed, uv accepts an interpreter only when its
# real sys.base_prefix lies in uv's Python directory, and CPython resolves
# symlinks to find its prefix, so a build linked in from the data root is
# "not managed" and uv recreates every project venv on every run.
# cpython-3.12-<key> is switched to it in one rename. The build it named
# before, when older, stays for one generation, so a running job keeps its
# stdlib; every other cpython-3.12.*-<key> entry is redirected to it, so
# existing virtual environments keep working. #838's data root copy
# (<data root>/ship-queue-ci/cpython-* and its link) is such a previous build.
set -euo pipefail

ci_tool_name="ci-uv"
# shellcheck source=ship-queue/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage="usage: ci-uv.sh UV_VERSION PLATFORM=SHA256... python=RELEASE sqlite=VERSION python-PLATFORM=SHA256..."

[ $# -ge 5 ] || { echo "$usage" >&2; exit 2; }
uv_rel=$1
shift
[[ "$uv_rel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$uv_rel' is not a uv release (MAJOR.MINOR.PATCH); nothing installed"
py_rel="" sqlite_ver=""
for a in "$@"; do
  case "$a" in
    python=*) py_rel=${a#python=} ;;
    sqlite=*) sqlite_ver=${a#sqlite=} ;;
    *=*) ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[[ "$py_rel" =~ ^([0-9]+\.[0-9]+)\.[0-9]+\+([0-9]{8})$ ]] || die "no python=MAJOR.MINOR.PATCH+BUILD in the manifest's install line; nothing installed"
py_minor=${BASH_REMATCH[1]} py_build=${BASH_REMATCH[2]} py_ver=${py_rel%%+*}
[[ "$sqlite_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no sqlite=MAJOR.MINOR.PATCH in the manifest's install line; nothing installed"
ci_store_init
plat=$(ci_platform) || exit 1
uv_sum=$(ci_sum_for "$plat" "$@") || exit 1
py_sum=$(ci_sum_for "python-$plat" "$@") || exit 1
case "$plat" in
  linux-x64) target=x86_64-unknown-linux-gnu uv_key=linux-x86_64-gnu ;;
  linux-arm64) target=aarch64-unknown-linux-gnu uv_key=linux-aarch64-gnu ;;
  darwin-arm64) target=aarch64-apple-darwin uv_key=macos-aarch64-none ;;
esac

d="" dp=""
trap 'for t in "$d" "$dp"; do [ -z "$t" ] || rm -rf "$t"; done' EXIT
uv_name="uv-$uv_rel" py_name="cpython-$py_rel"
uv_url="https://github.com/astral-sh/uv/releases/download/$uv_rel/uv-$target.tar.gz"
py_url="https://github.com/astral-sh/python-build-standalone/releases/download/$py_build/cpython-${py_rel/+/%2B}-$target-install_only_stripped.tar.gz"

uv_is() { [ -x "$1/uv" ] && [ -x "$1/uvx" ] && [ "$("$1/uv" --version 2>/dev/null | awk '{print $1, $2}')" = "uv $uv_rel" ]; }
py_is() { [ -x "$1" ] && [ "$("$1" -c 'import sys, sqlite3; print(sys.version.split()[0], sqlite3.sqlite_version)' 2>/dev/null)" = "$py_ver $sqlite_ver" ]; }

uv_py="$HOME/.local/share/uv/python"
uv_entry="cpython-$py_ver-$uv_key"
uv_minor="cpython-$py_minor-$uv_key"
mkdir -p "$store" "$uv_py"
# NAME: an entry of uv's directory that is a real install, not a link and not #838's directory of links.
real_py() { [ -n "$1" ] && [ -d "$uv_py/$1" ] && [ ! -L "$uv_py/$1" ] && [ ! -L "$uv_py/$1/bin" ]; }
# The build cpython-3.12-<key> named before this run, which a job that started before it may still run.
prev=$(readlink "$uv_py/$uv_minor" 2>/dev/null) || prev=""
prev=${prev##*/} prev_real=0
! real_py "$prev" || prev_real=1
# NAME: a cpython-3.12.N-<key> entry older than the pinned release. Only an older build is kept: uv takes the
# newest managed 3.12, so a newer one kept (a pin rolled back) would win.
older() { local n=${1#"cpython-$py_minor."}; n=${n%"-$uv_key"}; [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -lt "${py_ver##*.}" ]; }
need_uv=0 need_py=0
{ marked "$store/$uv_name" "$uv_sum" && uv_is "$store/$uv_name"; } || need_uv=1
{ real_py "$uv_entry" && marked "$uv_py/$uv_entry" "$py_sum" && py_is "$uv_py/$uv_entry/bin/python$py_minor"; } || need_py=1
# Both builds are fetched and checked before either is installed, so a bad one installs neither. The Python
# build unpacks beside its final place (one file system, so one rename puts it there).
if [ "$need_py" = 1 ]; then
  dp=$(mktemp -d "$uv_py/.$uv_entry.XXXXXX")
  chmod 0755 "$dp"
  ci_fetch "$py_url" "$py_sum" "$dp/py.tar.gz" || exit 1
  tar -xzf "$dp/py.tar.gz" -C "$dp"
  rm -f "$dp/py.tar.gz"
  printf '%s' "$py_build" > "$dp/python/BUILD"
  py_is "$dp/python/bin/python$py_minor" || die "the unpacked $py_name does not run as python $py_ver with sqlite $sqlite_ver; nothing installed"
  echo "$py_sum" > "$dp/python/$ci_mark"
fi
if [ "$need_uv" = 1 ]; then
  d=$(new_dir "$uv_name")
  ci_fetch "$uv_url" "$uv_sum" "$d/uv.tar.gz" || exit 1
  tar -xzf "$d/uv.tar.gz" -C "$d"
  rm -f "$d/uv.tar.gz"
  uv_is "$d/uv-$target" || die "the unpacked $uv_name does not run as uv $uv_rel; nothing installed"
  echo "$uv_sum" > "$d/uv-$target/$ci_mark"
  rm -rf "${store:?}/$uv_name"; mv "$d/uv-$target" "$store/$uv_name"
  rm -rf "$d"; d=""
fi
if [ "$need_py" = 1 ]; then
  # Two renames, so uv finds no interpreter only between them; what stood there (the same release) goes with $dp.
  if [ -e "$uv_py/$uv_entry" ] || [ -L "$uv_py/$uv_entry" ]; then mv "$uv_py/$uv_entry" "$dp/old"; fi
  if ! mv "$dp/python" "$uv_py/$uv_entry"; then
    [ ! -e "$dp/old" ] && [ ! -L "$dp/old" ] || mv "$dp/old" "$uv_py/$uv_entry"
    die "cannot move $py_name into $uv_py/$uv_entry; the entry there before is back"
  fi
  rm -rf "$dp"; dp=""
fi

mkdir -p "$bin" "$HOME/.local/bin"
switch_to uv "$store/$uv_name" "$ci/uv"
for b in uv uvx; do
  [ "$(readlink "$bin/$b" 2>/dev/null)" = "$ci/uv/$b" ] || swap_link "$ci/uv/$b" "$bin/$b"
  [ "$(readlink "$HOME/.local/bin/$b" 2>/dev/null)" = "$ci/uv/$b" ] || swap_link "$ci/uv/$b" "$HOME/.local/bin/$b"
done

# The previous build, when older, stays a real install for one generation (a running job keeps its stdlib), and
# a repeat install (the link named the current build already) removes no older real install, so the previous one
# survives it; every other cpython-3.12.*-<key> entry becomes a link to the current build.
[ "$(readlink "$uv_py/$uv_minor" 2>/dev/null)" = "$uv_py/$uv_entry" ] || swap_link "$uv_py/$uv_entry" "$uv_py/$uv_minor"
for o in "$uv_py/cpython-$py_minor".*-"$uv_key"; do
  [ -e "$o" ] || [ -L "$o" ] || continue
  n=${o##*/}
  [ "$n" = "$uv_entry" ] && continue
  if real_py "$n" && older "$n" && { [ "$n" = "$prev" ] || [ "$prev" = "$uv_entry" ]; }; then continue; fi
  [ "$(readlink "$o" 2>/dev/null)" = "$uv_py/$uv_entry" ] && continue
  rm -rf "$o"
  swap_link "$uv_py/$uv_entry" "$o"
done
find "$uv_py" -maxdepth 1 -name ".cpython-$py_minor.*-$uv_key.*" -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
# #838's layout, the build in the data root linked into uv's directory: on the switch from it, it is the previous
# build and stays; once the previous build is a real install, it goes.
if [ "$prev_real" = 1 ]; then
  rm -f "$ci/cpython-$py_minor"
  rm -rf "${store:?}"/cpython-"$py_minor".*+*
fi

found=$(UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_DOWNLOADS=never "$bin/uv" python find "$py_minor" 2>/dev/null) || found=""
py_is "$found" || die "uv python find $py_minor found '${found:-none}', not python $py_ver with sqlite $sqlite_ver"
base=$("$found" -c 'import sys; print(sys.base_prefix)' 2>/dev/null) || base=""
[ "$base" = "$(cd "$uv_py/$uv_entry" && pwd -P)" ] || die "python $py_ver's sys.base_prefix is '${base:-none}', outside $uv_py: uv would not count it as managed"
echo "installed uv: $("$bin/uv" --version) with python $py_ver (sqlite $sqlite_ver) in $store/$uv_name and $uv_py/$uv_entry"
