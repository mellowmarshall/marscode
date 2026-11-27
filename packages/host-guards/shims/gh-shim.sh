#!/bin/bash -p
# MarsCode host `gh` shim.
REAL_GH='@REAL_GH@'
HOST_GUARD='@HOST_GUARD@'
SHIM_DEPTH='@SHIM_DEPTH@'

if [ "$REAL_GH" -ef "${BASH_SOURCE[0]}" ] || [ ! -x "$REAL_GH" ]; then
  printf 'gh shim: the real gh (%s) is missing or is this shim; re-run install.sh\n' "$REAL_GH" >&2
  exit 127
fi

if [ -r "$SHIM_DEPTH" ]; then
  # shellcheck source=/dev/null
  . "$SHIM_DEPTH"
  hg_shim_depth "${BASH_SOURCE[0]}" "$REAL_GH"
fi

if [ ! -x "$HOST_GUARD" ]; then
  printf 'gh shim: %s is missing; refusing unguarded gh run\n' "$HOST_GUARD" >&2
  exit 2
fi

"$HOST_GUARD" gh-check -- "$@" || exit $?
exec "$REAL_GH" "$@"
