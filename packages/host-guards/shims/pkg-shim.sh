#!/bin/bash -p
# MarsCode host package-manager shim (pnpm, npm, yarn, bun, pip, pip3, vp).
REAL='@REAL@'
HOST_GUARD='@HOST_GUARD@'
PORTS_ENV='@PORTS_ENV@'
SHIM_DEPTH='@SHIM_DEPTH@'

if [ "$REAL" -ef "${BASH_SOURCE[0]}" ] || [ ! -x "$REAL" ]; then
  printf '%s shim: the real binary (%s) is missing or is this shim; re-run install.sh\n' "${0##*/}" "$REAL" >&2
  exit 127
fi

if [ -r "$SHIM_DEPTH" ]; then
  # shellcheck source=/dev/null
  . "$SHIM_DEPTH"
  hg_shim_depth "${BASH_SOURCE[0]}" "$REAL"
fi

shim_name="${0##*/}"
if [ ! -x "$HOST_GUARD" ]; then
  printf '%s shim: %s is missing; refusing unguarded package manager run\n' "$shim_name" "$HOST_GUARD" >&2
  exit 2
fi

"$HOST_GUARD" install-check --with-tree -- "$shim_name" "$@" || exit $?

if [ -r "$PORTS_ENV" ]; then
  # shellcheck source=/dev/null
  . "$PORTS_ENV"
  ports_env_exec "$REAL" "$@"
fi

exec "$REAL" "$@"
