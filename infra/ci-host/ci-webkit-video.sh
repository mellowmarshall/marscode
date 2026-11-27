#!/usr/bin/env bash
# The CI hosts' WebKit video probe, for the webkit-video tool in ci-hosts.json.
# A repo's browser gate plays video in Playwright's WebKit
# and reads the frames WebKit presented (getVideoPlaybackQuality); this says
# whether headless WebKit on this host presents decoded H.264 frames, and
# records how.
#
#   ci-webkit-video.sh probe
#       exit 0 and `presents` when headless WebKit (the CI's own playwright-core
#       and its WebKit build) presents frames of a short H.264 clip by one of
#       the VIDEO_PATHS below; exit 1, with the reason on stderr, when none
#       does. It records the host's path (see THE HOST'S VIDEO PATH).
#
#   ci-webkit-video.sh measure
#       the same, but always measures: a fresh record is not the answer.
#
# WHAT WEBKIT NEEDS (measured on a Linux WSL host with a discrete NVIDIA GPU, 2026-11-12):
#   1. The GStreamer GL plugin (gstreamer1.0-gl). WebKit takes its GL video
#      path only when the plugin is there; without it, it falls back to a
#      software sink that presents at most a few frames and then holds the
#      pipeline paused (a film's time may go on with its audio, but no new
#      frame is shown). Playwright's `install-deps webkit` does not install the
#      plugin, so it is this tool's root grant.
#   2. A decoder whose frames WebKit's GL path can draw. GStreamer's NVIDIA
#      decoders (nvh264dec and the rest, in gstreamer1.0-plugins-bad) load
#      WSL's CUDA (libnvcuvid, /usr/lib/wsl/lib) and outrank the software
#      decoder, but on WSL CUDA cannot share its frames with GL: WebKit gets
#      CUDA memory it cannot draw, and presents nothing (measured at 720p and
#      1080p; at 640x360 the frames still pass, so the probe plays a 1080p
#      clip, the size of a film). With those decoders
#      out of the selection (GST_PLUGIN_FEATURE_RANK=...:NONE), avdec_h264
#      decodes and WebKit presents every frame. On a host where the NVIDIA
#      decoders work, or that has none, the first path holds.
#
# THE HOST'S VIDEO PATH. The probe tries the VIDEO_PATHS in their order (or
# answers from a fresh record of the same build and decoders: video_probe), and the first that presents frames is the host's. It is written to
# ~/.local/share/ship-queue-ci/webkit-video (path, env, frames, presents).
# While the record says presents=1, every CI step on that host gets its
# environment word (ci_tool_env_sh, ship-queue-hygiene.sh): a gate's WebKit
# then decodes as the probe measured, with nothing in the repo. The record is
# a file of the CI user's, which any job on the host could write: a step takes
# from it only GST_PLUGIN_FEATURE_RANK with decoder names, as text, and runs
# nothing from it. The word is exported to the whole step: it moves only those
# decoders out of every GStreamer program's selection.
#
# The browser runs headless in a private D-Bus session and a private runtime
# directory (no desktop session, no desktop sound server), as the design check
# runs it. It runs without the GST_PLUGIN_FEATURE_RANK a CI step
# has from this record, so the first path measures the host's own selection
# wherever the probe runs. The whole probe fits the hosts' 30 s probe limit
# (ship-queue-hosts.sh): each path has PATH_SECONDS, and its run ends before
# that limit could stop the probe and leave a browser behind.
#
# A probe that cannot measure (no node, no playwright-core, no ffmpeg clip: a
# refresh in progress, a full disk) leaves the record as it was; only a run
# that measured every path, or a missing GL plugin, writes presents=0.
set -euo pipefail

ci_tool_name="ci-webkit-video"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ship-queue/ci-download.sh
. "$here/ci-download.sh"
die() { ci_say "$*"; exit 1; }
usage="usage: ci-webkit-video.sh probe|measure"
CI_ROOT="$HOME/.local/share/ship-queue-ci"
CORE="$CI_ROOT/npm/lib/node_modules/playwright-core"
# The decoders that load CUDA (gstreamer1.0-plugins-bad's nvcodec), stateful and stateless; a name a host lacks is ignored.
NV_DECODERS="nvh264dec nvh264sldec nvh265dec nvh265sldec nvav1dec nvav1sldec nvvp8dec nvvp8sldec nvvp9dec nvvp9sldec nvmpeg2videodec nvmpeg4videodec nvmpegvideodec nvjpegdec"
nv_none() { local n out=""; for n in $NV_DECODERS; do out+="${out:+,}$n:NONE"; done; echo "$out"; }
# The video paths, tried in this order: NAME|ENVIRONMENT (one NAME=VALUE word or none).
#   gstreamer        the host's own decoder selection
#   software-decode  the NVIDIA (CUDA) decoders out of the selection, for a host where CUDA cannot share with GL (WSL)
VIDEO_PATHS=(
  'gstreamer|'
  "software-decode|GST_PLUGIN_FEATURE_RANK=$(nv_none)"
)
FRAMES_ENOUGH=10
PATH_SECONDS=6
d=""
trap '[ -z "$d" ] || rm -rf "$d"' EXIT

video_record() { echo "$CI_ROOT/webkit-video"; }

