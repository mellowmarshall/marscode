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

/**
 * Queries active runs read-only from `statev2.sqlite`. Only missing DB or "no such table"
 * counts as 0; any lock, WAL, or open error prints `UNKNOWN` so the caller defers safely.
 */
const READ_ONLY_ACTIVE_RUNS_SH = [
  'ACTIVE_RUNS="$(python3 - "$T3_HOME/userdata/statev2.sqlite" <<\'PY\'',
  "import os, sqlite3, sys",
  "db = sys.argv[1]",
  "if not os.path.exists(db):",
  "    print(0)",
  "    raise SystemExit(0)",
  "conn = None",
  "try:",
  '    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0)',
  "    row = conn.execute(",
  '        "SELECT count(*) FROM orchestration_v2_projection_runs "',
  "        \"WHERE status IN ('queued','preparing','starting','running','waiting')\"",
  "    ).fetchone()",
  "    print(int(row[0]) if row else 0)",
  "except sqlite3.OperationalError as exc:",
  '    if "no such table" in str(exc).lower():',
  "        print(0)",
  "    else:",
  '        print("UNKNOWN")',
  "except sqlite3.Error:",
  '    print("UNKNOWN")',
  "finally:",
  "    if conn is not None:",
  "        conn.close()",
  "PY",
  ')"',
  'case "${ACTIVE_RUNS:-UNKNOWN}" in',
  "  *[!0-9]*|'')",
  '    printf "DEFERRED active_runs_unknown\\n"',
  "    exit 0",
  "    ;;",
  "esac",
  'if [ "$ACTIVE_RUNS" -gt 0 ]; then',
  '  printf "DEFERRED active_runs=%s\\n" "$ACTIVE_RUNS"',
  "  exit 0",
  "fi",
].join("\n");

/** Probes whether a linux-x64 host already has `<version>` staged for exact commit `<headSha>`. */
export function buildLinuxStageProbeScript(input: {
  readonly version: string;
  readonly headSha: string;
  readonly t3Home: string;
}): string {
  const version = assertValidVersion(input.version);
  const sha = assertValidSha(input.headSha);
  const qVer = shellSingleQuote(version);
  const qSha = shellSingleQuote(sha);
  return [
    "set -eu",
    `T3_HOME=${remotePathExpr(input.t3Home)}`,
    `TARGET="$T3_HOME/runtime/versions"/${qVer}`,
    `if [ -x "$TARGET/t3" ] && [ "$(cat "$TARGET/.install-complete" 2>/dev/null || true)" = ${qVer} ] && [ "$(cat "$TARGET/.marscode-sha" 2>/dev/null || true)" = ${qSha} ]; then`,
    '  printf "STAGED\\n"',
    "else",
    '  printf "NEED_STAGE\\n"',
    "fi",
  ].join("\n");
}

/**
 * Builds the remote POSIX shell script that atomically unpacks an uploaded tarball into
 * `$T3_HOME/runtime/versions/<version>` pinned to `<headSha>`, checks read-only SQLite active
 * runs, and activates via `t3 update <version> --yes --allow-downgrade` only when idle.
 */
