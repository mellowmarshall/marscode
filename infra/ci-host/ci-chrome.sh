#!/usr/bin/env bash
# The CI hosts' Google Chrome and their hardware-GPU probe, for the toolchain
# in ci-hosts.json. A repo's browser gate runs in Google
# Chrome (Playwright's channel "chrome", for its codecs) and needs a real GPU;
# the CI users of the worker hosts have no root, so Chrome is installed at
# user level, as the queue's other tools are.
#
#   ci-chrome.sh install signed-by=FINGERPRINT
#       the CURRENT stable Google Chrome for Linux (x86_64, WSL included, or
#       aarch64), from
#       Google's own apt repository, unpacked at user level. No root, and no
#       pinned version: a pinned browser stays on a release with known
#       security defects. Every provision runs it (the manifest's refresh), so
#       a host moves to the newer stable when there is one.
#   ci-chrome.sh gpu
#       the probe of the hardware-gpu tool: exit 0 and `hardware` when the
#       google-chrome on PATH, headless, gets a real GPU for WebGL by one of
#       the GPU paths below; exit 1, with the renderer on stderr, when every
#       path gives a software renderer (llvmpipe, SwiftShader) or none. It
#       records the host's path (see THE HOST'S GPU PATH). A record that
#       says hardware=1, under 6 h old, of the same Chrome build is the
#       answer, and nothing starts (on a loaded WSL host Chrome
#       took 35 s to render the probe's page, past the probe's limits).
#   ci-chrome.sh measure-gpu
#       the same, but always measures.
#   ci-chrome.sh renderer [CHROME]
#       the WebGL renderer string CHROME gets by the host's recorded path
#       (the first path below when none is recorded), on stdout
#
# THE HOST'S GPU PATH. How a browser reaches the hardware GPU
# depends on the host, not on the repo: a native Linux host has a Vulkan
# driver for its GPU; WSL has none (its Vulkan is llvmpipe, software) and
# reaches the GPU through Mesa's d3d12 driver and /dev/dxg, as OpenGL ES over
# EGL. So the host says, and a repo reads it. The probe tries the paths in
# GPU_PATHS in their order (the recorded path first), and the first that gives a real GPU
# of that path's own kind is the host's (a Vulkan path must give a Vulkan
# renderer, the D3D12 path a D3D12 one: the EGL arguments on a native host
# give its OpenGL driver, which is not that path). It is written to
# ~/.local/share/ship-queue-ci/chrome-gpu (path, args, env, renderer,
# hardware). While the record says hardware=1, every CI step on that host gets
#   SHIP_QUEUE_CHROME_GPU_ARGS  the Chrome arguments of that path
#   SHIP_QUEUE_CHROME_GPU_ENV   NAME=VALUE words for the browser's environment
# from it (ci_tool_env_sh, ship-queue-hygiene.sh); with no path that works the
# record says hardware=0 and a step gets neither. The record is a file of the
# CI user's, which any job on the host could write: the step environment
# takes from it only Chrome switches (--name=value words) and GALLIUM_* or
# MESA_* variables, and nothing from it is ever run. The environment words are
# for the browser only, never exported to the whole step: GALLIUM_DRIVER
# would change every other GL program of the step. The probe measures with
# the same arguments and environment a gate then uses, so hardware-gpu says
# what a gate will get. A repo adds its own --enable-gpu, --enable-webgl and
# --ignore-gpu-blocklist; it must not name an ANGLE backend itself (Chrome
# takes the last --use-angle, so a repo's own after the host's would win).
#
# AUTHENTICITY WITHOUT A PINNED VERSION. What is fixed is who signs, not what
# is signed: FINGERPRINT, in the manifest's install line, is the fingerprint
# of Google's Linux package signing key (its primary key; Google signs with
# subkeys that it rotates). Each install, over HTTPS from dl.google.com:
#   1. the key file (linux_signing_key.pub) is taken into a keyring of this
#      run only, and refused unless FINGERPRINT is a primary key in it;
#   2. the repository's Release file must carry a good signature (Release.gpg)
#      made under FINGERPRINT's key, whatever else the key file holds, by a
#      subkey that is not expired and not revoked (gpg exits 0 for both, so
#      its status lines are read);
#   3. the package list (Packages) must have the sha256 the Release names;
#   4. the list names the current google-chrome-stable: its version, its file
#      and its sha256, and the downloaded package must have that sha256.
# The newest google-chrome-stable the list names is taken, and never one
# older than the build this host already has: an old, validly signed list
# (a stale server, a replay) does not move a host back.
# Nothing is installed when any step fails. gpg is on every Ubuntu host (apt
# needs it); a host without it installs nothing and says so.
#
# The package goes to the host's data root, <data root>/ship-queue-ci/
# google-chrome-<version>, built in a temporary directory beside it and moved
# into place whole; the previous build stays for a job that still runs it.
# ~/.local/share/ship-queue-ci/google-chrome links to its opt/google/chrome
# (the stable path a repo's Playwright config names as executablePath: the
# channel "chrome" looks only in /opt/google/chrome), and google-chrome is a
# command in ~/.local/share/ship-queue-ci/bin, on every CI step's PATH.
#
# THE CI'S OWN CHROME, ON EVERY LINUX HOST. A host that also has Chrome as a
# system package (the queue host: its desktop user's own browser, kept
# current by the system's updater) gets the user-level copy too:
# the CI's browser is then the same on every host and does not follow a
# desktop's. The system package is not changed, removed or shadowed: the
# google-chrome and google-chrome-stable commands are in ship-queue-ci/bin,
# which only the CI steps' PATH has (CI_PATH_SETUP), before /usr/bin there; a login shell's PATH and the
# desktop launcher do not have it, and still reach /usr/bin/google-chrome.
#
# NEVER THE DESKTOP PROFILE. Chrome started with no --user-data-dir opens the
# user's own profile (~/.config/google-chrome), and when that user's browser
# is running it hands the request to it; it does the same when it cannot make
# the directory it is given. So the google-chrome and google-chrome-stable
# commands the CI gets refuse to start unless the last --user-data-dir=DIR
# (before any --) is an absolute directory that exists or can be made, and is
# not the desktop profile, by whatever path names it: the directory is
# resolved (dot components, links) before it is compared.
# Version and help answer without one. Playwright
# always gives a browser a temporary profile directory, and so does the probe
# here. A step that starts /opt/google/chrome/chrome by its own path, on a
# host that has the system package, is outside this rule.
#
# Chrome also keeps a crash-report store in its config home
# (~/.config/google-chrome/Crash Reports) even when it is given a profile
# directory. So every CI step gets CHROME_CONFIG_HOME, the CI's own
# (~/.local/share/ship-queue-ci/chrome-config; ci_tool_env_sh,
# ship-queue-hygiene.sh), and the commands here set it too: whatever a step
# starts, by any path, the desktop user's ~/.config/google-chrome is not
# written, and a Chrome with no usable profile lands in the CI's own.
#
# NO SANDBOX. Chrome's setuid sandbox needs root and is not installed, and
# Ubuntu allows the unprivileged namespace sandbox only to /opt/google/chrome.
# So a user-level Chrome starts only with --no-sandbox. Playwright passes it
# by default, and the probe here does; a gate that starts Chrome another way
# (Puppeteer, Lighthouse) must pass it itself.
set -euo pipefail

