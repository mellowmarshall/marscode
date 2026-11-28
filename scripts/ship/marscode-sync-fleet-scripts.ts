// Pure POSIX shell command builders for remote fleet hosts (linux-x64-server and macos-arm64-app).
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodePath from "node:path";

const SAFE_SHA = /^[0-9a-f]{7,40}$/i;
const SAFE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function assertValidVersion(version: string): string {
  if (!SAFE_VERSION.test(version)) {
    throw new Error(`marscode-sync: invalid fleet version: ${version}`);
  }
  return version;
}

export function assertValidSha(sha: string): string {
  if (!SAFE_SHA.test(sha)) {
    throw new Error(`marscode-sync: invalid commit sha: ${sha}`);
  }
  return sha;
}

/** Remote shell snippet expanding a leading `~/` to `$HOME/` safely, then quoting the remainder. */
export function remotePathExpr(rawPath: string): string {
  if (rawPath === "~") return '"$HOME"';
  if (rawPath.startsWith("~/")) return `"$HOME"/${shellSingleQuote(rawPath.slice(2))}`;
  return shellSingleQuote(rawPath);
}

const READ_ONLY_ACTIVE_RUNS_PY = [
  'ACTIVE_RUNS="$(python3 - "$T3_HOME/userdata/statev2.sqlite" <<\'PY\'',
  "import os, sqlite3, sys",
  "db = sys.argv[1]",
  "if not os.path.exists(db):",
  "    print(0)",
  "    raise SystemExit(0)",
  'conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)',
  "try:",
  "    row = conn.execute(",
  '        "SELECT count(*) FROM orchestration_v2_projection_runs "',
  "        \"WHERE status IN ('queued','preparing','starting','running','waiting')\"",
  "    ).fetchone()",
  "    print(int(row[0]) if row else 0)",
  "except sqlite3.OperationalError:",
  "    print(0)",
  "finally:",
  "    conn.close()",
  "PY",
  ')"',
].join("\n");

/**
 * Builds the remote POSIX shell script that atomically unpacks an uploaded tarball into
 * `$T3_HOME/runtime/versions/<version>`, checks read-only SQLite active runs, and activates
 * via the existing `t3 update <version> --yes --allow-downgrade` only when idle.
 */
