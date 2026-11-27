// @effect-diagnostics nodeBuiltinImport:off - Real temp git repositories for the playbook engine's tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_EVIDENCE_DIR, EVIDENCE_SCHEMA } from "../evidence.ts";

/** A fixed clock for every test: no test reads the wall clock. */
export const FIXED_TODAY = "2026-11-27";
export const FIXED_NOW = "2026-11-27T12:00:00.000Z";
const FIXTURE_ORIGIN = "https://github.com/acme-fixture/sample-repo.git";

/** An env in which the guard client never finds a broker socket (no owner prompt from a test). */
export const NO_BROKER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  CI: "",
  T3_GUARD_GRANT_SOCKET: "",
  SHIP_QUEUE_JOB: "",
  SHIP_QUEUE_BODYFILE: "",
  SHIP_QUEUE_ONTO: "",
  SHIP_QUEUE_BASE_SHA: "",
  PLAYBOOK_CHALLENGE_ADVISORY: "",
  PLAYBOOK_EVIDENCE_DIR: "",
  PLAYBOOK_EVIDENCE_JOB: "",
};

const created: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
}

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

export interface FixtureRepo {
  readonly root: string;
  readonly write: (rel: string, content: string) => void;
  readonly writeJson: (rel: string, value: unknown) => void;
  readonly commit: (message: string) => string;
  readonly tree: () => string;
  readonly branch: (name: string) => void;
}

/** A repo on branch `trunk` whose origin names the acme-fixture org (never a guarded owner). */
export function makeFixtureRepo(prefix = "pb-fixture-"): FixtureRepo {
  const root = NodePath.join(makeTempDir(prefix), "sample-repo");
  NodeFS.mkdirSync(root);
  runGit(root, ["init", "-q", "-b", "trunk"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["remote", "add", "origin", FIXTURE_ORIGIN]);
  const write = (rel: string, content: string) => {
    const full = NodePath.join(root, rel);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, content);
  };
  return {
    root,
    write,
    writeJson: (rel, value) => write(rel, `${JSON.stringify(value, null, 2)}\n`),
    commit: (message) => {
      runGit(root, ["add", "-A"]);
      runGit(root, ["commit", "-q", "--allow-empty", "-m", message]);
      return runGit(root, ["rev-parse", "HEAD"]);
    },
    tree: () => runGit(root, ["rev-parse", "HEAD^{tree}"]),
    branch: (name) => runGit(root, ["checkout", "-q", "-b", name]),
  };
}

/** A PLAYBOOK.md with every numbered section (§0–§15) the challenger requires, and §2.2's reviewer bullet. */
export function fixturePlaybookMd(): string {
  const titles = [
    "Terms",
    "Contracts, Growth & Scoped Exceptions",
    "Ship queue",
    "File size ratchet",
    "Declarations and generations",
    "Contract changes",
    "Fleet shape",
    "DB dictionary",
    "Destructive gates",
    "User actions catalog",
    "Design rules",
    "Optimization budgets",
    "System maps",
    "Declared checks & Dead code",
    "CI standards and execution tiers",
    "Product docs",
  ];
  return titles
    .map((title, n) => {
      const extra =
        n === 2
          ? "\n- **2.2 The reviewer (`playbook challenge`):** judges strictly against this playbook.\n"
          : n === 3
            ? "\n- **3.1 Domain-seam splits (`<= 500` lines):** 500 lines.\n"
            : n === 9
              ? "\n- **9.2 Repo evidence:** test evidence.\n"
              : "";
      return `## ${n}. ${title}\n\nSection ${n} text.\n${extra}`;
    })
    .join("\n");
}

/** Minimal valid evidence-only declaration with explicit opt-outs for unused sections (§1.2). */
export function evidenceDeclaration(extra: object = {}, ci?: object) {
  return {
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    contracts: {
      size: { evidence: `${DEFAULT_EVIDENCE_DIR}/size.json` },
      fleet: { file: "fleet.json", evidence: `${DEFAULT_EVIDENCE_DIR}/fleet.json` },
      tools: { evidence: `${DEFAULT_EVIDENCE_DIR}/tools.json` },
      generations: { none: "no generated files in fixture" },
      intent: { none: "no public contract surfaces in fixture" },
      dictionary: { none: "no database schema in fixture" },
      migrations: { none: "no database migrations in fixture" },
      actions: { none: "no user action catalog in fixture" },
      design: { none: "no UI surfaces in fixture" },
      optimization: { none: "nothing to budget: no route, job or action" },
      maps: { none: "no system maps in fixture" },
      docs: { none: "no product docs in fixture" },
      ...extra,
    },
    ci: ci ?? { none: "no CI pipeline in minimal fixture" },
  };
}

/** Write a valid untracked `playbook-evidence/v1` receipt bound to REPO's current HEAD tree. */
export function writeEvidence(
  repo: FixtureRepo,
  section: string,
  overrides: Readonly<Record<string, unknown>> = {},
  relPath?: string,
): void {
  const base: Record<string, unknown> = {
    schema: EVIDENCE_SCHEMA,
    section,
    status: "pass",
    tree: repo.tree(),
    generatedAt: FIXED_NOW,
    summary: `${section} checks passed`,
    checks: [{ name: `${section}-check`, status: "pass", durationMs: 42 }],
  };
  if (section === "ci") {
    base.durationMs = 500;
    base.measurements = { setupMs: 120, testMs: 380, tier1Ms: 500, selectedSuites: ["unit"] };
  }
  repo.writeJson(relPath ?? `${DEFAULT_EVIDENCE_DIR}/${section}.json`, { ...base, ...overrides });
}
