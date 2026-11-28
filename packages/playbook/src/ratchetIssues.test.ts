// @effect-diagnostics nodeBuiltinImport:off - Runs the real `playbook` bin with a stand-in gh on PATH over real temp checkouts.
/**
 * §1.3: a new scoped size exception for one tracked file whose issue is an open issue of this
 * repository passes the ratchet without the owner; everything else still takes the owner.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCheck } from "./checks.ts";
import { exceptionIssueRefs, type IssueLookup, type IssueState } from "./exceptionIssues.ts";
import { repoName } from "./git.ts";
import { declarationRatchet } from "./ratchet.ts";
import {
  cleanupTempDirs,
  evidenceDeclaration,
  FIXED_TODAY,
  makeFixtureRepo,
  makeTempDir,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const SIZE = ".playbook/evidence/size.json";
const exception = (subject: string, issue = "#41") => ({
  subject,
  reason: "splits along its parser seam next",
  issue,
});
const withSize = (exceptions: ReadonlyArray<object>, maxLines?: number) =>
  evidenceDeclaration({
    size: { evidence: SIZE, exceptions, ...(maxLines === undefined ? {} : { maxLines }) },
  });
const owner = (where: string, subject: string, why: string) =>
  `${where} adds scoped exception '${subject}' ${why} (requires owner override, §1.3)`;
/** Every subject is one tracked file, except those named in DIRS. */
const files =
  (dirs: ReadonlyArray<string> = []) =>
  (rel: string) =>
    dirs.includes(rel) ? "a directory scope" : null;

describe("size exceptions in the declaration ratchet", () => {
  const base = withSize([exception("src/old.ts")]);

  it("sets a new one-file size exception that names an issue apart from what takes the owner", () => {
    const head = withSize([exception("src/old.ts"), exception("./src//big.ts")]);
    const r = declarationRatchet(head, base, undefined, undefined, files());
    expect(r.problems).toEqual([]);
    expect(r.issueBacked).toEqual([
      { where: "size.exceptions", subject: "src/big.ts", refs: [{ repo: null, number: 41 }] },
    ]);
  });

  it("takes a re-spelled subject (./, //) as the same exception, never as a new one", () => {
    const head = withSize([exception("./src//old.ts")]);
    expect(declarationRatchet(head, base, undefined, undefined, files())).toEqual({
      problems: [
        "size.exceptions modifies scoped exception 'src/old.ts' (requires owner override, §1.3)",
      ],
      issueBacked: [],
    });
  });

  it("keeps the owner for a pattern or directory scope, a raised limit, and a changed exception", () => {
    const subjects = [
      "src/gen/*.ts",
      "src/a+.ts",
      "src/(x).ts",
      "src/a|b.ts",
      "^src.ts",
      "src$",
      "!src/a.ts",
    ];
    const head = withSize(
      [
        exception("src/old.ts", "#42"),
        ...subjects.map((s) => exception(s)),
        exception("src/vendor/"),
        exception("src/tree"),
      ],
      400,
    );
    const r = declarationRatchet(
      head,
      withSize([exception("src/old.ts")], 300),
      undefined,
      undefined,
      files(["src/tree"]),
    );
    expect(r.issueBacked).toEqual([]);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        ...subjects.map((s) => owner("size.exceptions", s, "with a pattern scope")),
        owner("size.exceptions", "src/tree", "with a directory scope"),
        owner("size.exceptions", "src/vendor/", "with a directory scope"),
        "size.exceptions modifies scoped exception 'src/old.ts' (requires owner override, §1.3)",
        "size.maxLines raised: 300 -> 400",
      ]),
    );
  });

  it("keeps the owner for an exception with no issue, and for another section's exception", () => {
    const design = { evidence: ".playbook/evidence/design.json" };
    const head = evidenceDeclaration({
      size: {
        evidence: SIZE,
        exceptions: [{ subject: "src/big.ts", reason: "tracked in #41 here" }],
      },
      design: { ...design, exceptions: [exception("src/raw.tsx")] },
    });
    const r = declarationRatchet(
      head,
      evidenceDeclaration({ design }),
      undefined,
      undefined,
      files(),
    );
    expect(r.issueBacked).toEqual([]);
    expect(r.problems).toEqual([
      owner("size.exceptions", "src/big.ts", "naming no issue"),
      "design.exceptions adds scoped exception 'src/raw.tsx' (requires owner override, §1.3)",
    ]);
  });

  it("holds the exceptions of a contract the base lacks or opted out of as new", () => {
    const optedOutBase = evidenceDeclaration({ size: { none: "no source files at all" } });
    const head = evidenceDeclaration({
      size: { evidence: SIZE, exceptions: [exception("src/big.ts"), exception("src/*.ts")] },
      design: {
        evidence: ".playbook/evidence/design.json",
        exceptions: [exception("src/raw.tsx")],
      },
    });
    // The base opted out of both: size by `none`, design as the fixture does.
    const r = declarationRatchet(head, optedOutBase, undefined, undefined, files());
    expect(r.issueBacked).toEqual([
      { where: "size.exceptions", subject: "src/big.ts", refs: [{ repo: null, number: 41 }] },
    ]);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        owner("size.exceptions", "src/*.ts", "with a pattern scope"),
        "design.exceptions adds scoped exception 'src/raw.tsx' (requires owner override, §1.3)",
      ]),
    );
  });

  it("reads the issue field only (the schema requires it)", () => {
    expect(exceptionIssueRefs({ issue: "acme/tools#7", reason: "see #9" })).toEqual([
      { repo: "acme/tools", number: 7 },
    ]);
    expect(exceptionIssueRefs({ reason: "tracked in #12" })).toEqual([]);
  });
});

