// @effect-diagnostics nodeBuiltinImport:off - CLI integration tests drive real temp git repos with node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { runHygieneCli } from "./cli.ts";
import { HYGIENE_CLASSES } from "./hygieneCatalog.ts";

const NOREPLY = "12345+octo-dev@users.noreply.github.com";
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let repo: string;
let denyFile: string;
const dirs: string[] = [];

function git(args: ReadonlyArray<string>, env: Record<string, string> = {}): string {
  const res = NodeChildProcess.spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function write(file: string, text: string): void {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, file), text);
}

function commit(message: string, email = NOREPLY): string {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message], {
    GIT_AUTHOR_NAME: "Octo Dev",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "Octo Dev",
    GIT_COMMITTER_EMAIL: email,
  });
  return git(["rev-parse", "HEAD"]);
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function cli(
  argv: ReadonlyArray<string>,
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Result {
  let out = "";
  let err = "";
  const code = runHygieneCli(argv, {
    cwd: repo,
    env: opts.env ?? { MARSCODE_HYGIENE_DENYLIST: denyFile, HOME: "/home/dev" },
    out: (t) => (out += t),
    err: (t) => (err += t),
    readStdin: () => opts.stdin ?? "",
    textGuard: () => true,
  });
  return { code, out, err };
}

beforeEach(() => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hygiene-cli-")),
  );
  dirs.push(dir);
  repo = NodePath.join(dir, "repo");
  NodeFS.mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Octo Dev"]);
  git(["config", "user.email", NOREPLY]);
  write(
    ".gitignore",
    ".env*\n!.env.example\n/plans/\n.claude/settings.local.json\n/fleet-shape.json\n/ci-hosts.json\n",
  );
  write("README.md", "# sample\n");
  commit("init");
  denyFile = NodePath.join(dir, "deny");
  NodeFS.writeFileSync(denyFile, "@class host-names\nwidget-box-\\d+\n", { mode: 0o600 });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("tree", () => {
  it("is clean on a neutral tree and exits 1 with class and location only", () => {
    expect(cli(["tree"]).code).toBe(0);
    write("notes.md", "ok\nworktree /data/Dev/widget-lab\nhost widget-box-7\n");
    commit("notes");
    const res = cli(["tree"]);
    expect(res.code).toBe(1);
    expect(res.out.split("\n").filter(Boolean)).toEqual([
      "data-layout notes.md:2 (public:data-dev-root)",
      "host-names notes.md:3 (private:host-names)",
    ]);
    expect(res.out + res.err).not.toMatch(/project-a|widget/);
  });

  it("fails a missing denylist naming the expected path, except under --public-only", () => {
    const env = { MARSCODE_HYGIENE_DENYLIST: "/nonexistent/deny", HOME: "/home/dev" };
    const res = cli(["tree"], { env });
    expect(res.code).toBe(1);
    expect(res.err).toContain("expected at /nonexistent/deny");
    expect(cli(["tree", "--public-only"], { env }).code).toBe(0);
  });

  it("exits 2 on a group-readable denylist", () => {
    NodeFS.chmodSync(denyFile, 0o644);
    const res = cli(["tree"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("chmod 600");
  });

  it("flags tracked local-only files and missing ignore coverage", () => {
    write(".gitignore", "node_modules\n");
    write("app.log", "x\n");
    commit("oops");
    const lines = cli(["tree"]).out;
    expect(lines).toContain("local-only-files app.log:0 (public:tracked-log)");
    expect(lines).toContain("local-only-files .gitignore:0 (public:ignore-env)");
    expect(lines).toContain("local-only-files .gitignore:0 (public:ignore-plans)");
  });

  it("skips declared exclusions and honors scoped exceptions", () => {
    write("vendor/up/a.md", "/data/Dev/widget-lab\n");
    write("docs/b.md", "/data/Dev/gadget-lab\n");
    write(
      "hygiene.exceptions.json",
      JSON.stringify({
        exclusions: [{ path: "vendor/", reason: "vendored upstream code, read-only", issue: "#9" }],
        exceptions: [
          {
            classId: "data-layout",
            file: "docs/b.md",
            reason: "documents the layout rule itself",
            issue: "#9",
          },
        ],
      }),
    );
    commit("vendor");
    expect(cli(["tree"]).code).toBe(0);
  });
});

describe("staged and commit-msg", () => {
  it("scans only staged added lines and new paths", () => {
    write("a.md", "fine\nwidget-box-3\n");
    write(".env", "TOKEN=x\n");
    git(["add", "-f", "a.md", ".env"]);
    const res = cli(["staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("host-names a.md:2 (private:host-names)");
    expect(res.out).toContain("local-only-files .env:0 (public:tracked-env)");
  });

  it("checks the message, trailers, and the configured identity", () => {
    const msg = NodePath.join(repo, ".git", "MSG");
    NodeFS.writeFileSync(
      msg,
      `fix: tidy\n\nCo-authored-by: MarsCode Agent <${UUID}@agents.local>\n# comment\n`,
    );
    expect(cli(["commit-msg", msg]).code).toBe(0);
    NodeFS.writeFileSync(msg, "fix: tidy\n\nCo-authored-by: Pat Example <pat@example.com>\n");
    expect(cli(["commit-msg", msg]).out).toContain(
      "commit-identity commit-msg:3 (public:trailer-email)",
    );
    git(["config", "user.email", "octo@example.com"]);
    expect(cli(["commit-msg", msg]).out).toContain(
      "commit-identity author:0 (public:noreply-identity)",
    );
  });
});

describe("range", () => {
  it("covers added lines, messages, identities, and tags in the range", () => {
    const base = git(["rev-parse", "HEAD"]);
    write("b.md", "path /data/Dev/widget-lab\n");
    const sha = commit(
      `feat: b\n\nCo-authored-by: Tidy Widgets <${UUID}@agents.local>`,
      "dev@example.com",
    );
    git(["tag", "-a", "v0.0.1", "-m", "release"], { GIT_COMMITTER_EMAIL: "dev@example.com" });
    const res = cli(["range", base]);
    const short = sha.slice(0, 12);
    expect(res.code).toBe(1);
    expect(res.out).toContain(`data-layout ${short}:b.md:1 (public:data-dev-root)`);
    expect(res.out).toContain(`agent-session-ids ${short}:message:3 (public:agents-local)`);
    expect(res.out).toContain(`commit-identity ${short}:author:0 (public:noreply-identity)`);
    expect(res.out).toMatch(
      /commit-identity tag@[0-9a-f]{12}:tagger:0 \(public:noreply-identity\)/,
    );
    expect(cli(["range", sha]).code).toBe(0);
  });
});

describe("text and usage", () => {
  it("scans stdin with a surface and rejects malformed commands", () => {
    const body = "Closes #3\n\nAdds a scanner. Cost $4.20 in total.\n";
    expect(cli(["text", "-", "--source", "pr-body"], { stdin: body }).code).toBe(0);
    const res = cli(["text", "-", "--source", "pr-body", "--surface", "github-text"], {
      stdin: body,
    });
    expect(res.out).toBe("operational-telemetry pr-body:3 (public:cost-total)\n");
    expect(cli(["text", "-"]).code).toBe(2);
    expect(cli(["text", "-", "--source", "x", "--surface", "nope"]).code).toBe(2);
    expect(cli(["bogus"]).code).toBe(2);
    expect(cli([]).code).toBe(2);
  });
});

describe("evidence", () => {
  it("writes a receipt bound to HEAD with every class and only the detected layers", () => {
    const base = git(["rev-parse", "HEAD"]);
    write(".githooks/pre-commit", '#!/bin/sh\nnode "$root/packages/hygiene/src/bin.ts" staged\n');
    write(".tree-guard.conf", "ship_ci=scripts/ci.sh\n");
    write("scripts/ci.sh", "node packages/hygiene/src/bin.ts tree --public-only\n");
    commit("wire layers");
    const out = NodePath.join(NodePath.dirname(repo), "receipt.json");
    const body = NodePath.join(NodePath.dirname(repo), "body.md");
    NodeFS.writeFileSync(body, "Closes #3\n");
    const res = cli([
      "evidence",
      "--base",
      base,
      "--out",
      out,
      "--body",
      body,
      "--title",
      "feat: x",
    ]);
    expect(res.code).toBe(0);
    const receipt = JSON.parse(NodeFS.readFileSync(out, "utf8"));
    expect(receipt).toMatchObject({
      schema: "playbook-evidence/v1",
      section: "hygiene",
      status: "pass",
      tree: git(["rev-parse", "HEAD^{tree}"]),
      measurements: {
        surfaces: ["tree", "history", "commit-metadata", "github-text"],
        layers: ["pre-commit", "ci", "text-guard"],
        privateDenylist: "applied",
      },
    });
    expect(receipt.checks.map((c: { name: string }) => c.name)).toEqual([...HYGIENE_CLASSES]);
  });
});
