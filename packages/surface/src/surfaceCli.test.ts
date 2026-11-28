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

/**
 * The environment every command runs in: none of the caller's ship-queue job
 * (SHIP_QUEUE_ONTO, its body file) or git settings (GIT_*, global and system
 * config), and a home of the test's own, so a CI job or a user's setup never
 * changes what the temp repo says.
 */
function isolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(SHIP_QUEUE_|GIT_)/.test(k)),
  );
  const home = NodePath.join(tmp, "home");
  return {
    ...base,
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...env,
  };
}

function run(cmd: string, args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): Run {
  const res = NodeChildProcess.spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(env),
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
  NodeFS.mkdirSync(NodePath.join(tmp, "home"));
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

  it("ranks the dashboard's top domains as the original did: by routes, ties in file order", () => {
    write(
      CONTRACT,
      JSON.stringify({
        meta: {},
        routes: { "/b": { method: "GET", path: "/b", domain: "zeta" } },
        domains: {
          zeta: { routes: ["/b"] },
          beta: { routes: ["/a"] },
          alpha: { routes: [] },
          gamma: { routes: ["/c", "/d"] },
        },
      }),
    );
    const out = surface([]).stdout;
    const order = ["gamma", "zeta", "beta", "alpha"].map((d) => out.indexOf(`  - ${d} `));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("  surface verify-intent  Judge a PR body's ## Contract Intent\n");
    expect(surface(["--list"]).stdout.indexOf("  alpha")).toBeLessThan(
      surface(["--list"]).stdout.indexOf("  beta"),
    );
  });

  it("escapes non-ASCII in JSON as the original's json.dumps does", () => {
    write(
      CONTRACT,
      JSON.stringify({
        routes: { "/caf\u00e9": { method: "GET", path: "/caf\u00e9", domain: "d\u2014x\u007f" } },
        domains: {},
      }),
    );
    const r = surface(["api", "", "--json"]);
    expect(r.stdout).toContain('"path": "/caf\\u00e9"');
    expect(r.stdout).toContain('"domain": "d\\u2014x\\u007f"');
    expect(JSON.parse(r.stdout)[0].path).toBe("/caf\u00e9");
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

  function declareSurface(): void {
    write(
      "playbook.json",
      JSON.stringify({ contracts: { intent: { contracts: { surface: CONTRACT } } } }),
    );
  }

  function headSha(ref: string): string {
    return run("git", ["rev-parse", ref]).stdout.trim();
  }

  it("lists the contract changes against the base as playbook intent-diff prints them", () => {
    branchWithNewRoute();
    let r = surface(["diff", "main"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(
      "playbook intent-diff: playbook.json declares no such intent contract (contracts.intent.contracts)\n",
    );
    declareSurface();
    const base = headSha("main");
    r = surface(["diff", "main"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      `ADD surface DELETE /sample/items/:id\nintent-diff: 1 contract change(s) against ${base.slice(0, 12)}\n`,
    );
    const json = JSON.parse(surface(["diff", "--json", "main"]).stdout) as unknown;
    expect(json).toEqual({
      base,
      changes: [
        { action: "ADD", contract: "surface", item: "DELETE /sample/items/:id", fields: [] },
      ],
    });
  });

  it("names the fields a MODIFY changes", () => {
    branchWithNewRoute();
    declareSurface();
    const file = NodePath.join(repo, CONTRACT);
    const data = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    data.routes["/sample/items"].apiFile = "apps/api/src/routes/moved.ts";
    NodeFS.writeFileSync(file, JSON.stringify(data));
    const out = surface(["diff", "main"]).stdout;
    expect(out).toContain(
      'MODIFY surface GET /sample/items (apiFile: "apps/api/src/routes/sample.ts" -> "apps/api/src/routes/moved.ts")\n',
    );
    expect(out).toContain("intent-diff: 3 contract change(s) against ");
  });

  it("compares against the gate's base, and exits 2 when there is none", () => {
    branchWithNewRoute();
    declareSurface();
    let r = surface(["diff"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(
      "playbook intent-diff: no base to compare against (the gate base); git fetch origin\n",
    );
    r = surface(["diff", "no-such-ref"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no base to compare against (no-such-ref)");
    expect(surface(["diff"], repo, { SHIP_QUEUE_ONTO: "main" }).stdout).toContain(
      "intent-diff: 1 contract change(s)",
    );
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    r = surface(["diff"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`against ${headSha("main").slice(0, 12)}`);
    // `surface check` judges against the same base when no --base is given.
    write(
      "body.md",
      "## Contract Intent\n- ADD surface DELETE /sample/items/:id (members remove an item)\n",
    );
    expect(surface(["check", "--body", "body.md"]).status).toBe(0);
  });

  it("has no base when git cannot read origin/HEAD's .tree-guard.conf, never origin/HEAD instead", () => {
    branchWithNewRoute();
    declareSurface();
    git("checkout", "-q", "main");
    write(".tree-guard.conf", "base_ref=main\n");
    git("add", ".tree-guard.conf");
    git("commit", "-qm", "conf");
    git("checkout", "-q", "feature");
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(surface(["diff"]).status).toBe(0);
    // The conf's blob goes missing from the object store: git can list it but not read it.
    const blob = run("git", ["rev-parse", "main:.tree-guard.conf"]).stdout.trim();
    NodeFS.rmSync(NodePath.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const r = surface(["diff"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no base to compare against");
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
