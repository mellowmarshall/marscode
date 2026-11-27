#!/usr/bin/env bash
# The CI hosts' JDK and ktlint, for the toolchain in ci-hosts.json:
# the lifetasks native apps lint Kotlin with ktlint, which runs on a JDK, and no
# CI host had either. User-level, no sudo, and never a system package.
#
#   ci-jvm.sh jdk RELEASE linux-x64=SHA256 darwin-arm64=SHA256
#       Eclipse Temurin RELEASE (MAJOR.MINOR.PATCH+BUILD), the vendor's tarball for this
#       platform (Linux x86_64, WSL included, or macOS arm64)
#   ci-jvm.sh ktlint VERSION jar=SHA256
#       ktlint VERSION, the release's self-running jar (one file for every
#       platform; it runs the java on PATH, so the jdk tool comes first)
#
# The release and its sha256 come from the manifest's install line, never from
# here; each download is checked against it before anything is installed
# (ci-download.sh). Both go to the host's data root, $SHIP_QUEUE_DATA_ROOT
# (provision exports it): <data root>/ship-queue-ci/jdk-<release> and
# ktlint-<version>, each built in a temporary directory beside it and moved
# into place whole. ~/.local/share/ship-queue-ci/jdk links to the JDK's home
# (on macOS its Contents/Home), and java, javac and ktlint are links in
# ~/.local/share/ship-queue-ci/bin, on every CI step's PATH (CI_PATH_SETUP),
# never ~/.local/bin.
set -euo pipefail

ci_tool_name="ci-jvm"
# shellcheck source=ship-queue/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }

usage="usage: ci-jvm.sh jdk RELEASE PLATFORM=SHA256... | ci-jvm.sh ktlint VERSION jar=SHA256"
[ $# -ge 3 ] || { echo "$usage" >&2; exit 2; }
tool=$1 rel=$2
shift 2
for a in "$@"; do case "$a" in *=*) ;; *) echo "$usage" >&2; exit 2 ;; esac; done
ci_store_init
d=""
trap '[ -z "$d" ] || rm -rf "$d"' EXIT

jdk_is() { # JAVA VERSION: JAVA runs and reports VERSION (read whole: grep -q in a pipe could end java early, which pipefail counts)
  local o
  [ -x "$1" ] && o=$("$1" -version 2>&1) && grep -q " version \"$2\"" <<<"$o"
}

install_jdk() {
  [[ "$rel" =~ ^([0-9]+)\.[0-9]+\.[0-9]+(\.[0-9]+)?\+[0-9]+$ ]] || die "'$rel' is not a Temurin release (MAJOR.MINOR.PATCH+BUILD); nothing installed"
  local major=${BASH_REMATCH[1]} ver=${rel%%+*} plat sum arch home name url
  plat=$(ci_platform) || exit 1
  sum=$(ci_sum_for "$plat" "$@") || exit 1
  case "$plat" in
    linux-x64) arch=x64_linux home="" ;;
    linux-arm64) arch=aarch64_linux home="" ;;
    darwin-arm64) arch=aarch64_mac home=/Contents/Home ;;
  esac
  name="jdk-$rel"
  url="https://github.com/adoptium/temurin$major-binaries/releases/download/jdk-${rel/+/%2B}/OpenJDK${major}U-jdk_${arch}_hotspot_${rel/+/_}.tar.gz"
  mkdir -p "$store"
  if ! { marked "$store/$name" "$sum" && jdk_is "$store/$name$home/bin/java" "$ver"; }; then
    d=$(new_dir "$name")
    ci_fetch "$url" "$sum" "$d/dl.tar.gz" || exit 1
    tar -xzf "$d/dl.tar.gz" -C "$d"
    rm -f "$d/dl.tar.gz"
    jdk_is "$d/$name$home/bin/java" "$ver" || die "the unpacked $name does not run as java $ver; nothing installed"
    echo "$sum" > "$d/$name/$ci_mark"
    rm -rf "${store:?}/$name"
    mv "$d/$name" "$store/$name"
    rm -rf "$d"; d=""
  fi
  mkdir -p "$bin"
  switch_to jdk "$store/$name$home" "$ci/jdk"
  for b in java javac; do [ "$(readlink "$bin/$b" 2>/dev/null)" = "$ci/jdk/bin/$b" ] || swap_link "$ci/jdk/bin/$b" "$bin/$b"; done
  echo "installed jdk: $("$bin/java" -version 2>&1 | head -1) in $store/$name"
}

install_ktlint() {
  [[ "$rel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$rel' is not a ktlint release (MAJOR.MINOR.PATCH); nothing installed"
  local sum name="ktlint-$rel"
  sum=$(ci_sum_for jar "$@") || exit 1
  ktlint_is() { [ -x "$1" ] && [ "$("$1" --version 2>/dev/null | tail -1)" = "ktlint version $rel" ]; }
  mkdir -p "$store"
  if ! { marked "$store/$name" "$sum" && ktlint_is "$store/$name/ktlint"; }; then
    command -v java >/dev/null 2>&1 || die "ktlint runs on the java on PATH, and there is none: the jdk tool installs it first; nothing installed"
    d=$(new_dir "$name")
    ci_fetch "https://github.com/ktlint/ktlint/releases/download/$rel/ktlint" "$sum" "$d/ktlint" || exit 1
    chmod 0755 "$d/ktlint"
    ktlint_is "$d/ktlint" || die "the downloaded ktlint does not run as ktlint $rel on $(command -v java); nothing installed"
    echo "$sum" > "$d/$ci_mark"
    rm -rf "${store:?}/$name"
    mv "$d" "$store/$name"
    d=""
  fi
  mkdir -p "$bin"
  switch_to ktlint "$store/$name/ktlint" "$bin/ktlint"
  echo "installed ktlint: $("$bin/ktlint" --version 2>/dev/null | tail -1) in $store/$name"
}

case "$tool" in
  jdk) install_jdk "$@" ;;
  ktlint) install_ktlint "$@" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