function branchWith(exceptions: ReadonlyArray<object>, maxLines?: number) {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", withSize([], maxLines === undefined ? undefined : 300));
  repo.writeJson("fleet.json", starterShape("sample-repo"));
  repo.write("src/big.ts", "export const big = 1;\n");
  repo.write("src/gen/a.ts", "export const a = 1;\n");
  const base = repo.commit("base");
  repo.branch("feat/exception");
  repo.writeJson("playbook.json", withSize(exceptions, maxLines));
  return { repo, base };
}

async function ratchetOf(
  exceptions: ReadonlyArray<object>,
  issueState: IssueLookup,
  more: { readonly maxLines?: number; readonly signal?: AbortSignal; readonly base?: string } = {},
) {
  const { repo, base } = branchWith(exceptions, more.maxLines);
  if (more.base !== undefined) {
    repo.write("playbook.json", more.base);
    const broken = repo.commit("a base whose declaration does not parse");
    repo.writeJson("playbook.json", withSize(exceptions));
    return run(repo.root, broken, issueState, more.signal);
  }
  return run(repo.root, base, issueState, more.signal);
}

async function run(root: string, base: string, issueState: IssueLookup, signal?: AbortSignal) {
  const asked: string[] = [];
  const report = await runCheck({
    root,
    repo: repoName(root),
    contracts: ["size"],
    bypasses: {},
    today: FIXED_TODAY,
    base: { sha: base, name: "trunk", problem: null },
    env: NO_BROKER_ENV,
    issueState,
    signal,
    override: async (reason) => {
      asked.push(reason);
      return false;
    },
  });
  return { result: report.results.find((r) => r.check === "ratchet")!, asked };
}

const states =
  (map: Readonly<Record<number, IssueState>>, seen: string[] = []): IssueLookup =>
  async (repo, n) => {
    seen.push(`${repo}#${n}`);
    return map[n] ?? { kind: "unknown", why: "no such issue" };
  };

describe("playbook check ratchet with issue-backed size exceptions", () => {
  it("passes a tracked one-file size exception whose issue is open here, without the owner", async () => {
    const seen: string[] = [];
    const { result, asked } = await ratchetOf(
      [exception("src/big.ts")],
      states({ 41: { kind: "open" } }, seen),
    );
    expect(asked).toEqual([]);
    expect(seen).toEqual(["acme-fixture/sample-repo#41"]);
    expect(result.status).toBe("PASS");
    expect(result.summary).toBe(
      "playbook.json only tightens; 1 size exception(s) with an open issue (§1.3): 'src/big.ts' (#41)",
    );
    const sameRepo = await ratchetOf(
      [exception("src/big.ts", "Acme-Fixture/Sample-Repo#41")],
      states({ 41: { kind: "open" } }),
    );
    expect(sameRepo.result.status).toBe("PASS");
  });

  it("asks the owner for an issue of another repository, without asking GitHub", async () => {
    const seen: string[] = [];
    const { result } = await ratchetOf(
      [exception("src/big.ts", "acme/other#41")],
      states({ 41: { kind: "open" } }, seen),
    );
    expect(seen).toEqual([]);
    expect(result.errors).toEqual([
      "size.exceptions adds scoped exception 'src/big.ts': issue acme/other#41 is not in this repository (acme-fixture/sample-repo) (requires owner override, §1.3)",
    ]);
  });

  it("asks the owner for a closed or unreadable issue, an untracked file or a directory, and a raised limit", async () => {
    const closed = await ratchetOf([exception("src/big.ts")], states({ 41: { kind: "closed" } }));
    expect(closed.result.status).toBe("FAIL");
    expect(closed.asked).toEqual([
      "ratchet: size.exceptions adds scoped exception 'src/big.ts': issue #41 is closed (requires owner override, §1.3)",
    ]);
    const unknown = await ratchetOf([exception("src/big.ts", "#40")], states({}));
    expect(unknown.result.errors).toEqual([
      "size.exceptions adds scoped exception 'src/big.ts': issue #40 cannot be checked (no such issue) (requires owner override, §1.3)",
    ]);
    const open = states({ 41: { kind: "open" } });
    expect((await ratchetOf([exception("src/gen")], open)).result.errors).toEqual([
      owner("size.exceptions", "src/gen", "with a directory scope"),
    ]);
    expect((await ratchetOf([exception("src/new.ts")], open)).result.errors).toEqual([
      owner("size.exceptions", "src/new.ts", "with a file git does not track"),
    ]);
    const raised = await ratchetOf([exception("src/big.ts")], open, { maxLines: 400 });
    expect(raised.result.errors).toEqual(["size.maxLines raised: 300 -> 400"]);
  });

  it("stops the issue checks when the run is cancelled, and asks the owner", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await ratchetOf(
      [exception("src/big.ts")],
      states({ 41: { kind: "open" } }),
      {
        signal: controller.signal,
      },
    );
    expect(result.errors).toEqual([
      "size.exceptions adds scoped exception 'src/big.ts': issue #41 cannot be checked (the issue checks ran out of time) (requires owner override, §1.3)",
    ]);
  });

  it("reports UNPROVEN when the base's playbook.json does not parse", async () => {
    const { result } = await ratchetOf(
      [exception("src/big.ts")],
      states({ 41: { kind: "open" } }),
      {
        base: '{"contracts": ',
      },
    );
    expect(result.status).toBe("UNPROVEN");
    expect(result.summary).toMatch(/^the base's playbook\.json does not parse: /);
  });
});

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));