ci_tool_name="ci-chrome"
# shellcheck source=ship-queue/ci-download.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage="usage: ci-chrome.sh install signed-by=FINGERPRINT | ci-chrome.sh gpu|measure-gpu | ci-chrome.sh renderer [CHROME]"
REPO=https://dl.google.com/linux/chrome/deb
KEY_URL=https://dl.google.com/linux/linux_signing_key.pub

# What every GPU path has. A repo's gate passes these itself.
GPU_BASE=(--enable-gpu --enable-webgl --ignore-gpu-blocklist)
# The GPU paths, tried in this order: NAME|ARGUMENTS|ENVIRONMENT|RENDERER (words, no blank inside a word;
# RENDERER: text the path's own renderer string holds, so one path is never taken for another).
#   vulkan  a native Linux host with a Vulkan driver for its GPU
#   d3d12   WSL: Mesa's d3d12 driver through EGL (OpenGL ES 3.1, WebGL 2); no Vulkan driver there
GPU_PATHS=(
  'vulkan|--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface||Vulkan'
  'd3d12|--use-gl=angle --use-angle=gl-egl|GALLIUM_DRIVER=d3d12|D3D12'
)
# WSL's GPU device: a host that has it reaches its GPU by d3d12, never by Vulkan.
# The tests name another device and budget, honoured only under DEVTOOLS_INSTALL_SANDBOX=1.
GPU_WSL_DEVICE=/dev/dxg
# A page that writes the renderer WebGL reports, unmasked when the browser gives it.
GPU_PAGE='data:text/html,<script>var c=document.createElement("canvas"),g=c.getContext("webgl"),e=g&&g.getExtension("WEBGL_debug_renderer_info");document.title="x";document.write("<p id=r>WEBGL_RENDERER{"+(g?g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER):"none")+"}</p>")</script>'

