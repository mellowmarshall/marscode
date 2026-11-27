// @effect-diagnostics nodeBuiltinImport:off - Hygiene gate tests over real temporary git repositories with a stubbed gh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { scannerHygieneGate } from "./hygieneGate.ts";
import { jobEvidenceDir } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import type { HygieneGate, ProcessInput, ProcessRunner } from "./types.ts";

const NOREPLY = "12345+octo-dev@users.noreply.github.com";
const JOB = "1042";

let tmp: string;
let repo: string;
let base: string;
let denyFile: string;
let ghCalls: string[];

function git(args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Octo Dev",
        GIT_AUTHOR_EMAIL: NOREPLY,
        GIT_COMMITTER_NAME: "Octo Dev",
        GIT_COMMITTER_EMAIL: NOREPLY,
      },
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function commitFile(file: string, text: string): void {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, file), text);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `add ${file}`]);
}

/** Real git; `gh` answers `visibility` (or fails), and the host guard reports a text guard. */
function runner(visibility: string | null): ProcessRunner {
  return async (input: ProcessInput) => {
    if (input.command === "gh") {
      ghCalls.push(input.args.join(" "));
      return visibility === null
        ? { exitCode: 1, stdout: "", stderr: "HTTP 502" }
        : { exitCode: 0, stdout: `${visibility}\n`, stderr: "" };
    }
    if (input.command === "marscode-host-guard") {
      return { exitCode: 0, stdout: "text-guard\n", stderr: "" };
    }
    return nodeProcessRunner(input);
  };
}

function gate(visibility: string | null, env?: Record<string, string>): HygieneGate {
  return scannerHygieneGate(
    runner(visibility),
    env ?? { MARSCODE_HYGIENE_DENYLIST: denyFile, HOME: "/home/dev" },
  );
}

function input(title = "feat: add notes", body = "Closes #3\n") {
  const bodyFile = NodePath.join(tmp, "body.md");
  NodeFS.writeFileSync(bodyFile, body);
  return {
    jobId: JOB,
    queueRoot: NodePath.join(tmp, "queue"),
    worktree: repo,
    repo: "acme-fixture/fallback",
    baseSha: base,
    title,
    bodyFile,
  };
}

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-hygiene-")));
  repo = NodePath.join(tmp, "repo");
  NodeFS.mkdirSync(repo);
  ghCalls = [];
  git(["init", "-q", "-b", "main"]);
  commitFile(
    ".gitignore",
    ".env*\n/plans/\n.claude/settings.local.json\n/fleet-shape.json\n/ci-hosts.json\n",
  );
  commitFile(".tree-guard.conf", "ship_gh_repo=acme-fixture/sample-repo\n");
  base = git(["rev-parse", "HEAD"]);
  denyFile = NodePath.join(tmp, "deny");
  NodeFS.writeFileSync(denyFile, "@class host-names\nwidget-box-\\d+\n", { mode: 0o600 });
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

describe("scannerHygieneGate", () => {
  it("skips a private repo with one log line, asks gh once per job, and needs no denylist", async () => {
    commitFile("notes.md", "/data/Dev/project-a\n");
    const noDenylist = gate("private", { MARSCODE_HYGIENE_DENYLIST: "/nonexistent/deny" });
    expect(await noDenylist(input())).toEqual({
      kind: "skip",
      log: "house hygiene: skipped (acme-fixture/sample-repo is private)",
    });
    await noDenylist(input());
    expect(ghCalls).toEqual(["api repos/acme-fixture/sample-repo --jq .visibility"]);
  });

  it("scans an unknown-visibility repo as public and fails closed without the denylist", async () => {
    const verdict = await gate(null, {
      MARSCODE_HYGIENE_DENYLIST: "/home/dev/.config/deny",
      HOME: "/home/dev",
    })(input());
    expect(verdict).toMatchObject({ kind: "fail", reason: "house_hygiene_denylist_missing" });
    expect(verdict.log).toContain("visibility unknown, scanned as public");
    expect(verdict.log).toContain("~/.config/deny");
    expect(verdict.log).not.toContain("/home/dev");
  });

  it("fails on range and PR text findings with class ids and locations only", async () => {
    commitFile("notes.md", "ok\nworktree /data/Dev/widget-lab\nwidget-box-9\n");
    const verdict = await gate("public")(
      input("feat: notes", "Closes #3\nRan job=4821 on load1=2.5\n"),
    );
    expect(verdict.kind).toBe("fail");
    if (verdict.kind !== "fail") return;
    expect(verdict.reason).toBe(
      "house_hygiene classes=data-layout,host-names,operational-telemetry",
    );
    expect(verdict.log).toContain("data-layout notes.md:2 (public:data-dev-root)");
    expect(verdict.log).toMatch(/host-names [0-9a-f]{12}:notes\.md:3 \(private:host-names\)/);
    expect(verdict.log).toContain("operational-telemetry pr-body:2 (public:job-id)");
    expect(verdict.log).not.toMatch(/project-a|widget|4821/);
    expect(
      NodeFS.existsSync(NodePath.join(jobEvidenceDir(input().queueRoot, JOB), "hygiene.json")),
    ).toBe(false);
  });

  it("writes the hygiene receipt on a clean public job", async () => {
    commitFile("notes.md", "neutral text for /home/dev\n");
    const verdict = await gate("public")(input());
    expect(verdict.kind).toBe("pass");
    const receiptPath = NodePath.join(jobEvidenceDir(input().queueRoot, JOB), "hygiene.json");
    const receipt = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      schema: "playbook-evidence/v1",
      section: "hygiene",
      status: "pass",
      jobId: JOB,
      tree: git(["rev-parse", "HEAD^{tree}"]),
      measurements: {
        surfaces: ["tree", "history", "commit-metadata", "github-text"],
        layers: ["ship-gate", "text-guard"],
        privateDenylist: "applied",
      },
    });
  });
});
