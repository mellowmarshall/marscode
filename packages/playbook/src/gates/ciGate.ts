// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check ci`: deterministic CI and test efficiency gate (port of `pb_ci_eval.py`).
 * Detects static sleeps, per-test DB recreation thrash, forced serial runners/loops,
 * monolithic CI scripts lacking fast-path tier branching, and colocated browser e2e in `test`.
 */
import * as NodePath from "node:path";

import { listedFiles, readWorktreeFile } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { isRecord } from "../strictJson.ts";

const CHECK = "ci";
const SHELL_SLEEP_RE = /^\s*sleep\s+([0-9]+(?:\.[0-9]+)?)\s*(?:$|#|;|&&|\|\|)/;
const JS_SLEEP_RE =
  /(?:setTimeout\s*\(\s*[^,]+,\s*([0-9]{3,})\s*\)|await\s+new\s+Promise\s*\(\s*[a-zA-Z_]+\s*=>\s*setTimeout\s*\(\s*[a-zA-Z_]+,\s*([0-9]{3,})\s*\)\s*\))/;
const PY_SLEEP_RE =
  /^\s*(?:await\s+)?(?:time\.sleep|asyncio\.sleep)\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/;
const DB_MIGRATE_RE =
  /(?:prisma(?:\.[a-zA-Z_]+)*\.migrate\.reset|prisma\s+migrate\s+reset|\.sync\s*\(\s*\{\s*force\s*:\s*true|dropDatabase\s*\(|createDatabase\s*\(|DROP\s+DATABASE|CREATE\s+TABLE|alembic\s+upgrade\s+head|sqlx\s+migrate\s+run|diesel\s+migration\s+run|hibernate\.hbm2ddl\.auto\s*=\s*create-drop|docker(?:-compose)?\s+up)/i;
const SERIAL_RUNNER_RE =
  /(?:--runInBand|maxWorkers\s*:\s*1\b|threads\s*:\s*false\b|--test-threads\s*=\s*1\b|-maxparallelthreads\s+1\b|-p\s+1\b)/;
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$|\btests?\/|__tests__\/)/i;
const SLEEP_EXTS = new Set([
  ".sh",
  ".bash",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);
const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".rb",
  ".java",
  ".kt",
  ".cs",
]);
const CONFIG_BASENAMES = new Set([
  "package.json",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  "pytest.ini",
  "pyproject.toml",
  "Cargo.toml",
]);
const CI_SCRIPT_BASENAMES = new Set(["ci-local.sh", "ci.sh", "test.sh"]);
const TIER_BRANCH_RE = /\$\{?1\b|\$FAST\b|\$\{FAST|\bCI_TIER\b|case\s+["']?\$\{?(?:1|TIER)/;
const SERIAL_LOOP_TEST_RE =
  /\b(?:npm|yarn|pnpm|cargo|pytest|go|dotnet|mvn|gradle|composer)\s+test\b/;
const E2E_RUNNER_RE = /\b(?:playwright|cypress|selenium)\b/;

export interface CiFinding {
  readonly category: "static-sleep" | "db-thrash" | "serialization" | "tiering";
  readonly file: string;
  readonly line?: number | undefined;
  readonly message: string;
}

function scanCiFindings(root: string, files: ReadonlyArray<string>): ReadonlyArray<CiFinding> {
  const findings: CiFinding[] = [];
  for (const rel of files) {
    const ext = NodePath.posix.extname(rel);
    const base = NodePath.posix.basename(rel);
    const isTest = TEST_FILE_RE.test(rel);
    const isCiScript = CI_SCRIPT_BASENAMES.has(base) || rel.startsWith("scripts/ci");
    const isParallelTarget =
      (CONFIG_BASENAMES.has(base) || rel.endsWith(".sh") || base === "Makefile") &&
      !(isTest || rel.endsWith(".test.sh"));
    const needsSleep =
      SLEEP_EXTS.has(ext) && (isTest || isCiScript || ext === ".sh" || ext === ".bash");
    const needsDb = isTest && CODE_EXTS.has(ext);
    if (!needsSleep && !needsDb && !isParallelTarget && !isCiScript && rel !== "package.json") {
      continue;
    }
    const content = readWorktreeFile(root, rel);
    if (content === null) continue;
    const lines = content.split("\n");

    if (needsSleep) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        let wait: string | null = null;
        if (ext === ".sh" || ext === ".bash" || rel.endsWith(".sh")) {
          const m = SHELL_SLEEP_RE.exec(line);
          if (m?.[1]) wait = `${m[1]}s`;
        } else if (ext === ".py") {
          const m = PY_SLEEP_RE.exec(line);
          if (m?.[1]) wait = `${m[1]}s`;
        } else {
          const m = JS_SLEEP_RE.exec(line);
          if (m?.[1] || m?.[2]) wait = `${m[1] ?? m[2]}ms`;
        }
        if (wait) {
          findings.push({
            category: "static-sleep",
            file: rel,
            line: i + 1,
            message: `static wait (${wait}) introduces arbitrary latency`,
          });
        }
      }
    }

    if (needsDb) {
      let inHook = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const lower = line.toLowerCase();
        if (
          lower.includes("beforeeach") ||
          lower.includes("setup_method") ||
          lower.includes("setup_function") ||
          (lower.includes("@pytest.fixture") &&
            !lower.includes('scope="session"') &&
            !lower.includes("scope='session'"))
        ) {
          inHook = true;
        } else if (
          lower.includes("aftereach") ||
          lower.includes("teardown_method") ||
          (inHook && line.trimStart().startsWith("def test_"))
        ) {
          inHook = false;
        }
        if (inHook || lower.includes("beforeeach")) {
          const m = DB_MIGRATE_RE.exec(line);
          if (m) {
            findings.push({
              category: "db-thrash",
              file: rel,
              line: i + 1,
              message: `DDL migration/creation '${m[0]}' inside per-test hook`,
            });
          }
        }
      }
    }

    if (isParallelTarget) {
      let inLoop = false;
      let loopLine = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const sm = SERIAL_RUNNER_RE.exec(line);
        if (sm) {
          findings.push({
            category: "serialization",
            file: rel,
            line: i + 1,
            message: `forced serial execution flag '${sm[0]}' throttles concurrency`,
          });
        }
        if (/^\s*for\s+[a-zA-Z0-9_]+\s+in\s+.*\bdone\b/.test(line)) {
          inLoop = false;
        } else if (/^\s*for\s+[a-zA-Z0-9_]+\s+in\s+/.test(line)) {
          inLoop = true;
          loopLine = i + 1;
        } else if (inLoop && /\bdone\b/.test(line)) {
          inLoop = false;
        }
        if (inLoop && SERIAL_LOOP_TEST_RE.test(line)) {
          findings.push({
            category: "serialization",
            file: rel,
            line: loopLine || i + 1,
            message: "serial shell loop running test command across directories",
          });
          inLoop = false;
        }
      }
    }

    if (isCiScript && !TIER_BRANCH_RE.test(content)) {
      findings.push({
        category: "tiering",
        file: rel,
        message: "monolithic CI script lacks fast-path tier branching (no $1 or $FAST handling)",
      });
    }

    if (rel === "package.json") {
      try {
        const pkg = JSON.parse(content) as unknown;
        const testCmd =
          isRecord(pkg) && isRecord(pkg.scripts) && typeof pkg.scripts.test === "string"
            ? pkg.scripts.test
            : "";
        if (E2E_RUNNER_RE.test(testCmd)) {
          findings.push({
            category: "tiering",
            file: rel,
            message: "heavy browser/e2e runner colocated in default 'test' command",
          });
        }
      } catch {
        // invalid package.json ignored here
      }
    }
  }
  return findings;
}

export function ciGate(input: { readonly root: string }): CheckResult {
  const files = listedFiles(input.root);
  if (files === null) return unproven(CHECK, "git cannot list files for CI evaluation");
  const findings = scanCiFindings(input.root, files);
  if (findings.length > 0) {
    return failed(CHECK, `${findings.length} CI efficiency finding(s)`, {
      errors: findings.map(
        (f) => `${f.file}${f.line ? `:${f.line}` : ""} [${f.category}]: ${f.message}`,
      ),
      files: [...new Set(findings.map((f) => f.file))].slice(0, 8),
      fix: "replace static sleeps with event waits, migrate once per suite, enable parallel workers, and add fast-path CI tiers",
    });
  }
  return passed(CHECK, `scanned ${files.length} file(s); no CI efficiency antipatterns detected`);
}