d=""
trap '[ -z "$d" ] || rm -rf "$d"' EXIT

chrome_is() { # CHROME VERSION
  local o
  [ -x "$1" ] && o=$("$1" --version 2>/dev/null) && [ "${o% }" = "Google Chrome $2" ]
}

# The shared libraries CHROME needs that this host does not have, one per line.
chrome_missing_libs() { { ldd "$1" 2>/dev/null || true; } | awk '/not found/ { print $1 }' | sort -u; }

# URL OUT: an unpinned file of the vendor's (the key, the Release, the
# package list), over HTTPS only, or from a test's mirror under the rule of
# ci-download.sh. What it holds is judged by the steps above, not here.
chrome_get() {
  if [ -n "${SHIP_QUEUE_CI_MIRROR:-}" ]; then
    ci_mirror_ok || return 1
    curl -fsSL --connect-timeout 20 --max-time 300 --retry 2 -o "$2" "${SHIP_QUEUE_CI_MIRROR%/}/${1#https://}" || { ci_say "cannot download $1 from the test's mirror; nothing installed"; return 1; }
  else
    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --retry 2 -o "$2" "$1" || { ci_say "cannot download $1; nothing installed"; return 1; }
  fi
}

# The google-chrome and google-chrome-stable commands of the CI steps' PATH,
# in $bin (tools look for either name): the browser itself, behind the rule
# of NEVER THE DESKTOP PROFILE. It starts the chrome executable, not the
# package's own launcher script, which makes desktop files in the user's
# home on every start. Written whole and renamed into place (a rename never
# follows an older link there); left alone when it is already this text.
chrome_command() {
  local text exe cfg name
  # The executable's place and the CI's Chrome config home, as single-quoted words of sh: whatever the home's path holds.
  exe="$ci/google-chrome/chrome"; exe="'${exe//\'/\'\\\'\'}'"
  cfg="$ci/chrome-config"; cfg="'${cfg//\'/\'\\\'\'}'"
  text="#!/bin/sh
# Google Chrome for ship-queue CI steps (devtools ship-queue/ci-chrome.sh). Never the desktop profile:
# Chrome with no usable --user-data-dir opens the user's own profile, or the browser that user has running.
# Chrome keeps a crash-report store in its config home even when it is given a profile directory: the CI's own,
# never ~/.config/google-chrome. The same place is where a start with no usable profile would land.
CHROME_CONFIG_HOME=$cfg CHROME_VERSION_EXTRA=stable; export CHROME_CONFIG_HOME CHROME_VERSION_EXTRA
no() { echo \"google-chrome (ship-queue CI): refusing to start: \$1. Give --user-data-dir=DIR, an absolute directory that exists or can be made, and not the desktop profile\" >&2; exit 64; }
dir= given=0 info=0
for a in \"\$@\"; do
  case \"\$a\" in
    --) break ;;
    --user-data-dir=*) dir=\${a#--user-data-dir=} given=1 ;;
    --version|--product-version|--help) info=1 ;;
  esac
