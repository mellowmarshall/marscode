#!/bin/bash -p
# MarsCode host `node` shim.
# Fast-path normal node runs exec real `node` directly (with .env.ports loaded).
# Routes eas-cli to `marscode-host-guard release-check` and test runners to `tree-check`.
REAL_NODE='@REAL_NODE@'
HOST_GUARD='@HOST_GUARD@'
PORTS_ENV='@PORTS_ENV@'
SHIM_DEPTH='@SHIM_DEPTH@'

if [ "$REAL_NODE" -ef "${BASH_SOURCE[0]}" ] || [ ! -x "$REAL_NODE" ]; then
  printf 'node shim: the real node (%s) is missing or is this shim; re-run install.sh\n' "$REAL_NODE" >&2
  exit 127
fi

if [ -r "$SHIM_DEPTH" ]; then
  # shellcheck source=/dev/null
  . "$SHIM_DEPTH"
  hg_shim_depth "${BASH_SOURCE[0]}" "$REAL_NODE"
fi

node_shim_args=("$@")
node_shim_i=0
node_shim_test=0
node_shim_eas=0

while [ "$node_shim_i" -lt "$#" ]; do
  a="${node_shim_args[node_shim_i]}"
  case "$a" in
    --test|--test-name-pattern|--test-name-pattern=*) node_shim_test=1 ;;
    -r|--require|-C|--conditions|--import|--loader|--experimental-loader|-e|--eval|-p|--print)
      node_shim_i=$((node_shim_i + 1))
      ;;
    --) node_shim_i=$((node_shim_i + 1)); break ;;
    -*) ;;
    *) break ;;
  esac
  node_shim_i=$((node_shim_i + 1))
done

entry="${node_shim_args[node_shim_i]:-}"
case "$entry" in
  */eas-cli/bin/run|*/eas-cli/bin/run.js) node_shim_eas=1 ;;
  eas|*/eas)
    case "$(readlink -f -- "$entry" 2>/dev/null || true)" in
      */eas-cli/bin/run*) node_shim_eas=1 ;;
    esac
    ;;
  */vitest/vitest.mjs|*/.bin/vitest|*/playwright/cli.js|*/.bin/playwright|*/jest/bin/jest.js|*/.bin/jest)
    node_shim_test=1
    ;;
esac

if [ "$node_shim_eas" = 1 ]; then
  if [ ! -x "$HOST_GUARD" ]; then
    printf 'node shim: %s is missing; refusing unguarded eas-cli run\n' "$HOST_GUARD" >&2
    exit 2
  fi
  "$HOST_GUARD" release-check -- "${node_shim_args[@]:node_shim_i+1}" || exit $?
fi

if [ "$node_shim_test" = 1 ] && [ -x "$HOST_GUARD" ]; then
  "$HOST_GUARD" tree-check --kind test -- "$@" || exit $?
fi

if [ -r "$PORTS_ENV" ]; then
  # shellcheck source=/dev/null
  . "$PORTS_ENV"
  ports_env_exec "$REAL_NODE" "$@"
fi

exec "$REAL_NODE" "$@"
