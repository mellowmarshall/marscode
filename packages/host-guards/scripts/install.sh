#!/usr/bin/env bash
# Atomically install MarsCode native TypeScript host-guards (zero Python dependency).
#
# Usage:
#   install.sh [--dry-run] [--no-hooks] [--prefix DIR] [--org ORG]
#              [--source-root DIR] [--data-root DIR]
#              [--real-git PATH] [--real-node PATH] [--real-gh PATH]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SHIMS_SRC="$PKG_DIR/shims"
BUNDLE_SRC="$PKG_DIR/dist/bin.mjs"
EXAMPLE_CFG="$PKG_DIR/host-guards.example.json"

PREFIX="$HOME/.local"
DRY_RUN=0
INSTALL_HOOKS=1
REAL_GIT=""
REAL_NODE=""
REAL_GH=""
ORG_ARG=""
SOURCE_ROOT_ARG=""
DATA_ROOT_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-hooks|--no-hook) INSTALL_HOOKS=0; shift ;;
    --prefix)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        printf 'install.sh: --prefix requires a directory argument\n' >&2
        exit 64
      fi
      PREFIX="$2"
      shift 2
      ;;
    --real-git) REAL_GIT="$2"; shift 2 ;;
    --real-node) REAL_NODE="$2"; shift 2 ;;
    --real-gh) REAL_GH="$2"; shift 2 ;;
    --org|--owner) ORG_ARG="$2"; shift 2 ;;
    --source-root) SOURCE_ROOT_ARG="$2"; shift 2 ;;
    --data-root) DATA_ROOT_ARG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

BIN_DIR="$PREFIX/bin"
GUARDS_DIR="$PREFIX/guards"
LIB_DIR="$PREFIX/lib/marscode"
INSTALL_DIR="$LIB_DIR/host-guards"
CONFIG_FILE="$LIB_DIR/host-guards.json"
CLI_WRAPPER="$BIN_DIR/marscode-host-guard"
SHIM_DEPTH_DST="$INSTALL_DIR/shim-depth.sh"
PORTS_ENV_DST="$INSTALL_DIR/ports-env.sh"

find_real_bin() {
  local name="$1"
  local fallback="$2"
  local candidate=""
  IFS=: read -r -a path_parts <<<"${PATH:-/usr/local/bin:/usr/bin:/bin}"
  for dir in "${path_parts[@]}" /usr/local/bin /usr/bin /bin; do
    [ -n "$dir" ] || continue
    candidate="$dir/$name"
    [ -x "$candidate" ] && [ -f "$candidate" ] || continue
    if grep -q "MarsCode host" "$candidate" 2>/dev/null || grep -q "devtools host-guards" "$candidate" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  if [ -n "$fallback" ] && [ -x "$fallback" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  return 1
}

[ -n "$REAL_NODE" ] || REAL_NODE="$(find_real_bin node /usr/bin/node || true)"
[ -n "$REAL_GIT" ] || REAL_GIT="$(find_real_bin git /usr/bin/git || true)"
[ -n "$REAL_GH" ] || REAL_GH="$(find_real_bin gh /usr/bin/gh || true)"

if [ -z "$REAL_NODE" ] || [ ! -x "$REAL_NODE" ]; then
  printf 'install.sh: fatal: cannot find real node binary\n' >&2
  exit 1
fi
if [ -z "$REAL_GIT" ] || [ ! -x "$REAL_GIT" ]; then
  printf 'install.sh: fatal: cannot find real git binary\n' >&2
  exit 1
fi
if [ ! -f "$BUNDLE_SRC" ]; then
  printf 'install.sh: fatal: %s is missing; run "vp run @t3tools/host-guards#build" first\n' "$BUNDLE_SRC" >&2
  exit 1
fi

atomic_install_file() {
  local src="$1" dst="$2" mode="$3"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] install -m %s %s -> %s\n' "$mode" "$src" "$dst"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  local tmp="${dst}.next.$$"
  cp "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst"
}