done
[ \"\$info\" = 0 ] || exec $exe \"\$@\"
[ \"\$given\" = 1 ] || no \"no --user-data-dir (before any --)\"
# Chrome takes the last one, and falls back to the default profile when it cannot make the directory.
case \"\$dir\" in /*) ;; *) no \"--user-data-dir='\$dir' is not an absolute directory\" ;; esac
parent=\${dir%/*}; [ -n \"\$parent\" ] || parent=/
{ [ -d \"\$dir\" ] && [ -w \"\$dir\" ]; } || { [ ! -e \"\$dir\" ] && [ -d \"\$parent\" ] && [ -w \"\$parent\" ]; } || no \"--user-data-dir=\$dir is not a directory this user can write or make\"
# Compared after it is resolved (dot components, links): a path can name the desktop profile without its text.
real=\$(readlink -f -- \"\$dir\" 2>/dev/null) || no \"--user-data-dir=\$dir cannot be resolved\"
for own in \"\$HOME/.config/google-chrome\" \"\$HOME/.config/chromium\"; do
  ownreal=\$(readlink -f -- \"\$own\" 2>/dev/null) || ownreal=\$own
  case \"\$real/\" in \"\$own\"/*|\"\$ownreal\"/*) no \"--user-data-dir=\$dir is the desktop user's own profile (\$real)\" ;; esac
done
exec $exe \"\$@\""
  for name in google-chrome google-chrome-stable; do
    [ ! -L "$bin/$name" ] && [ "$(cat "$bin/$name" 2>/dev/null)" = "$text" ] && [ -x "$bin/$name" ] && continue
    printf '%s\n' "$text" > "$bin/.$name.next.$$"
    chmod 0755 "$bin/.$name.next.$$"
    mv -f "$bin/.$name.next.$$" "$bin/$name"
  done
}

# Steps 1 to 4 of AUTHENTICITY: sets cur_ver, cur_file and cur_sum from the
# signed package list. WORK is this run's scratch.
current_stable() { # FINGERPRINT WORK
  local fpr=$1 w=$2 keys status want have
  command -v gpg >/dev/null 2>&1 || die "no gpg on this host: the repository's signature cannot be checked; nothing installed"
  mkdir -m 0700 "$w/gnupg"
  chrome_get "$KEY_URL" "$w/key.pub" || exit 1
  gpg --homedir "$w/gnupg" --batch --no-autostart --quiet --import "$w/key.pub" 2>/dev/null || die "the vendor's key file cannot be read as a key; nothing installed"
  keys=$(gpg --homedir "$w/gnupg" --batch --no-autostart --with-colons --fingerprint 2>/dev/null | awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; want = 0 }' | sort -u)
  grep -qx "$fpr" <<<"$keys" || die "the vendor's key file holds $(tr '\n' ' ' <<<"${keys:-no key}"), not the key the manifest trusts ($fpr); nothing installed"
  chrome_get "$REPO/dists/stable/Release" "$w/Release" || exit 1
  chrome_get "$REPO/dists/stable/Release.gpg" "$w/Release.gpg" || exit 1
  status=$(gpg --homedir "$w/gnupg" --batch --no-autostart --status-fd 1 --verify "$w/Release.gpg" "$w/Release" 2>/dev/null) ||
    die "the repository's Release has no good signature of the trusted key; nothing installed"
  # gpg exits 0 for a signature by an expired or a revoked key too, and says so only in its status lines.
  ! grep -qE '^\[GNUPG:\] (EXPKEYSIG|REVKEYSIG|EXPSIG|BADSIG|ERRSIG) ' <<<"$status" && grep -q '^\[GNUPG:\] GOODSIG ' <<<"$status" ||
    die "the repository's Release is signed by an expired or revoked key, or its signature is not good; nothing installed"
  # VALIDSIG's last field is the primary key of the key that signed: the trusted one, whatever else the key file holds.
  grep -qE "^\[GNUPG:\] VALIDSIG .* $fpr\$" <<<"$status" || die "the repository's Release is not signed under the trusted key $fpr; nothing installed"
  want=$(awk -v list="main/binary-$deb_arch/Packages" '/^SHA256:/ { s = 1; next } /^[^ ]/ { s = 0 } s && $3 == list { print $1 }' "$w/Release")
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "the signed Release names no sha256 for the package list; nothing installed"
  chrome_get "$REPO/dists/stable/main/binary-$deb_arch/Packages" "$w/Packages" || exit 1
  have=$(ci_sha256 "$w/Packages")
  [ "$have" = "$want" ] || die "the package list has sha256 $have, not the $want the signed Release names; nothing installed"
  # Each google-chrome-stable stanza with all three fields, as "VERSION FILE SHA256"; the newest one is the current stable.
  local newest
  newest=$(awk '
    function out() { if (p && v != "" && f != "" && h != "") print v, f, h; p = 0; v = f = h = "" }
    /^$/ { out(); next }
    /^Package: / { p = ($2 == "google-chrome-stable") }
    /^Version: / { v = $2 } /^Filename: / { f = $2 } /^SHA256: / { h = $2 }
    END { out() }' "$w/Packages" | sort -V | tail -1)
  read -r cur_ver cur_file cur_sum <<<"$newest" || true
  cur_ver=${cur_ver%-*}
  [[ "$cur_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$cur_sum" =~ ^[0-9a-f]{64}$ ]] &&
    [[ "$cur_file" =~ ^pool/main/g/google-chrome-stable/google-chrome-stable_[0-9.]+-[0-9]+_${deb_arch}\.deb$ ]] ||
    die "the signed package list names no usable google-chrome-stable (version '$cur_ver', file '$cur_file'); nothing installed"
}

# The repository's name for the host's processor: amd64, or arm64.
cur_ver="" cur_file="" cur_sum="" deb_arch=amd64
install_chrome() { # signed-by=FINGERPRINT
  local fpr plat name lacks
  fpr=${1#signed-by=}
  [ "$1" != "$fpr" ] && [[ "$fpr" =~ ^[0-9A-F]{40}$ ]] || die "no signing key fingerprint (signed-by=40 hex digits) in the manifest's install line; nothing installed"
  plat=$(ci_platform) || exit 1
  case "$plat" in
    linux-x64) deb_arch=amd64 ;;
    linux-arm64) deb_arch=arm64 ;;
    *) die "this installs Chrome for Linux; on $(uname -s) Chrome is not provisioned (the tool is for Linux hosts)" ;;
  esac
  ci_store_init
  mkdir -p "$store"
  d=$(new_dir google-chrome)
  current_stable "$fpr" "$d"
  name="google-chrome-$cur_ver"
  # Never back: the build this host has is not replaced by an older one.
  local have_ver; have_ver=$({ readlink "$ci/google-chrome" 2>/dev/null || true; } | sed -n 's#.*/google-chrome-\([0-9.]*\)/opt/google/chrome$#\1#p')
  if [ -n "$have_ver" ] && [ "$have_ver" != "$cur_ver" ] && [ "$(printf '%s\n%s\n' "$have_ver" "$cur_ver" | sort -V | tail -1)" = "$have_ver" ] && [ -x "$ci/google-chrome/chrome" ]; then
    rm -rf "$d"; d=""
    echo "google-chrome stays at $have_ver: the repository names $cur_ver, an older release (a stale or replayed list); nothing installed"
    return 0
  fi
  if ! { marked "$store/$name" "$cur_sum" && chrome_is "$store/$name/opt/google/chrome/chrome" "$cur_ver"; }; then
    ci_fetch "https://dl.google.com/linux/chrome/deb/$cur_file" "$cur_sum" "$d/chrome.deb" || exit 1
    mkdir "$d/$name"
    # Unpacked, never installed: dpkg-deb reads the package's files out with no
    # root and no package database (it is on every Debian and Ubuntu host).
    command -v dpkg-deb >/dev/null 2>&1 || die "no dpkg-deb on this host to unpack the package; nothing installed"
    dpkg-deb -x "$d/chrome.deb" "$d/$name" || die "the package cannot be unpacked; nothing installed"
    rm -f "$d/chrome.deb"
    lacks=$(chrome_missing_libs "$d/$name/opt/google/chrome/chrome")
    [ -z "$lacks" ] || die "this host lacks shared libraries Chrome needs, which only an admin can install: $(tr '\n' ' ' <<<"$lacks"); nothing installed"
    chrome_is "$d/$name/opt/google/chrome/chrome" "$cur_ver" || die "the unpacked package does not run as Google Chrome $cur_ver; nothing installed"
    echo "$cur_sum" > "$d/$name/$ci_mark"
    # Another provision may have put the same build there meanwhile, and a job
    # may run it already: then that one stays, and this copy goes with the scratch.
    if ! { marked "$store/$name" "$cur_sum" && chrome_is "$store/$name/opt/google/chrome/chrome" "$cur_ver"; }; then
      rm -rf "${store:?}/$name"
      mv "$d/$name" "$store/$name"
    fi
  fi
  rm -rf "$d"; d=""
  mkdir -p "$bin"
  switch_to google-chrome "$store/$name/opt/google/chrome" "$ci/google-chrome"
  chrome_command
  echo "installed google-chrome: $("$bin/google-chrome" --version) (the current stable) in $store/$name (executable: $ci/google-chrome/chrome)"
}

# The host's record of its GPU path (THE HOST'S GPU PATH).
gpu_record() { echo "$HOME/.local/share/ship-queue-ci/chrome-gpu"; }
gpu_recorded() { [ -r "$(gpu_record)" ] || return 0; sed -n "s/^$1=//p" "$(gpu_record)" | head -1; } # FIELD: empty when there is no record

# The WebGL renderer CHROME gets, headless, by one GPU path.
renderer_by() { # ARGUMENTS ENVIRONMENT [CHROME] [SECONDS] -> the renderer, `none`, or `timeout` (no answer in SECONDS)
  local chrome=${3:-google-chrome} limit=${4:-10} out rc=0
  local -a args=() envs=()
  local w
  read -r -a args <<<"$1"; read -r -a envs <<<"$2"
  # Only Chrome switches and driver variables: the record these may come from is a file any job could write.
  for w in ${args[@]+"${args[@]}"}; do [[ "$w" =~ ^--[a-z][A-Za-z0-9=,._-]*$ ]] || die "'$w' is not a Chrome switch; nothing started"; done
  for w in ${envs[@]+"${envs[@]}"}; do [[ "$w" =~ ^(GALLIUM|MESA)_[A-Z0-9_]+=[A-Za-z0-9,._-]*$ ]] || die "'$w' is not a GALLIUM_ or MESA_ variable; nothing started"; done
  command -v "$chrome" >/dev/null 2>&1 || die "no $chrome on PATH"
  d=$(mktemp -d "${TMPDIR:-/tmp}/ci-chrome-gpu.XXXXXX")
  # -k: a browser that does not end on TERM is killed, never left behind by the probe (gpu_probe keeps every
  # path's SECONDS + 2 inside GPU_BUDGET_S).
  out=$(env ${envs[@]+"${envs[@]}"} timeout -k 2 "$limit" "$chrome" --headless=new --no-sandbox --no-first-run --user-data-dir="$d" "${GPU_BASE[@]}" ${args[@]+"${args[@]}"} --dump-dom "$GPU_PAGE" 2>/dev/null) || rc=$?
  rm -rf "$d"; d=""
  # The page's own text holds the template too: the written result is the last match.
  out=$(grep -o 'WEBGL_RENDERER{[^}]*}' <<<"$out" | tail -1 || true)
  out=${out#WEBGL_RENDERER\{}; out=${out%\}}
  case "$out" in
    ""|'"+('*) if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then echo timeout; else echo none; fi ;;
    *) echo "$out" ;;
  esac
}

# The fields of one GPU_PATHS entry, in p_name, p_args, p_env and p_mark.
gpu_path() { IFS='|' read -r p_name p_args p_env p_mark <<<"$1"; } # ENTRY

# The renderer by the host's recorded path while it holds (hardware=1); else by the first path.
renderer() { # [CHROME]
  if [ "$(gpu_recorded hardware)" = 1 ]; then renderer_by "$(gpu_recorded args)" "$(gpu_recorded env)" "${1:-}"
  else gpu_path "${GPU_PATHS[0]}"; renderer_by "$p_args" "$p_env" "${1:-}"; fi
}

# 0 for a real GPU. A software renderer names itself.
hardware() { # RENDERER
  case "$1" in
    none|*llvmpipe*|*SwiftShader*|*softpipe*|*[Ss]oftware*|*"Basic Render"*|*lavapipe*) return 1 ;;
    *) return 0 ;;
  esac
}