export function buildLinuxActivateScript(input: {
  readonly version: string;
  readonly t3Home: string;
  readonly remoteArchivePath?: string | undefined;
}): string {
  const version = assertValidVersion(input.version);
  const t3HomeExpr = remotePathExpr(input.t3Home);
  const qVer = shellSingleQuote(version);
  const unpackBlock = input.remoteArchivePath
    ? [
        `ARCHIVE=${shellSingleQuote(input.remoteArchivePath)}`,
        'trap \'rm -rf "${STAGING:-}" "$ARCHIVE"\' EXIT',
        'mkdir -p "$VERSIONS_DIR"',
        'STAGING="$(mktemp -d "$VERSIONS_DIR/.marscode-stage-XXXXXX")"',
        'tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components=1',
        '"$STAGING/t3" --version >/dev/null',
        `printf '%s\\n' ${qVer} > "$STAGING/.install-complete"`,
        'rm -rf "$TARGET_DIR"',
        'mv "$STAGING" "$TARGET_DIR"',
        'rm -rf "$TARGET_DIR/${STAGING##*/}" "$ARCHIVE"',
        "trap - EXIT",
      ].join("\n")
    : "";

  return [
    "set -eu",
    `T3_HOME=${t3HomeExpr}`,
    'VERSIONS_DIR="$T3_HOME/runtime/versions"',
    `TARGET_DIR="$VERSIONS_DIR"/${qVer}`,
    unpackBlock,
    `if [ ! -x "$TARGET_DIR/t3" ] || [ "$(cat "$TARGET_DIR/.install-complete" 2>/dev/null || true)" != ${qVer} ]; then`,
    '  printf "MISSING_STAGE\\n"',
    "  exit 2",
    "fi",
    READ_ONLY_ACTIVE_RUNS_PY,
    'if [ "${ACTIVE_RUNS:-0}" -gt 0 ]; then',
    '  printf "DEFERRED active_runs=%s\\n" "$ACTIVE_RUNS"',
    "  exit 0",
    "fi",
    'export T3CODE_HOME="$T3_HOME"',
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    `"$TARGET_DIR/t3" update ${qVer} --yes --allow-downgrade`,
    '"$TARGET_DIR/t3" install >/dev/null 2>&1 || true',
    "if command -v systemctl >/dev/null 2>&1 && systemctl --user cat t3code.service >/dev/null 2>&1; then",
    '  systemctl --user is-active --quiet t3code.service || { printf "SERVICE_INACTIVE\\n" >&2; exit 1; }',
    "fi",
    `printf "ACTIVATED %s\\n" ${qVer}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the remote shell script run over SSH on a macOS ARM64 host to update its warm worktree,
 * build the `.app` bundle locally with `--platform mac --target dir --arch arm64`, check active
 * runs read-only, and swap `/Applications/<App>.app` cleanly only when idle.
 */
export function buildMacDeployScript(input: {
  readonly headSha: string;
  readonly version: string;
  readonly repo: string;
  readonly dataRoot: string;
  readonly appPath: string;
  readonly t3Home: string;
}): string {
  const sha = assertValidSha(input.headSha);
  const version = assertValidVersion(input.version);
  const qSha = shellSingleQuote(sha);
  const qVer = shellSingleQuote(version);
  const repoExpr = remotePathExpr(input.repo);
  const dataRootExpr = remotePathExpr(input.dataRoot);
  const appPathExpr = remotePathExpr(input.appPath);
  const t3HomeExpr = remotePathExpr(input.t3Home);
  const appBaseName = NodePath.basename(input.appPath, ".app");
  const qAppName = shellSingleQuote(appBaseName);

  return [
    "set -eu",
    'export PATH="$HOME/.local/bin:$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    `REPO=${repoExpr}`,
    `DATA_ROOT=${dataRootExpr}`,
    `APP_PATH=${appPathExpr}`,
    `T3_HOME=${t3HomeExpr}`,
    `HEAD_SHA=${qSha}`,
    `VERSION=${qVer}`,
    'WORKTREE="$DATA_ROOT/sync-worktree"',
    'STAGED_ROOT="$DATA_ROOT/staged-app"',
    'STAGED_DIR="$STAGED_ROOT/$HEAD_SHA"',
    'LOCK_DIR="$DATA_ROOT/.sync.lock"',
    'mkdir -p "$DATA_ROOT" "$STAGED_ROOT"',
    'if ! mkdir "$LOCK_DIR" 2>/dev/null; then',
    '  printf "DEFERRED sync_locked\\n"',
    "  exit 0",
    "fi",
    "trap 'rmdir \"$LOCK_DIR\" 2>/dev/null || true' EXIT",
    'if [ ! -d "$REPO/.git" ]; then',
    '  printf "MISSING_REPO %s\\n" "$REPO" >&2',
    "  exit 2",
    "fi",
    'if [ ! -d "$STAGED_DIR/app.bundle" ]; then',
    '  git -C "$REPO" fetch --quiet origin main',
    '  if [ ! -e "$WORKTREE/.git" ]; then',
    '    git -C "$REPO" worktree add --detach "$WORKTREE" "$HEAD_SHA"',
    "  else",
    '    git -C "$WORKTREE" reset --hard --quiet',
    '    git -C "$WORKTREE" clean -fd --quiet',
    '    git -C "$WORKTREE" checkout --detach --quiet "$HEAD_SHA"',
    "  fi",
    '  cd "$WORKTREE"',
    "  export VP_GIT_HOOKS=0",
    "  unset CARGO_TARGET_DIR T3CODE_DESKTOP_OUTPUT_DIR T3CODE_DESKTOP_MOCK_UPDATES || true",
    "  if command -v vp >/dev/null 2>&1; then",
    "    vp install --frozen-lockfile --ignore-scripts",
    "  else",
    "    pnpm install --frozen-lockfile --ignore-scripts",
    "  fi",
    '  T3CODE_DESKTOP_VERSION="$VERSION" node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64',
    '  BUILT_APP="$(find "$WORKTREE/release/mac-arm64" -maxdepth 1 -name "*.app" -type d | head -n 1)"',
    '  [ -n "$BUILT_APP" ] || { printf "NO_MAC_APP_BUILT\\n" >&2; exit 1; }',
    '  rm -rf "$STAGED_DIR.tmp" "$STAGED_DIR"',
    '  mkdir -p "$STAGED_DIR.tmp"',
    '  ditto "$BUILT_APP" "$STAGED_DIR.tmp/app.bundle"',
    '  mv "$STAGED_DIR.tmp" "$STAGED_DIR"',
    '  find "$STAGED_ROOT" -mindepth 1 -maxdepth 1 ! -name "$HEAD_SHA" -exec rm -rf {} +',
    "fi",
    READ_ONLY_ACTIVE_RUNS_PY,
    'if [ "${ACTIVE_RUNS:-0}" -gt 0 ]; then',
    '  printf "DEFERRED active_runs=%s\\n" "$ACTIVE_RUNS"',
    "  exit 0",
    "fi",
    "WAS_RUNNING=0",
    'if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then',
    "  WAS_RUNNING=1",
    `  osascript -e 'on run argv' -e 'tell application (item 1 of argv) to quit' -e 'end run' -- ${qAppName} >/dev/null 2>&1 || true`,
    "  WAITED=0",
    '  while pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 && [ "$WAITED" -lt 20 ]; do',
    "    sleep 0.5",
    "    WAITED=$((WAITED + 1))",
    "  done",
    '  if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then',
    '    printf "DEFERRED app_still_running\\n"',
    "    exit 0",
    "  fi",
    "fi",
    'APP_PARENT="$(dirname "$APP_PATH")"',
    'APP_STAGE="$APP_PARENT/.marscode-next-$$.app"',
    'APP_OLD="$APP_PARENT/.marscode-prev-$$.app"',
    'rm -rf "$APP_STAGE" "$APP_OLD"',
    'ditto "$STAGED_DIR/app.bundle" "$APP_STAGE"',
    'if [ -e "$APP_PATH" ]; then mv "$APP_PATH" "$APP_OLD"; fi',
    'if ! mv "$APP_STAGE" "$APP_PATH"; then',
    '  if [ -e "$APP_OLD" ]; then mv "$APP_OLD" "$APP_PATH"; fi',
    "  exit 1",
    "fi",
    'rm -rf "$APP_OLD" "$STAGED_DIR"',
    'if [ "$WAS_RUNNING" -eq 1 ]; then open -a "$APP_PATH"; fi',
    'printf "ACTIVATED %s\\n" "$VERSION"',
  ].join("\n");
}
