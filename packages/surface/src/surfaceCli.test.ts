// @effect-diagnostics nodeBuiltinImport:off - CLI integration tests drive the real bin and generator with node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const CONTRACT = "config/contracts/feature-surfaces.json";

let tmp: string;
let repo: string;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string, args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): Run {
  const res = NodeChildProcess.spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SHIP_QUEUE_BODYFILE: "", SHIP_QUEUE_JOB: "", ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const surface = (args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, [BIN, ...args], cwd, env);

function git(...args: string[]): void {
  const res = run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  expect(res.status, res.stderr).toBe(0);
}

function write(rel: string, text: string): void {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, rel)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, rel), text);
}

const ROUTES = (extra = "") =>
  "import type { FastifyInstance } from 'fastify';\nexport async function sampleRoutes(app: FastifyInstance) {\n" +
  "  app.get('/sample/items', async () => []);\n  app.post('/sample/items', async () => ({ id: 1 }));\n" +
  `${extra}}\n`;

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "surface-test-")));
  repo = NodePath.join(tmp, "mock-repo");
  NodeFS.mkdirSync(repo);
  git("init", "-q", "-b", "main", repo);
  write("apps/api/src/routes/sample.ts", ROUTES());
  write(
    "apps/web/lib/client.ts",
    "import { apiFetch } from './api';\nexport function getItems() {\n  return apiFetch('/sample/items');\n}\n",
  );
  write(
    "package.json",
    `${JSON.stringify({ name: "mock-repo", scripts: { test: "echo ok" } }, null, 2)}\n`,
  );
  write("AGENTS.md", "# Agent Notes\n## Local Overrides\n");
  git("add", ".");
  git("commit", "-qm", "initial commit");
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

function init(): void {
  const r = surface(["init"]);
  expect(r.status, r.stderr).toBe(0);
}

