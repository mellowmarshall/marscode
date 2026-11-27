#!/bin/bash -p
# MarsCode host ports shim (docker, python3, uv).
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
if [ "$shim_name" = "docker" ] || [ "$shim_name" = "podman" ]; then
  check_ports=0
  for a in "$@"; do
    case "$a" in
      -p|--publish|--publish=*) check_ports=1; break ;;
    esac
  done
  if [ "$check_ports" = 1 ] && [ -x "$HOST_GUARD" ]; then
    "$HOST_GUARD" ports-check -- "$shim_name" "$@" || exit $?
  fi
fi

if [ -r "$PORTS_ENV" ]; then
  # shellcheck source=/dev/null
  . "$PORTS_ENV"
  ports_env_exec "$REAL" "$@"
fi

exec "$REAL" "$@"
