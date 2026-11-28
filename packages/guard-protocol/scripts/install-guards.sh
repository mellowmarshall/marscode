#!/usr/bin/env bash
# install-guards.sh — MarsCode-owned installer for `marscode-guard` CLI and
# the MarsCode Python guard-grant bridge.
#
# Usage:
#   install-guards.sh [--dry-run] [--bin-dir DIR] [--lib-dir DIR] [--install-legacy-bridge]
#
# Installs:
#   <LIB_DIR>/marscode-guard/                     symlink to atomic release dir (zero node_modules)
#   <LIB_DIR>/marscode-guard/hg_t3_grant_bridge.py MarsCode Python bridge
#   <BIN_DIR>/marscode-guard                      env-scrubbed executable entrypoint
#   <LIB_DIR>/hg_t3_grant.py                      (only with --install-legacy-bridge)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PKG_DIR/src"
BRIDGE_SRC="$SCRIPT_DIR/hg_t3_grant_bridge.py"

BIN_DIR="${HOME}/.local/bin"
LIB_DIR="${HOME}/.local/lib"
DRY_RUN=0
INSTALL_LEGACY_BRIDGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --install-legacy-bridge)
      INSTALL_LEGACY_BRIDGE=1
      shift
      ;;
    --bin-dir)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install-guards.sh: --bin-dir requires a directory argument\n' >&2
        exit 64
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --lib-dir)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install-guards.sh: --lib-dir requires a directory argument\n' >&2
        exit 64
      fi
      LIB_DIR="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,13p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf 'install-guards.sh: unknown argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

if [ ! -f "$SRC_DIR/cli.ts" ] || [ ! -f "$BRIDGE_SRC" ]; then
  printf 'install-guards.sh: missing guard-protocol sources under %s\n' "$PKG_DIR" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  printf 'install-guards.sh: node is required on PATH\n' >&2
  exit 1
fi
# The real node binary, as node itself reports it. `node` on PATH can be a link to a multi-call
# launcher that acts as node only under that name; the link's target does not run a script.
# The probe runs with a cleared environment, as the self-check and the wrapper do: no inherited
# NODE_OPTIONS can run code here or choose the binary.
NODE_REAL="$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" "$NODE_BIN" -p 'process.execPath' 2>/dev/null || true)"
if [ -n "$NODE_REAL" ] && [ -x "$NODE_REAL" ]; then
  NODE_BIN="$NODE_REAL"
else
  NODE_BIN="$(readlink -f "$NODE_BIN")"
fi

MODULES=(
  bundleInspect.ts
  cli.ts
  client.ts
  commandRedact.ts
  digests.ts
  plan.ts
  protocol.ts
  redaction.ts
  signing.ts
)

if [ "$DRY_RUN" -eq 1 ]; then
  printf '[dry-run] would install %d modules + bridge to %s/marscode-guard/\n' "${#MODULES[@]}" "$LIB_DIR"
  printf '[dry-run] would install executable %s/marscode-guard (using %s)\n' "$BIN_DIR" "$NODE_BIN"
  if [ "$INSTALL_LEGACY_BRIDGE" -eq 1 ]; then
    printf '[dry-run] would install legacy bridge %s/hg_t3_grant.py\n' "$LIB_DIR"
  fi
  exit 0
fi

mkdir -p "$BIN_DIR" "$LIB_DIR"
RELEASES_DIR="$LIB_DIR/marscode-guard.d"
mkdir -p "$RELEASES_DIR"
chmod 0755 "$BIN_DIR" "$LIB_DIR" "$RELEASES_DIR"

STAGE_DIR="$(mktemp -d "${RELEASES_DIR}/rel.XXXXXX")"
LINK_TMP="${LIB_DIR}/.marscode-guard-link.$$"
WRAPPER_TMP="$(mktemp "${BIN_DIR}/.marscode-guard.XXXXXX")"
BRIDGE_TMP=""
cleanup() {
  rm -rf "$STAGE_DIR" "$LINK_TMP" "$WRAPPER_TMP" ${BRIDGE_TMP:+"$BRIDGE_TMP"}
}
trap cleanup EXIT

printf '{"type":"module"}\n' > "$STAGE_DIR/package.json"
for mod in "${MODULES[@]}"; do
  if [ ! -f "$SRC_DIR/$mod" ]; then
    printf 'install-guards.sh: missing source module %s\n' "$SRC_DIR/$mod" >&2
    exit 1
  fi
  cp "$SRC_DIR/$mod" "$STAGE_DIR/$mod"
done
cp "$BRIDGE_SRC" "$STAGE_DIR/hg_t3_grant_bridge.py"
chmod 0644 "$STAGE_DIR"/*.ts "$STAGE_DIR/package.json" "$STAGE_DIR/hg_t3_grant_bridge.py"

# Smoke-test staged CLI under a scrubbed environment before swapping into place.
/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" "$NODE_BIN" "$STAGE_DIR/cli.ts" --help >/dev/null

# Atomic zero-gap symlink swap (migrates any legacy plain directory safely).
TARGET_MOD_LINK="$LIB_DIR/marscode-guard"
if [ -d "$TARGET_MOD_LINK" ] && [ ! -L "$TARGET_MOD_LINK" ]; then
  LEGACY_BACKUP="${RELEASES_DIR}/legacy.$$"
  mv "$TARGET_MOD_LINK" "$LEGACY_BACKUP"
fi
ln -s "$STAGE_DIR" "$LINK_TMP"
mv -Tf "$LINK_TMP" "$TARGET_MOD_LINK"

# Remove older staged releases after the symlink points at the new release.
for old in "$RELEASES_DIR"/*; do
  [ -e "$old" ] || continue
  [ "$old" = "$STAGE_DIR" ] && continue
  rm -rf "$old"
done

# Wrapper scrubs NODE_OPTIONS, GIT_*, LD_*, BASH_ENV, etc. via `env -i`.
cat > "$WRAPPER_TMP" <<EOF
#!/usr/bin/env bash
set -euo pipefail
env_args=(PATH=/usr/bin:/bin HOME="\${HOME:-}")
for k in T3CODE_THREAD_ID T3_GUARD_REQUEST_TIMEOUT HOST_GUARD_OVERRIDE HOST_GUARDS_TEST T3_GUARD_GRANT_SOCKET; do
  if [ -n "\${!k+x}" ]; then
    env_args+=("\${k}=\${!k}")
  fi
done
exec /usr/bin/env -i "\${env_args[@]}" $(printf '%q' "$NODE_BIN") $(printf '%q' "$TARGET_MOD_LINK/cli.ts") "\$@"
EOF
chmod 0755 "$WRAPPER_TMP"
mv -f "$WRAPPER_TMP" "$BIN_DIR/marscode-guard"

if [ "$INSTALL_LEGACY_BRIDGE" -eq 1 ]; then
  BRIDGE_TMP="$(mktemp "${LIB_DIR}/.hg_t3_grant.py.XXXXXX")"
  cp "$BRIDGE_SRC" "$BRIDGE_TMP"
  chmod 0644 "$BRIDGE_TMP"
  mv -f "$BRIDGE_TMP" "$LIB_DIR/hg_t3_grant.py"
fi

STAGE_DIR=""
WRAPPER_TMP=""
BRIDGE_TMP=""
trap - EXIT
printf 'marscode-guard: installed %s/marscode-guard (modules in %s)\n' "$BIN_DIR" "$TARGET_MOD_LINK"
