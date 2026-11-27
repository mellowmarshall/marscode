#!/usr/bin/env bash
# install-marscode-tools.sh — Build and atomically install MarsCode's headless
# CLI tools (`ship-queue`, `playbook`, `runlog`, `fleet`, `surface`,
# `marscode-guard`, and `marscode-host-guard` when present).
#
# Usage:
#   install-marscode-tools.sh [--dry-run] [--skip-build] [--skip-stage]
#                             [--bin-dir DIR] [--lib-dir DIR] [--queue-root DIR]
#
# Defaults:
#   --bin-dir     "$HOME/.local/bin"
#   --lib-dir     "$HOME/.local/lib/marscode-tools"
#   --queue-root  "${SHIP_QUEUE_ROOT:-$HOME/.local/share/ship-queue}"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BIN_DIR="${HOME}/.local/bin"
LIB_DIR="${HOME}/.local/lib/marscode-tools"
LIB_DIR_OVERRIDDEN=0
QUEUE_ROOT="${SHIP_QUEUE_ROOT:-${HOME}/.local/share/ship-queue}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_STAGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-stage)
      SKIP_STAGE=1
      shift
      ;;
    --bin-dir)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install-marscode-tools.sh: --bin-dir requires a directory argument\n' >&2
        exit 64
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --lib-dir)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install-marscode-tools.sh: --lib-dir requires a directory argument\n' >&2
        exit 64
      fi
      LIB_DIR="$2"
      LIB_DIR_OVERRIDDEN=1
      shift 2
      ;;
    --queue-root)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install-marscode-tools.sh: --queue-root requires a directory argument\n' >&2
        exit 64
      fi
      QUEUE_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,13p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      printf 'install-marscode-tools.sh: unknown argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

if [ "$LIB_DIR_OVERRIDDEN" -eq 1 ]; then
  GUARD_LIB_DIR="$LIB_DIR"
else
  GUARD_LIB_DIR="${HOME}/.local/lib"
fi

ensure_vp_path() {
  local d
  if ! command -v vp >/dev/null 2>&1; then
    for d in "${HOME}/.local/share/vite-plus/bin" "${HOME}/.vite-plus/bin"; do
      if [ -x "$d/vp" ]; then
        export PATH="$d:$PATH"
        break
      fi
    done
  fi
  command -v vp >/dev/null 2>&1 || {
    printf 'install-marscode-tools.sh: vp (Vite+) not found on PATH (%s)\n' "$PATH" >&2
    return 1
  }
}

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  printf 'install-marscode-tools.sh: node is required on PATH\n' >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"

CLI_TOOLS=(
  "ship-queue:packages/ship-queue:@t3tools/ship-queue"
  "playbook:packages/playbook:@t3tools/playbook"
  "runlog:packages/runlog:@t3tools/runlog"
  "fleet:packages/fleet:@t3tools/fleet"
  "surface:packages/surface:@t3tools/surface"
)

GUARD_INSTALLER="$REPO_ROOT/packages/guard-protocol/scripts/install-guards.sh"
HOST_GUARD_INSTALLER="$REPO_ROOT/packages/host-guards/scripts/install.sh"

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$SKIP_BUILD" -eq 0 ]; then
    printf '[dry-run] would build 5 standalone CLI bundles via vp run --filter ... build:bundle in %s\n' "$REPO_ROOT"
  fi
  for spec in "${CLI_TOOLS[@]}"; do
    IFS=: read -r tool pkg_rel _pkg_name <<< "$spec"
    printf '[dry-run] would atomically install %s/dist/bin.mjs -> %s/%s and %s/%s\n' \
      "$pkg_rel" "$LIB_DIR" "$tool" "$BIN_DIR" "$tool"
  done
  if [ "$SKIP_STAGE" -eq 0 ]; then
    printf '[dry-run] would stage ship-queue worker version in %s/versions and prune unreferenced versions\n' "$QUEUE_ROOT"
  fi
  if [ -f "$GUARD_INSTALLER" ]; then
    bash "$GUARD_INSTALLER" --dry-run --bin-dir "$BIN_DIR" --lib-dir "$GUARD_LIB_DIR"
  else
    printf '[dry-run] marscode-guard installer missing at %s\n' "$GUARD_INSTALLER" >&2
    exit 1
  fi
  if [ -f "$HOST_GUARD_INSTALLER" ]; then
    printf '[dry-run] would invoke %s --dry-run --bin-dir %s --lib-dir %s\n' \
      "$HOST_GUARD_INSTALLER" "$BIN_DIR" "$GUARD_LIB_DIR"
  else
    printf '[dry-run] marscode-host-guard: packages/host-guards/scripts/install.sh not present; skipping\n'
  fi
  exit 0
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  ensure_vp_path
  filter_args=()
  for spec in "${CLI_TOOLS[@]}"; do
    IFS=: read -r _tool _pkg_rel pkg_name <<< "$spec"
    filter_args+=(--filter "$pkg_name")
  done
  (cd "$REPO_ROOT" && vp run "${filter_args[@]}" build:bundle)
fi

if [ ! -d "$BIN_DIR" ]; then
  mkdir -p "$BIN_DIR"
  chmod 0755 "$BIN_DIR"