# The record, whole or not at all, and left alone when it would not change.
# The Chrome build a record was measured with, read before measuring: another build is measured again.
chrome_build() { timeout -k 1 5 google-chrome --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1 || true; }
# A record older than this is measured again, whatever it says: a job can write it (THE HOST'S GPU PATH).
RECORD_MAX_AGE_S=21600
# A record of hardware=1 that a loaded host could not measure (every path out of time) stands this long at most.
RECORD_STAND_S=86400
# The seconds all paths share, each with its 2 s kill, with the version read: inside the hosts check's 30 s per probe (ship-queue-hosts.sh), with room for a loaded host's start.
GPU_BUDGET_S=25
if [ "${DEVTOOLS_INSTALL_SANDBOX:-}" = 1 ]; then
  GPU_WSL_DEVICE=${CI_CHROME_WSL_DEVICE:-$GPU_WSL_DEVICE} GPU_BUDGET_S=${CI_CHROME_GPU_BUDGET_S:-$GPU_BUDGET_S}
fi
build=""
gpu_write() { # NAME ARGUMENTS ENVIRONMENT RENDERER HARDWARE(1|0)
  local f text; f=$(gpu_record)
  text=$(printf 'path=%s\nargs=%s\nenv=%s\nrenderer=%s\nhardware=%s\nbuild=%s\n' "$@" "$build")
  # The same text: its time is renewed, as a fresh measurement.
  if [ "$(cat "$f" 2>/dev/null)" = "$text" ]; then touch "$f"; return 0; fi
  mkdir -p "${f%/*}" && printf '%s\n' "$text" > "$f.next.$$" && mv -f "$f.next.$$" "$f"
}