export function buildLinuxActivateScript(input: {
  readonly version: string;
  readonly headSha: string;
  readonly t3Home: string;
  readonly remoteArchivePath?: string | undefined;
}): string {
  const version = assertValidVersion(input.version);
  const sha = assertValidSha(input.headSha);
  const t3HomeExpr = remotePathExpr(input.t3Home);
  const qVer = shellSingleQuote(version);
  const qSha = shellSingleQuote(sha);
  const unpackBlock = input.remoteArchivePath
    ? [
        `ARCHIVE=${shellSingleQuote(input.remoteArchivePath)}`,
        'trap \'rm -rf "${STAGING:-}" "$ARCHIVE"\' EXIT HUP INT TERM',
        'mkdir -p "$VERSIONS_DIR"',
        'STAGING="$(mktemp -d "$VERSIONS_DIR/.marscode-stage-XXXXXX")"',
        'tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components=1',
        '"$STAGING/t3" --version >/dev/null',
        `printf '%s\\n' ${qVer} > "$STAGING/.install-complete"`,
        `printf '%s\\n' ${qSha} > "$STAGING/.marscode-sha"`,
        'rm -rf "$TARGET_DIR"',
        'mv "$STAGING" "$TARGET_DIR"',
        'rm -rf "$TARGET_DIR/${STAGING##*/}" "$ARCHIVE"',
        "trap - EXIT HUP INT TERM",
      ].join("\n")
    : "";

  return [
    "set -eu",
    `T3_HOME=${t3HomeExpr}`,
    'VERSIONS_DIR="$T3_HOME/runtime/versions"',
    `TARGET_DIR="$VERSIONS_DIR"/${qVer}`,
    unpackBlock,
    `if [ ! -x "$TARGET_DIR/t3" ] || [ "$(cat "$TARGET_DIR/.install-complete" 2>/dev/null || true)" != ${qVer} ] || [ "$(cat "$TARGET_DIR/.marscode-sha" 2>/dev/null || true)" != ${qSha} ]; then`,
    '  printf "MISSING_STAGE\\n"',
    "  exit 2",
    "fi",
    READ_ONLY_ACTIVE_RUNS_SH,
    'export T3CODE_HOME="$T3_HOME"',
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    `"$TARGET_DIR/t3" update ${qVer} --yes --allow-downgrade`,
    "if command -v systemctl >/dev/null 2>&1 && systemctl --user cat t3code.service >/dev/null 2>&1; then",
    "  WAIT_SVC=0",
    '  while [ "$WAIT_SVC" -lt 20 ]; do',
    '    SVC_STATE="$(systemctl --user is-active t3code.service 2>/dev/null || true)"',
    '    if [ "$SVC_STATE" = active ]; then break; fi',
    '    if [ "$SVC_STATE" = failed ]; then printf "SERVICE_FAILED\\n" >&2; exit 1; fi',
    "    sleep 0.5",
    "    WAIT_SVC=$((WAIT_SVC + 1))",
    "  done",
    '  systemctl --user is-active --quiet t3code.service || { printf "SERVICE_INACTIVE\\n" >&2; exit 1; }',
    "fi",
    `printf "ACTIVATED %s\\n" ${qVer}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the remote POSIX shell script run over `ssh host sh -s` on a macOS ARM64 host to update
 * its warm worktree, build `--platform mac --target dir --arch arm64` logged to disk, check active
 * runs read-only, quit gracefully when running and idle, atomically swap the `.app`, and relaunch.
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
    'export PATH="$HOME/.local/share/ship-queue-ci/bin:$HOME/.local/bin:$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'if [ -d "$HOME/.local/share/ship-queue-ci/vite-plus" ]; then export VP_HOME="$HOME/.local/share/ship-queue-ci/vite-plus"; fi',
    `REPO=${repoExpr}`,
    `DATA_ROOT=${dataRootExpr}`,
    `APP_PATH=${appPathExpr}`,
    `T3_HOME=${t3HomeExpr}`,
    `HEAD_SHA=${qSha}`,
    `VERSION=${qVer}`,
    'WORKTREE="$DATA_ROOT/sync-worktree"',
    'STAGED_ROOT="$DATA_ROOT/staged-app"',
    'STAGED_DIR="$STAGED_ROOT/$HEAD_SHA"',
    'BUILD_LOG="$DATA_ROOT/last-build.log"',
    'REOPEN_MARKER="$DATA_ROOT/.reopen-app"',
    'LOCK_DIR="$DATA_ROOT/.sync.lock"',
    'APP_STAGE=""',
    'mkdir -p "$DATA_ROOT" "$STAGED_ROOT"',
    "acquire_lock() {",
    '  if mkdir "$LOCK_DIR" 2>/dev/null; then',
    '    printf "%s\\n" "$$" > "$LOCK_DIR/pid"',
    "    return 0",
    "  fi",
    '  OLD_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"',
    "  STALE=0",
    '  if [ -n "$OLD_PID" ] && ! kill -0 "$OLD_PID" 2>/dev/null; then',
    "    STALE=1",
    '  elif [ -z "$OLD_PID" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then',
    "    STALE=1",
    '  elif [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then',
    "    STALE=1",
    "  fi",
    '  if [ "$STALE" -eq 1 ]; then',
    '    rm -rf "$LOCK_DIR"',
    '    if mkdir "$LOCK_DIR" 2>/dev/null; then',
    '      printf "%s\\n" "$$" > "$LOCK_DIR/pid"',
    "      return 0",
    "    fi",
    "  fi",
    "  return 1",
    "}",
    "if ! acquire_lock; then",
    '  printf "DEFERRED sync_locked\\n"',
    "  exit 0",
    "fi",
    'trap \'rm -rf "${APP_STAGE:-}" "$LOCK_DIR"\' EXIT HUP INT TERM',
    'if [ ! -d "$REPO/.git" ]; then',
    '  printf "MISSING_REPO %s\\n" "$REPO" >&2',
    "  exit 2",
    "fi",
    'if [ ! -d "$STAGED_DIR/app.bundle" ]; then',
    "  (",
    '    git -C "$REPO" fetch --quiet origin main',
    '    if [ ! -e "$WORKTREE/.git" ]; then',
    '      git -C "$REPO" worktree add --detach "$WORKTREE" "$HEAD_SHA"',
    "    else",
    '      git -C "$WORKTREE" reset --hard --quiet',
    '      git -C "$WORKTREE" clean -fd --quiet',
    '      git -C "$WORKTREE" checkout --detach --quiet "$HEAD_SHA"',
    "    fi",
    '    cd "$WORKTREE"',
    "    export VP_GIT_HOOKS=0",
    "    unset CARGO_TARGET_DIR T3CODE_DESKTOP_OUTPUT_DIR T3CODE_DESKTOP_MOCK_UPDATES || true",
    '    command -v vp >/dev/null 2>&1 || { printf "VP_NOT_FOUND\\n" >&2; exit 1; }',
    "    vp install --frozen-lockfile --ignore-scripts",
    '    T3CODE_DESKTOP_VERSION="$VERSION" node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64',
    '  ) >"$BUILD_LOG" 2>&1 || { tail -n 40 "$BUILD_LOG" >&2; exit 1; }',
    '  BUILT_APP="$(find "$WORKTREE/release/mac-arm64" -maxdepth 1 -name "*.app" -type d | head -n 1)"',
    '  [ -n "$BUILT_APP" ] || { printf "NO_MAC_APP_BUILT\\n" >&2; exit 1; }',
    '  rm -rf "$STAGED_DIR.tmp" "$STAGED_DIR"',
    '  mkdir -p "$STAGED_DIR.tmp"',
    '  ditto "$BUILT_APP" "$STAGED_DIR.tmp/app.bundle"',
    '  mv "$STAGED_DIR.tmp" "$STAGED_DIR"',
    '  find "$STAGED_ROOT" -mindepth 1 -maxdepth 1 ! -name "$HEAD_SHA" -exec rm -rf {} +',
    "fi",
    READ_ONLY_ACTIVE_RUNS_SH,
    "app_running() {",
    '  ps -axo command= | grep -Fq "$APP_PATH/Contents/MacOS/"',
    "}",
    "WAS_RUNNING=0",
    'if [ -f "$REOPEN_MARKER" ]; then WAS_RUNNING=1; fi',
    "if app_running; then",
    "  WAS_RUNNING=1",
    '  : > "$REOPEN_MARKER"',
    `  if ! osascript -e 'on run argv' -e 'tell application (item 1 of argv) to quit' -e 'end run' -- ${qAppName} >/dev/null 2>&1; then`,
    "    if app_running; then",
    '      rm -f "$REOPEN_MARKER"',
    '      printf "DEFERRED quit_failed\\n"',
    "      exit 0",
    "    fi",
    "  fi",
    "  WAITED=0",
    '  while app_running && [ "$WAITED" -lt 30 ]; do',
    "    sleep 0.5",
    "    WAITED=$((WAITED + 1))",
    "  done",
    "  if app_running; then",
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
    'APP_STAGE=""',
    'rm -rf "$APP_OLD" "$STAGED_DIR"',
    'if [ "$WAS_RUNNING" -eq 1 ]; then',
    '  open -a "$APP_PATH"',
    '  rm -f "$REOPEN_MARKER"',
    "fi",
    'printf "ACTIVATED %s\\n" "$VERSION"',
  ].join("\n");
}