describe("surface CLI", () => {
  it("prints its help, and refuses to run outside a git repository", () => {
    expect(surface(["--help"], tmp).stdout).toContain("Provides sub-20ms lookup");
    const r = surface([], tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not inside a git repository");
  });

  it("asks for init when the repo has no surface", () => {
    const r = surface([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("surface init");
  });

  it("onboards a repository: generator, contract, package script, AGENTS.md, no gate", () => {
    init();
    expect(NodeFS.existsSync(NodePath.join(repo, CONTRACT))).toBe(true);
    expect(
      NodeFS.existsSync(NodePath.join(repo, "scripts/generate/derive-feature-surfaces.mjs")),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(repo, "scripts/gates"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(repo, "package.json"), "utf8")).toContain(
      "generate:feature-surfaces",
    );
    expect(NodeFS.readFileSync(NodePath.join(repo, "AGENTS.md"), "utf8")).toContain(
      "## Contract Intent",
    );
    const again = surface(["init"]);
    expect(again.stdout).toContain(
      "[keep] scripts/generate/derive-feature-surfaces.mjs (already exists)",
    );
    // The repo's own copy of the generator agrees with the contract init derived.
    expect(
      run(process.execPath, ["scripts/generate/derive-feature-surfaces.mjs", "--check"]).status,
    ).toBe(0);
  });

  it("removes a retired template module on --force", () => {
    init();
    write("scripts/generate/feature-surfaces/oldModule.mjs", "export {};\n");
    const r = surface(["init", "--force"]);
    expect(r.stdout).toContain(
      "[remove] scripts/generate/feature-surfaces/oldModule.mjs (retired template)",
    );
    expect(
      NodeFS.existsSync(NodePath.join(repo, "scripts/generate/feature-surfaces/oldModule.mjs")),
    ).toBe(false);
  });

  it("finds routes, api-only routes, client services and domains", () => {
    init();
    expect(surface(["items"]).stdout).toContain("/sample/items");
    const api = surface(["api", "sample"]);
    expect(api.status).toBe(0);
    expect(api.stdout).toContain("Handler File: apps/api/src/routes/sample.ts");
    expect(surface(["api", "apps/web/lib"]).stdout).toContain(
      'No routes or services match "apps/web/lib"',
    );
    expect(surface(["apps/web/lib"]).stdout).toContain("Client Calls: apps/web/lib/client.ts");
    expect(surface(["client", "client.ts"]).stdout).toContain("calls /sample/items");
    expect(surface(["--list"]).stdout).toMatch(/sample\s+\(routes: {3}1/);
    expect(surface([]).stdout).toContain("FEATURE SURFACE EXPLORER DASHBOARD");
  });

  it("prints JSON that survives a pipe whole", () => {
    init();
    const routes = JSON.parse(surface(["api", "", "--json"]).stdout) as Array<{
      methods: string[];
    }>;
    expect(routes[0]?.methods).toEqual(["GET", "POST"]);
    const dash = JSON.parse(surface(["--json"]).stdout) as {
      totalRoutes: number;
      domains: string[];
    };
    expect(dash.totalRoutes).toBe(1);
    expect(dash.domains).toEqual(["sample"]);
  });

  it("calls a surface with no route UNPROVEN (exit 3)", () => {
    write(CONTRACT, JSON.stringify({ meta: {}, routes: {}, domains: {} }));
    const r = surface([]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("UNPROVEN surface");
  });

  it("reads the surface file playbook.json declares", () => {
    write(
      "api/surface.json",
      JSON.stringify({
        routes: { "/declared": { method: "GET", path: "/declared", domain: "d" } },
      }),
    );
    write(
      "playbook.json",
      JSON.stringify({ contracts: { intent: { contracts: { surface: "api/surface.json" } } } }),
    );
    expect(surface(["declared"]).stdout).toContain("/declared");
  });

  it("refuses to run repo code for --generate", () => {
    const r = surface(["--generate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pnpm run generate");
  });
});

describe("surface contract intent", () => {
  function branchWithNewRoute(): void {
    init();
    git("add", ".");
    git("commit", "-qm", "surface");
    git("checkout", "-q", "-b", "feature");
    write(
      "apps/api/src/routes/sample.ts",
      ROUTES("  app.delete('/sample/items/:id', async () => ({}));\n"),
    );
    const gen = run(process.execPath, ["scripts/generate/derive-feature-surfaces.mjs", "--write"]);
    expect(gen.status, gen.stderr).toBe(0);
  }

  it("lists the contract changes against the base", () => {
    branchWithNewRoute();
    const r = surface(["diff", "main"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("- ADD surface DELETE /sample/items/:id (<why>)");
    const json = JSON.parse(surface(["diff", "main", "--json"]).stdout) as unknown[];
    expect(json).toEqual([
      { contract: "surface", action: "ADD", item: "DELETE /sample/items/:id" },
    ]);
  });

  it("fails an undeclared change and passes a declared one", () => {
    branchWithNewRoute();
    write("body-missing.md", "## Summary\nA new route.\n");
    let r = surface(["check", "--base", "main", "--body", "body-missing.md"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Undeclared contract change: ADD surface DELETE /sample/items/:id");
    write(
      "body.md",
      "## Summary\nA new route.\n\n## Contract Intent\n- ADD surface DELETE /sample/items/:id (members remove an item)\n",
    );
    r = surface(["check", "--base", "main", "--body", "body.md"]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain(
      "intent: PASS 1 contract change(s) declared exactly across 1 contract file(s)",
    );
    expect(surface(["verify-intent", "body.md", "--base", "main"]).status).toBe(0);
    expect(surface(["verify-intent", "--base", "main", "body.md"]).status).toBe(0);
    expect(
      surface(["check", "--base", "main"], repo, {
        SHIP_QUEUE_BODYFILE: NodePath.join(repo, "body.md"),
      }).status,
    ).toBe(0);
  });

  it("is UNPROVEN with changes and no body, and empty-bodied in a queue job", () => {
    branchWithNewRoute();
    let r = surface(["check", "--base", "main"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("1 contract change(s) and no PR body");
    r = surface(["check", "--base", "main"], repo, { SHIP_QUEUE_JOB: "job-1" });
    expect(r.status).toBe(1);
  });

  it("refuses a missing body file and a base that does not exist", () => {
    init();
    expect(surface(["verify-intent", "nope.md"]).status).toBe(2);
    expect(surface(["verify-intent"]).status).toBe(2);
    const r = surface(["check", "--base", "no-such-ref", "--body", "AGENTS.md"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("no-such-ref is not a commit");
  });
});