atomic_render_shim() {
  local template="$1" dst="$2" real_placeholder="$3" real_val="$4"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] render shim %s -> %s (real=%s)\n' "$(basename "$template")" "$dst" "$real_val"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  local tmp="${dst}.next.$$"
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    let text = fs.readFileSync(process.argv[1], "utf8");
    const pairs = [
      [process.argv[3], process.argv[4]],
      ["@HOST_GUARD@", process.argv[5]],
      ["@SHIM_DEPTH@", process.argv[6]],
      ["@PORTS_ENV@", process.argv[7]],
    ];
    for (const [k, v] of pairs) text = text.split(k).join(v);
    fs.writeFileSync(process.argv[2], text, { mode: 0o755 });
  ' "$template" "$tmp" "$real_placeholder" "$real_val" "$CLI_WRAPPER" "$SHIM_DEPTH_DST" "$PORTS_ENV_DST"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$dst"
}

# 1. Install bundled CLI and runtime support scripts atomically
atomic_install_file "$BUNDLE_SRC" "$INSTALL_DIR/bin.mjs" 0755
atomic_install_file "$SHIMS_SRC/shim-depth.sh" "$SHIM_DEPTH_DST" 0644
atomic_install_file "$SHIMS_SRC/ports-env.sh" "$PORTS_ENV_DST" 0644

if [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] write CLI wrapper %s -> %s %s\n' "$CLI_WRAPPER" "$REAL_NODE" "$INSTALL_DIR/bin.mjs"
else
  mkdir -p "$BIN_DIR"
  tmp_wrap="${CLI_WRAPPER}.next.$$"
  cat >"$tmp_wrap" <<EOF
#!/bin/bash -p
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS
exec '$REAL_NODE' '$INSTALL_DIR/bin.mjs' "\$@"
EOF
  chmod 0755 "$tmp_wrap"
  mv -f "$tmp_wrap" "$CLI_WRAPPER"
fi

