#!/bin/bash -p
# MarsCode host `gh` shim.
# Fast-path read-only gh subcommands directly (zero Node startup).
# Mutating, prose-writing, API, or alias invocations delegate to `marscode-host-guard gh-run`.
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

case "${1:-}" in
  ""|--version|-v|--help|-h|version|help|status|search)
    exec "$REAL_GH" "$@"
    ;;
  pr)
    case "${2:-}" in
      view|list|status|diff|checks|checkout) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  issue)
    case "${2:-}" in
      view|list|status) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  repo)
    case "${2:-}" in
      view|list|clone) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  run)
    case "${2:-}" in
      view|list|watch) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  workflow|release)
    case "${2:-}" in
      view|list) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  auth)
    case "${2:-}" in
      status|token) exec "$REAL_GH" "$@" ;;
    esac
    ;;
  alias)
    case "${2:-}" in
      list) exec "$REAL_GH" "$@" ;;
    esac
    ;;
esac

if [ ! -x "$HOST_GUARD" ]; then
  printf 'gh shim: %s is missing; refusing unguarded gh run\n' "$HOST_GUARD" >&2
  exit 2
fi

exec "$HOST_GUARD" gh-run --real-gh "$REAL_GH" -- "$@"