# The record, whole or not at all, and its text left alone when it would not change; its time is renewed, as
# a fresh measurement (the age of a record is the age of its last measurement).
# What a record was measured with: the WebKit build, and the decoders GStreamer can choose
# from (its plugin files and WSL's CUDA decoder, which outranks the software one). A change measures again.
webkit_build() { local b; b=$(ls -d "$CI_ROOT"/ms-playwright/webkit-*/ 2>/dev/null | sed 's|/$||; s|.*/||' | sort -V | tail -1); echo "${b:-none}"; }
gst_state() { { ls -lL /usr/lib/*/gstreamer-1.0/ /usr/lib/gstreamer-1.0/ /usr/lib/wsl/lib/libnvcuvid* 2>/dev/null || true; } | cksum | cut -d' ' -f1; }
# A record older than this is measured again, whatever it says: a job can write it (THE HOST'S VIDEO PATH).
RECORD_MAX_AGE_S=21600
build="" gst=""
video_write() { # NAME ENVIRONMENT FRAMES PRESENTS(1|0)
  local f text; f=$(video_record)
  text=$(printf 'path=%s\nenv=%s\nframes=%s\npresents=%s\nbuild=%s\ngst=%s\n' "$@" "${build:-$(webkit_build)}" "${gst:-$(gst_state)}")
  if [ "$(cat "$f" 2>/dev/null)" = "$text" ]; then touch "$f"; return 0; fi
  mkdir -p "${f%/*}" && printf '%s\n' "$text" > "$f.next.$$" && mv -f "$f.next.$$" "$f"
}

# The GStreamer GL plugin, where the system's GStreamer finds its plugins.
GL_PLUGIN_GLOBS=(/usr/lib/*/gstreamer-1.0/libgstopengl.so /usr/lib/gstreamer-1.0/libgstopengl.so)
gl_plugin() { local f; for f in "${GL_PLUGIN_GLOBS[@]}"; do [ -e "$f" ] && return 0; done; return 1; }

# What headless WebKit presents of CLIP with ENVIRONMENT: `frames=N time=T error=E`, or `frames=0 ... start failed`.
presented() { # CLIP ENVIRONMENT
  local out
  mkdir -p "$d/run" && chmod 700 "$d/run"
  # -k: a browser that does not end on TERM is killed, never left behind by the probe; the limit is the path's
  # budget plus a browser start, well inside the hosts' probe limit.
  out=$(env -u DISPLAY -u WAYLAND_DISPLAY -u PULSE_SERVER -u GST_PLUGIN_FEATURE_RANK XDG_RUNTIME_DIR="$d/run" \
    PLAYWRIGHT_BROWSERS_PATH="$CI_ROOT/ms-playwright" \
    timeout -k 1 $((PATH_SECONDS + 3)) dbus-run-session -- node "$here/ci-webkit-video.mjs" "$CORE" "$1" "$PATH_SECONDS" ${2:+"$2"} \
    2>/dev/null | grep '^frames=' | tail -1) || true
  echo "${out:-frames=0 time=0 error=start-failed}"
}

# The probe: the host's video path, found and recorded (THE HOST'S VIDEO PATH). With no path that presents
# frames, the record keeps the first path, marked presents=0, so no step gets a word for a path that does not
# work, and the probe fails with the reason.
video_probe() {
  local p t name word got first="" first_frames=0 frames rec f age
  # A record that says presents=1, measured within RECORD_MAX_AGE_S with this WebKit build and these
  # decoders, with the GL plugin still there, is the answer: the hosts check asks every host for every tool,
  # and playing a clip took 26 s on a loaded host (#1108). Anything else, or `measure`, measures again.
  # The build and decoders are read before measuring, so a build installed meanwhile is measured next time.
  build=$(webkit_build) gst=$(gst_state)
  f=$(video_record); rec=$(cat "$f" 2>/dev/null || true)
  age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
  # A record dated in the future (a job can set its time) is not fresh.
  if [ "${1:-}" != measure ] && [ "$age" -ge 0 ] && [ "$age" -lt "$RECORD_MAX_AGE_S" ] && gl_plugin && grep -qx 'presents=1' <<<"$rec" \
    && grep -qx "build=$build" <<<"$rec" && grep -qx "gst=$gst" <<<"$rec"; then
    echo presents; return 0
  fi
  if ! gl_plugin; then
    video_write gstreamer "" 0 0
    die "the GStreamer GL plugin is not installed (gstreamer1.0-gl, this tool's root grant): WebKit draws video through it, and without it holds a video paused after a few frames"
  fi
  # What the probe needs to measure at all: missing, it leaves the record as it was (it measured nothing).
  for t in node ffmpeg dbus-run-session; do command -v "$t" >/dev/null 2>&1 || die "no $t on PATH: nothing measured"; done
  [ -f "$CORE/package.json" ] || die "no playwright-core in $CORE (the playwright-webkit tool): nothing measured"
  d=$(mktemp -d "${TMPDIR:-/tmp}/ci-webkit-video.XXXXXX")
  # 1080p, the size of a film: on WSL the NVIDIA decoder's frames reach WebKit at 640x360 and stop at 720p and up.
  ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 3 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -movflags +faststart "$d/clip.mp4" || die "ffmpeg cannot make an H.264 clip (libx264): nothing measured"
  for p in "${VIDEO_PATHS[@]}"; do
    IFS='|' read -r name word <<<"$p"
    got=$(presented "$d/clip.mp4" "$word")
    frames=$(sed -n 's/^frames=\([0-9]*\).*/\1/p' <<<"$got")
    if [ "${frames:-0}" -ge "$FRAMES_ENOUGH" ] && [[ "$got" == *" error=none" ]]; then
      video_write "$name" "$word" "$frames" 1; echo presents; return 0
    fi
    [ -n "$first" ] || { first="$name: $got"; first_frames=${frames:-0}; }
  done
  IFS='|' read -r name word <<<"${VIDEO_PATHS[0]}"
  video_write "$name" "$word" "$first_frames" 0
  die "headless WebKit presents no H.264 frames by any path (${VIDEO_PATHS[*]%%|*}): $first"
}

case "${1:-}" in
  probe) video_probe ;;
  measure) video_probe measure ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