fi
mkdir -p "$LIB_DIR" "$LIB_DIR/.releases"
chmod 0755 "$LIB_DIR" "$LIB_DIR/.releases"
BIN_DIR="$(cd "$BIN_DIR" && pwd -P)"
LIB_DIR="$(cd "$LIB_DIR" && pwd -P)"
mkdir -p "$GUARD_LIB_DIR"
GUARD_LIB_DIR="$(cd "$GUARD_LIB_DIR" && pwd -P)"

TMP_CLEANUP=()
cleanup_temps() {
  local p
  for p in "${TMP_CLEANUP[@]}"; do
    [ -n "$p" ] && rm -rf "$p"
  done
}
trap cleanup_temps EXIT

install_node_cli() {
  local tool="$1"
  local pkg_rel="$2"
  local bundle_src="$REPO_ROOT/$pkg_rel/dist/bin.mjs"
  if [ ! -f "$bundle_src" ]; then
    printf 'install-marscode-tools.sh: missing built bundle %s\n' "$bundle_src" >&2
    return 1
  fi

  local releases_dir="$LIB_DIR/.releases"
  local stage_dir link_tmp wrapper_tmp target_link legacy_backup old
  stage_dir="$(mktemp -d "${releases_dir}/${tool}.XXXXXX")"
  link_tmp="${LIB_DIR}/.${tool}.next.$$"
  wrapper_tmp="$(mktemp "${BIN_DIR}/.${tool}.next.XXXXXX")"
  TMP_CLEANUP=("$stage_dir" "$link_tmp" "$wrapper_tmp")

  mkdir -p "$stage_dir/dist"
  printf '{"type":"module"}\n' > "$stage_dir/package.json"
  cp "$bundle_src" "$stage_dir/dist/bin.mjs"
  chmod 0644 "$stage_dir/package.json"
  chmod 0755 "$stage_dir/dist/bin.mjs"

  if [ "$tool" = "surface" ] && [ -d "$REPO_ROOT/$pkg_rel/templates" ]; then
    cp -R "$REPO_ROOT/$pkg_rel/templates" "$stage_dir/templates"
  fi

  # Smoke-test staged bundle before swapping live symlinks or launchers.
  "$NODE_BIN" "$stage_dir/dist/bin.mjs" --help >/dev/null

  target_link="$LIB_DIR/$tool"
  cat > "$wrapper_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
node_bin=$(printf '%q' "$NODE_BIN")
if [ ! -x "\$node_bin" ]; then
  node_bin="\$(command -v node)"
fi
exec "\$node_bin" $(printf '%q' "$target_link/dist/bin.mjs") "\$@"
EOF
  chmod 0755 "$wrapper_tmp"

  if [ -d "$target_link" ] && [ ! -L "$target_link" ]; then
    legacy_backup="${releases_dir}/${tool}.legacy.$$"
    mv "$target_link" "$legacy_backup"
  fi
  ln -s "$stage_dir" "$link_tmp"
  mv -Tf "$link_tmp" "$target_link"
  TMP_CLEANUP=("$wrapper_tmp")

  mv -f "$wrapper_tmp" "$BIN_DIR/$tool"
  TMP_CLEANUP=()

  # Keep only the active release directory for this tool.
  for old in "${releases_dir}/${tool}".*; do
    [ -e "$old" ] || continue
    [ "$old" = "$stage_dir" ] && continue
    rm -rf "$old"
  done

  printf 'marscode-tools: installed %s/%s -> %s/dist/bin.mjs\n' "$BIN_DIR" "$tool" "$target_link"
}

for spec in "${CLI_TOOLS[@]}"; do
  IFS=: read -r tool pkg_rel _pkg_name <<< "$spec"
  install_node_cli "$tool" "$pkg_rel"
done

compute_ship_queue_version() {
  local bundle="$1"
  local bin_hash git_sha
  bin_hash="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const h = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
    process.stdout.write(h.slice(0, 12));
  ' "$bundle")"
  git_sha="$(git -C "$REPO_ROOT" rev-parse --short=8 HEAD 2>/dev/null || true)"
  if [ -n "$git_sha" ] && [[ "$git_sha" =~ ^[0-9a-fA-F]+$ ]]; then
    printf 'v-%s-%s' "$git_sha" "$bin_hash"
  else
    printf 'v-%s' "$bin_hash"
  fi
}

if [ "$SKIP_STAGE" -eq 0 ]; then
  sq_version="$(compute_ship_queue_version "$LIB_DIR/ship-queue/dist/bin.mjs")"
  SHIP_QUEUE_ROOT="$QUEUE_ROOT" "$BIN_DIR/ship-queue" version stage "$sq_version" \
    --source-dir "$LIB_DIR/ship-queue/dist" --entry bin.mjs
  SHIP_QUEUE_ROOT="$QUEUE_ROOT" "$BIN_DIR/ship-queue" version prune || true
fi

if [ ! -f "$GUARD_INSTALLER" ]; then
  printf 'install-marscode-tools.sh: missing guard installer at %s\n' "$GUARD_INSTALLER" >&2
  exit 1
fi
bash "$GUARD_INSTALLER" --bin-dir "$BIN_DIR" --lib-dir "$GUARD_LIB_DIR"

if [ -f "$HOST_GUARD_INSTALLER" ]; then
  bash "$HOST_GUARD_INSTALLER" --bin-dir "$BIN_DIR" --lib-dir "$GUARD_LIB_DIR"
else
  printf 'marscode-tools: marscode-host-guard installer not present (%s); skipping\n' "$HOST_GUARD_INSTALLER"
fi

trap - EXIT
