// @effect-diagnostics nodeBuiltinImport:off - CLI integration tests drive the real bin with node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const BIN = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const EXAMPLE = NodeURL.fileURLToPath(
  new URL("../examples/fleet-shape.example.json", import.meta.url),
);

let tmp: string;
let repo: string;

function git(...args: string[]): void {
  NodeChildProcess.execFileSync("git", args);
}

function fleet(
  args: string[],
  cwd = repo,
): { status: number | null; stdout: string; stderr: string } {
  const res = NodeChildProcess.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fleet-test-")));
  repo = NodePath.join(tmp, "repo");
  NodeFS.mkdirSync(NodePath.join(repo, "deploy"), { recursive: true });
  git("init", "-q", "-b", "main", repo);
  NodeFS.writeFileSync(
    NodePath.join(repo, "playbook.json"),
    JSON.stringify({ contracts: { fleet: { file: "deploy/fleet.json" } } }),
  );
  NodeFS.copyFileSync(EXAMPLE, NodePath.join(repo, "deploy", "fleet.json"));
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

describe("fleet CLI", () => {
  it("prints its help", () => {
    const r = fleet(["--help"], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Provides sub-20ms lookup across declared infrastructure");
  });

  it("refuses to run outside a git repository", () => {
    const outside = NodePath.join(tmp, "plain");
    NodeFS.mkdirSync(outside);
    const r = fleet([], outside);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be run inside a git repository");
  });

  it("shows the dashboard of the shape playbook.json declares", () => {
    const r = fleet([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Declaration: deploy/fleet.json");
    expect(r.stdout).toContain("1 Services");
    expect(r.stdout).toContain("1 Secrets (1 with a rotation record, 0 without)");
    expect(r.stdout).toContain("1 Open Architectural Decisions");
  });

  it("finds an app with its provider and a secret with its rotation", () => {
    const app = fleet(["api"]);
    expect(app.stdout).toContain("Primary backend API service");
    expect(app.stdout).toContain("App (compose)");
    const secret = fleet(["DATABASE_URL"]);
    expect(secret.stdout).toContain("Primary PostgreSQL access connection string");
    expect(secret.stdout).toMatch(/Vendor\s+: postgres/);
  });

  it("lists by kind: hosts, roles, routes, permissions; an env name is no secret", () => {
    const hosts = fleet(["--kind", "host"]).stdout;
    expect(hosts).toContain("app-host");
    expect(hosts).toContain("192.0.2.10");
    expect(fleet(["--kind=job"]).stdout).toContain("outbox");
    expect(fleet(["-k", "route"]).stdout).toContain("api.example.test");
    expect(fleet(["--kind", "permission"]).stdout).toContain("ops-console");
    expect(fleet(["--kind", "name"]).stdout).toContain("LOG_LEVEL");
    expect(fleet(["--kind", "secret"]).stdout).not.toContain("LOG_LEVEL");
  });

  it("prints JSON for agents", () => {
    const all = JSON.parse(fleet(["--json"]).stdout) as Array<{ name: string; sourceFile: string }>;
    expect(all.length).toBe(13);
    expect(all.every((e) => e.sourceFile === "deploy/fleet.json")).toBe(true);
    const hosts = JSON.parse(fleet(["--kind", "host", "--json"]).stdout) as Array<{ name: string }>;
    expect(hosts.map((h) => h.name)).toEqual(["app-host"]);
  });

  it("prints the original CLI's dashboard examples and its ASCII-only JSON", () => {
    expect(fleet([]).stdout).toContain(
      "  fleet --kind host          List all cloud servers and private IPs\n",
    );
    const file = NodePath.join(repo, "deploy", "fleet.json");
    const shape = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    shape.roles.outbox.why = "drains the outbox \u2014 café\u007f";
    NodeFS.writeFileSync(file, JSON.stringify(shape));
    const r = fleet(["outbox", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"why": "drains the outbox \\u2014 caf\\u00e9\\u007f"');
    expect(r.stdout).toMatch(/^\[\n  \{\n    "name": "outbox",/);
    expect(JSON.parse(r.stdout)[0].why).toBe("drains the outbox \u2014 café\u007f");
  });

  it("reports an undeclared name as a finding", () => {
    const r = fleet(["NO_SUCH_THING"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Undeclared is a finding: add it to deploy/fleet.json.");
  });

  it("refuses an old form and a file that is not JSON", () => {
    const file = NodePath.join(repo, "deploy", "fleet.json");
    NodeFS.writeFileSync(
      file,
      JSON.stringify({ why: ["old"], applications: { api: { why: "x" } } }),
    );
    let r = fleet([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not in the one fleet schema");
    NodeFS.writeFileSync(file, "{ not json");
    r = fleet([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not parse");
  });

  it("finds the shape in a usual place when playbook.json declares none", () => {
    NodeFS.rmSync(NodePath.join(repo, "playbook.json"));
    NodeFS.renameSync(
      NodePath.join(repo, "deploy", "fleet.json"),
      NodePath.join(repo, "deploy", "fleet-shape.json"),
    );
    expect(fleet([]).stdout).toContain("Declaration: deploy/fleet-shape.json");
    NodeFS.rmSync(NodePath.join(repo, "deploy", "fleet-shape.json"));
    const r = fleet([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no fleet declaration found");
  });

  it("passes fleet check on a sound shape and fails it on drift", () => {
    let r = fleet(["check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^fleet check: PASS deploy\/fleet\.json: 13 entities, 0 schema error\(s\), 0 finding\(s\)/,
    );
    const file = NodePath.join(repo, "deploy", "fleet.json");
    const shape = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    shape.env.NEW_SECRET = { why: "a new key", apps: ["api"], secret: true };
    shape.stores.pgdata.size = "large";
    NodeFS.writeFileSync(file, JSON.stringify(shape));
    r = fleet(["check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fleet/schema  stores.pgdata: unrecognized key(s) [size]");
    expect(r.stdout).toContain(
      "fleet/rotation NEW_SECRET: NEW_SECRET is a secret with no rotation story",
    );
    const json = JSON.parse(fleet(["check", "--json"]).stdout) as {
      ok: boolean;
      findings: unknown[];
    };
    expect(json.ok).toBe(false);
    expect(json.findings).toHaveLength(1);
  });

  it("writes a first shape that passes its own check, and keeps an existing one", () => {
    const fresh = NodePath.join(tmp, "fresh");
    git("init", "-q", "-b", "main", fresh);
    let r = fleet(["init"], fresh);
    expect(r.status).toBe(0);
    expect(fleet(["check"], fresh).status).toBe(0);
    r = fleet(["init"], fresh);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(fleet(["init", "--force"], fresh).status).toBe(0);
    const elsewhere = NodePath.join(tmp, "not-a-repo");
    expect(fleet(["init", elsewhere], tmp).status).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(elsewhere, "fleet-shape.json"))).toBe(true);
  });
});