/** A stand-in gh on PATH that answers `gh api repos/R/issues/N` with BODIES[N], else fails. */
function ghOnPath(bodies: Readonly<Record<number, object>>): string {
  const dir = makeTempDir("pb-gh-");
  const cases = Object.entries(bodies)
    .map(([n, body]) => `  */${n}) printf '%s' '${JSON.stringify(body)}' ;;`)
    .join("\n");
  NodeFS.writeFileSync(
    NodePath.join(dir, "gh"),
    `#!/bin/sh\n[ "$1" = api ] || exit 2\ncase "$2" in\n${cases}\n  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return dir;
}

const issue = (n: number, state: string, extra: object = {}) => ({
  number: n,
  state,
  html_url: `https://github.com/acme-fixture/sample-repo/issues/${n}`,
  ...extra,
});

function cli(root: string, path: string) {
  const res = NodeChildProcess.spawnSync(process.execPath, [BIN, "-C", root, "check", "size"], {
    encoding: "utf8",
    env: { ...NO_BROKER_ENV, PATH: path },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

describe("playbook check (the real CLI) asks gh whether the exception's issue is open", () => {
  it("passes an open issue; fails closed on a closed issue, a pull request, a moved issue, or no gh", () => {
    const { repo, base } = branchWith([exception("src/big.ts")]);
    NodeChildProcess.spawnSync("git", [
      "-C",
      repo.root,
      "update-ref",
      "refs/remotes/origin/trunk",
      base,
    ]);
    NodeChildProcess.spawnSync("git", [
      "-C",
      repo.root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);
    // Only git and node: no real gh may answer (no test reaches GitHub).
    const tools = makeTempDir("pb-tools-");
    const gitBin = NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    NodeFS.symlinkSync(gitBin, NodePath.join(tools, "git"));
    NodeFS.symlinkSync(process.execPath, NodePath.join(tools, "node"));
    const ratchetLine = (gh: Readonly<Record<number, object>> | null) =>
      cli(repo.root, gh ? `${ghOnPath(gh)}:${tools}` : tools)
        .out.split("\n")
        .find((l) => l.includes("ratchet:"));
    expect(ratchetLine({ 41: issue(41, "open") })).toBe(
      "PASS ratchet: playbook.json only tightens; 1 size exception(s) with an open issue (§1.3): 'src/big.ts' (#41)",
    );
    expect(ratchetLine({ 41: issue(41, "closed") })).toContain("issue #41 is closed");
    expect(ratchetLine({ 41: issue(41, "open", { pull_request: { url: "x" } }) })).toContain(
      "acme-fixture/sample-repo#41 is a pull request",
    );
    expect(
      ratchetLine({
        41: issue(41, "open", { html_url: "https://github.com/acme-fixture/elsewhere/issues/3" }),
      }),
    ).toContain("is served as https://github.com/acme-fixture/elsewhere/issues/3 (moved?)");
    expect(ratchetLine(null)).toMatch(
      /FAIL ratchet: .*issue #41 cannot be checked \(gh is unavailable/,
    );
  });
});