# 2. Write default ~/.local/lib/marscode/host-guards.json ONLY if missing
if [ ! -f "$CONFIG_FILE" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] create default config %s (never overwrites existing)\n' "$CONFIG_FILE"
  else
    mkdir -p "$LIB_DIR"
    tmp_cfg="${CONFIG_FILE}.next.$$"
    "$REAL_NODE" -e '
      const fs = require("node:fs");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (process.argv[2]) cfg.orgs = [process.argv[2].toLowerCase()];
      if (process.argv[3]) cfg.sourceRoot = process.argv[3];
      if (process.argv[4]) cfg.dataRoot = process.argv[4];
      cfg.realGit = process.argv[5];
      if (process.argv[6]) cfg.realGh = process.argv[6];
      fs.writeFileSync(process.argv[7], JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    ' "$EXAMPLE_CFG" "$ORG_ARG" "$SOURCE_ROOT_ARG" "$DATA_ROOT_ARG" "$REAL_GIT" "${REAL_GH:-/usr/bin/gh}" "$tmp_cfg"
    mv -f "$tmp_cfg" "$CONFIG_FILE"
  fi
else
  printf 'install.sh: keeping existing config at %s\n' "$CONFIG_FILE"
fi

# 3. Install shims in ~/.local/bin and ~/.local/guards
atomic_render_shim "$SHIMS_SRC/git-shim.sh" "$BIN_DIR/git" "@REAL_GIT@" "$REAL_GIT"
atomic_render_shim "$SHIMS_SRC/node-shim.sh" "$BIN_DIR/node" "@REAL_NODE@" "$REAL_NODE"

if [ -n "$REAL_GH" ] && [ -x "$REAL_GH" ]; then
  atomic_render_shim "$SHIMS_SRC/gh-shim.sh" "$BIN_DIR/gh" "@REAL_GH@" "$REAL_GH"
fi

for pkg_bin in pnpm npm yarn bun pip pip3 vp; do
  real_bin="$(find_real_bin "$pkg_bin" "" || true)"
  if [ -n "$real_bin" ]; then
    atomic_render_shim "$SHIMS_SRC/pkg-shim.sh" "$BIN_DIR/$pkg_bin" "@REAL@" "$real_bin"
  fi
done

for port_bin in docker python3 uv; do
  real_bin="$(find_real_bin "$port_bin" "" || true)"
  if [ -n "$real_bin" ]; then
    atomic_render_shim "$SHIMS_SRC/ports-shim.sh" "$BIN_DIR/$port_bin" "@REAL@" "$real_bin"
  fi
done

for cloud_bin in fly flyctl doppler; do
  real_bin="$(find_real_bin "$cloud_bin" "" || true)"
  if [ -n "$real_bin" ]; then
    atomic_render_shim "$SHIMS_SRC/cloud-shim.sh" "$GUARDS_DIR/$cloud_bin" "@REAL@" "$real_bin"
  fi
done

# 4. Update Claude/Grok/Codex hook entries to marscode-host-guard (zero Python)
update_hook_json() {
  local target_file="$1" agent_name="$2" matcher="$3"
  local pre_cmd="$CLI_WRAPPER hook"
  local sess_cmd="$CLI_WRAPPER ports-session $agent_name"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] update hooks in %s (PreToolUse=%s, SessionStart=%s)\n' "$target_file" "$pre_cmd" "$sess_cmd"
    return 0
  fi
  mkdir -p "$(dirname "$target_file")"
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    const [filePath, matcher, preCmd, sessCmd] = process.argv.slice(1);
    let targetPath = filePath;
    let fileMode = 0o600;
    let data = {};
    if (fs.existsSync(filePath)) {
      targetPath = fs.realpathSync(filePath);
      fileMode = fs.statSync(targetPath).mode & 0o777;
      const raw = fs.readFileSync(targetPath, "utf8");
      if (raw.trim().length > 0) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          process.stderr.write(
            "install.sh: fatal: " + targetPath + " contains invalid JSON (" + err.message + "); refusing to overwrite\n",
          );
          process.exit(1);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          process.stderr.write(
            "install.sh: fatal: " + targetPath + " must contain a JSON object; refusing to overwrite\n",
          );
          process.exit(1);
        }
        data = parsed;
      }
    }
    if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) data.hooks = {};

    const isOldHostGuard = (cmd) =>
      typeof cmd === "string" &&
      (cmd.includes("host_guard.py") || cmd.includes("hg_ports.py") || cmd.includes("marscode-host-guard"));

    for (const ev of Object.keys(data.hooks)) {
      const entries = Array.isArray(data.hooks[ev]) ? data.hooks[ev] : [];
      for (const entry of entries) {
        if (entry && Array.isArray(entry.hooks)) {
          entry.hooks = entry.hooks.filter((h) => !isOldHostGuard(h && h.command));
        }
      }
      data.hooks[ev] = entries.filter((e) => e && Array.isArray(e.hooks) && e.hooks.length > 0);
      if (data.hooks[ev].length === 0) delete data.hooks[ev];
    }

    const addHook = (event, match, command, timeout) => {
      if (!Array.isArray(data.hooks[event])) data.hooks[event] = [];
      let entry = data.hooks[event].find((e) => (e.matcher ?? null) === (match || null));
      if (!entry) {
        entry = match ? { matcher: match, hooks: [] } : { hooks: [] };
        data.hooks[event].push(entry);
      }
      entry.hooks.push({ type: "command", command, timeout });
    };

    addHook("PreToolUse", matcher, preCmd, 60);
    addHook("SessionStart", "", sessCmd, 5);

    const tmp = targetPath + ".next." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: fileMode });
    fs.chmodSync(tmp, fileMode);
    fs.renameSync(tmp, targetPath);
  ' "$target_file" "$matcher" "$pre_cmd" "$sess_cmd"
}

if [ "$INSTALL_HOOKS" = 1 ]; then
  update_hook_json "$HOME/.claude/settings.json" "claude" "Bash"
  update_hook_json "$HOME/.grok/hooks/host-guards.json" "grok" "Bash"
  update_hook_json "$HOME/.codex/hooks.json" "codex" "Bash"
fi

# 5. Post-install self-probes
if [ "$DRY_RUN" = 0 ]; then
  "$CLI_WRAPPER" self-check >/dev/null
  "$BIN_DIR/git" --version >/dev/null
  printf 'install.sh: MarsCode host-guards installed and self-check passed.\n'
else
  printf 'install.sh: dry-run complete.\n'
fi
