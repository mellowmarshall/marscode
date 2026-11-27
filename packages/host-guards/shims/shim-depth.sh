# shellcheck shell=bash
# MarsCode host-guards shim recursion guard (HG_SHIM_DEPTH / HG_SHIM_NEXT / HG_SHIM_HOPS).
# Refuses at depth >= 2 or > 32 total shim starts in one ancestry with exit 126.

hg_shim_depth() { # SELF REAL
  local d=0 h=0
  case "${HG_SHIM_DEPTH:-}" in '' | *[!0-9]*) ;; *) d=$((10#${HG_SHIM_DEPTH:0:4})) ;; esac
  case "${HG_SHIM_HOPS:-}" in '' | *[!0-9]*) ;; *) h=$((10#${HG_SHIM_HOPS:0:4})) ;; esac
  if [ -n "${HG_SHIM_NEXT:-}" ] && [ "$HG_SHIM_NEXT" -ef "$1" ]; then
    d=$((d + 1))
    HG_SHIM_CHAIN="${HG_SHIM_CHAIN:-?} -> $1"
  else
    d=1
    HG_SHIM_CHAIN=$1
  fi
  h=$((h + 1))
  HG_SHIM_TRAIL="${HG_SHIM_TRAIL:+$HG_SHIM_TRAIL -> }$1"
  if [ "$d" -gt 1 ]; then
    printf 'host-guards: shim recursion (%s, depth %s): %s\n' "${1##*/}" "$d" "$HG_SHIM_CHAIN" >&2
    exit 126
  fi
  if [ "$h" -gt 32 ]; then
    printf 'host-guards: shim recursion (%s, %s shim starts in one process ancestry): %s\n' "${1##*/}" "$h" "$HG_SHIM_TRAIL" >&2
    exit 126
  fi
  export HG_SHIM_DEPTH="$d" HG_SHIM_CHAIN HG_SHIM_NEXT="$2" HG_SHIM_HOPS="$h" HG_SHIM_TRAIL
}