# The probe: the host's GPU path, found and recorded. A fresh record that says
# hardware=1 for this Chrome build answers, with no browser started. Else the
# recorded path is tried first, then the others in their order. With no path that gives a real GPU of its own
# kind, and with no google-chrome at all, the record keeps the first path,
# marked hardware=0, so no step gets arguments for a path that does not work,
# and the probe fails.
gpu_probe() { # [measure]
  local p r first_r=none f age rec_path paths=() answered=0 start=$SECONDS left limit
  if command -v google-chrome >/dev/null 2>&1; then
    build=$(chrome_build)
    f=$(gpu_record); rec_path=$(gpu_recorded path)
    age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
    # A record dated in the future (a job can set its time) is not fresh.
    if [ "${1:-}" != measure ] && [ -n "$build" ] && [ "$age" -ge 0 ] && [ "$age" -lt "$RECORD_MAX_AGE_S" ] \
      && [ "$(gpu_recorded hardware)" = 1 ] && [ "$(gpu_recorded build)" = "$build" ]; then
      echo hardware; return 0
    fi
    # The path tried first, with most of the budget (on a loaded WSL host Chrome took 35 s to render the page):
    # the one that last worked; with none, on WSL (/dev/dxg: no Vulkan driver for its GPU) d3d12; else the recorded one.
    if [ "$(gpu_recorded hardware)" != 1 ] && [ -e "$GPU_WSL_DEVICE" ]; then rec_path=d3d12; fi
    for p in "${GPU_PATHS[@]}"; do [ "${p%%|*}" != "$rec_path" ] || paths=("$p"); done
    for p in "${GPU_PATHS[@]}"; do [ "${p%%|*}" = "$rec_path" ] || paths+=("$p"); done
    for p in "${paths[@]}"; do
      gpu_path "$p"
      # The first path: all of the budget but its kill; a later one: 10 s, or what is left. Under 3 s, none is tried.
      left=$(( GPU_BUDGET_S - (SECONDS - start) - 2 ))
      if [ "$p" = "${paths[0]}" ]; then limit=$left; else limit=$(( left < 10 ? left : 10 )); fi
      if [ "$limit" -lt 3 ]; then r=timeout; else r=$(renderer_by "$p_args" "$p_env" google-chrome "$limit"); fi
      if hardware "$r" && [[ "$r" == *"$p_mark"* ]]; then gpu_write "$p_name" "$p_args" "$p_env" "$r" 1; echo hardware; return 0; fi
      [ "$r" = timeout ] || answered=1
      [ "$p" != "${paths[0]}" ] || first_r=$r
    done
    # No path answered in its time (a loaded host): nothing was measured, which is not a software
    # renderer, nor a browser that ended with no renderer. A record that says hardware=1 for this build, measured
    # within RECORD_STAND_S, stays the answer, unchanged (its age is not renewed).
    if [ "$answered" = 0 ] && [ -n "$build" ] && [ "$age" -ge 0 ] && [ "$age" -lt "$RECORD_STAND_S" ] \
      && [ "$(gpu_recorded hardware)" = 1 ] && [ "$(gpu_recorded build)" = "$build" ]; then
      ci_say "google-chrome answered by no path in its time (a loaded host?): the record of $(gpu_recorded path) stands"
      echo hardware; return 0
    fi
  else first_r="no google-chrome on PATH"
  fi
  # A failed measurement keeps the recorded path (hardware=0: no step gets it), so the next one tries it first again.
  gpu_path "${paths[0]:-${GPU_PATHS[0]}}"
  gpu_write "$p_name" "$p_args" "$p_env" "$first_r" 0
  ci_say "google-chrome gets no hardware GPU for WebGL by any path (${GPU_PATHS[*]%%|*}): $p_name gives $first_r"
  return 1
}

case "${1:-}" in
  install) [ $# -eq 2 ] || { echo "$usage" >&2; exit 2; }; install_chrome "$2" ;;
  renderer) renderer "${2:-}" ;;
  gpu) gpu_probe ;;
  measure-gpu) gpu_probe measure ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
