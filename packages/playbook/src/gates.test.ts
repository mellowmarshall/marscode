// @effect-diagnostics nodeBuiltinImport:off - Real fixture git repository tests for every deterministic playbook gate.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { starterShape } from "@t3tools/fleet";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCheck } from "./checks.ts";
import { repoName } from "./git.ts";
import { canonicalJson } from "./strictJson.ts";
import {
  cleanupTempDirs,
  declarationWithSize,
  FIXED_TODAY,
  makeFixtureRepo,
  NO_BROKER_ENV,
} from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const sha1 = (s: string) => NodeCrypto.createHash("sha1").update(s).digest("hex");

function makeBaseRepo(extraContracts: object = {}) {
  const repo = makeFixtureRepo();
  repo.writeJson("playbook.json", declarationWithSize({ "src/a.ts": 5 }, extraContracts));
  repo.writeJson("fleet.json", starterShape("sample-repo"));
  repo.write("src/a.ts", "export const a = 1;\n");
  return repo;
}

const check = (root: string, base: string, over: Partial<Parameters<typeof runCheck>[0]> = {}) =>
  runCheck({
    root,
    repo: repoName(root),
    bypasses: {},
    today: FIXED_TODAY,
    base: { sha: base, name: "trunk", problem: null },
    env: NO_BROKER_ENV,
    ...over,
  });

const byName = (report: Awaited<ReturnType<typeof runCheck>>, name: string) =>
  report.results.find((r) => r.check === name);

describe("fleet gate", () => {
  it("composes with @t3tools/fleet, validates reads, and enforces provider-kind overrides", async () => {
    const repo = makeBaseRepo({
      fleet: { file: "fleet.json", reads: 'echo \'{"API_KEY": ["src/a.ts"]}\'' },
    });
    repo.writeJson("fleet.json", {
      ...starterShape("sample-repo"),
      apps: {
        api: {
          why: "Main HTTP API server",
          provider: "host_cloud",
          root: "src",
        },
      },
      env: {
        API_KEY: {
          why: "External API authentication key",
          apps: ["api"],
          secret: true,
          rotation: {
            vendor: "acme",
            vault: "prod-vault",
            reason: "Rotates every 90 days per partner policy",
            retirement: "Revoke old token in partner console after deploy",
          },
        },
      },
      providers: {
        host_cloud: {
          kind: "hetzner",
          why: "Primary API compute cluster",
          servers: {
            "web-1": { why: "Runs the API service", privateIp: "10.0.0.10" },
          },
        },
      },
    });
    const base = repo.commit("base");
    repo.branch("feat/fleet");

    const ok = await check(repo.root, base, { contracts: ["fleet"] });
    expect(byName(ok, "fleet")?.status).toBe("PASS");

    // Undeclared env read fails
    repo.writeJson(
      "playbook.json",
      declarationWithSize(
        { "src/a.ts": 5 },
        {
          fleet: {
            file: "fleet.json",
            reads: 'echo \'{"API_KEY":["src/a.ts"],"UNDECLARED":["src/a.ts"]}\'',
          },
        },
      ),
    );
    const undeclared = await check(repo.root, base, { contracts: ["fleet"] });
    expect(byName(undeclared, "fleet")?.status).toBe("FAIL");
    expect(byName(undeclared, "fleet")?.errors.join("\n")).toContain("UNDECLARED");

    // Provider kind switch requires owner override
    repo.writeJson(
      "playbook.json",
      declarationWithSize(
        { "src/a.ts": 5 },
        { fleet: { file: "fleet.json", reads: 'echo \'{"API_KEY":["src/a.ts"]}\'' } },
      ),
    );
    repo.writeJson("fleet.json", {
      ...starterShape("sample-repo"),
      apps: {
        api: { why: "Main HTTP API server", provider: "host_cloud", root: "src" },
      },
      env: {
        API_KEY: {
          why: "External API authentication key",
          apps: ["api"],
          secret: true,
          rotation: {
            vendor: "acme",
            vault: "prod-vault",
            reason: "Rotates every 90 days per partner policy",
            retirement: "Revoke old token in partner console after deploy",
          },
        },
      },
      providers: {
        host_cloud: {
          kind: "declared",
          platform: "custom-cloud",
          why: "Downgraded host cloud to declared-only shape",
        },
      },
    });
    const refused = await check(repo.root, base, { contracts: ["fleet"] });
    expect(byName(refused, "fleet providers")?.status).toBe("FAIL");
    expect(byName(refused, "fleet providers")?.errors.join("\n")).toContain("switched from");

    const asked: string[] = [];
    const overridden = await check(repo.root, base, {
      contracts: ["fleet"],
      override: async (reason) => {
        asked.push(reason);
        return true;
      },
    });
    expect(asked.length).toBe(1);
    expect(byName(overridden, "fleet providers")?.status).toBe("PASS");
  });
});

describe("dictionary gate", () => {
  it("validates tables, protection, concepts, boilerplate, and new SQL migrations", async () => {
    const validDict = {
      maxBoilerplateColumns: 0,
      roles: ["owner"],
      concepts: {
        "member.identity": {
          canonicalType: "uuid",
          purpose: "Canonical member identifier across tenant tables",
          aliases: ["member identity"],
        },
      },
      tables: {
        accounts: {
          purpose: "Billing accounts registered for workspace tenants",
          volume: "small",
          primaryKey: ["id"],
          protection: {
            tier: "member_state",
            owner: "owner_id",
            why: "Customer account metadata and plan tier",
            agentRead: true,
          },
          columns: {
            id: {
              type: "uuid",
              nullable: false,
              concept: "member.identity",
              purpose: "Account record identity in billing ledger",
            },
            owner_id: {
              type: "uuid",
              nullable: false,
              concept: "member.identity",
              role: "owner",
              purpose: "Workspace member who owns the billing account",
            },
          },
        },
      },
    };
    const repo = makeBaseRepo({
      dictionary: { file: "config/dictionary.json" },
      migrations: { dir: "db/migrations", migrator: "raw" },
    });
    repo.writeJson("config/dictionary.json", validDict);
    repo.write(
      "db/migrations/001_init.sql",
      "CREATE TABLE accounts (id uuid primary key, owner_id uuid not null);\n",
    );
    const base = repo.commit("base");
    repo.branch("feat/dict");

    const pass = await check(repo.root, base, { contracts: ["dictionary"] });
    expect(byName(pass, "dictionary")?.status).toBe("PASS");

    // Boilerplate purpose fails
    repo.writeJson("config/dictionary.json", {
      ...validDict,
      tables: {
        ...validDict.tables,
        accounts: {
          ...validDict.tables.accounts,
          columns: {
            ...validDict.tables.accounts.columns,
            id: {
              type: "uuid",
              nullable: false,
              concept: "member.identity",
              purpose: "Primary unique identifier for accounts record.",
            },
          },
        },
      },
    });
    const boilerplate = await check(repo.root, base, { contracts: ["dictionary"] });
    expect(byName(boilerplate, "dictionary")?.status).toBe("FAIL");
    expect(byName(boilerplate, "dictionary")?.errors.join("\n")).toContain("boilerplate");

    // Restore valid dict; add SQL migration adding column missing from dictionary
    repo.writeJson("config/dictionary.json", validDict);
    repo.write("db/migrations/002_alter.sql", "ALTER TABLE accounts ADD COLUMN note text;\n");
    repo.commit("add alter migration");
    const unreviewed = await check(repo.root, base, { contracts: ["dictionary"] });
    expect(byName(unreviewed, "dictionary")?.status).toBe("FAIL");
    expect(byName(unreviewed, "dictionary")?.errors.join("\n")).toContain("accounts.note");

    // Add -- schema-ok marker, column + approved concept to dictionary -> PASS
    repo.write(
      "db/migrations/002_alter.sql",
      "-- schema-ok #40: add optional billing note\nALTER TABLE accounts ADD COLUMN note text;\n",
    );
    repo.writeJson("config/dictionary.json", {
      ...validDict,
      concepts: {
        ...validDict.concepts,
        "billing.note": {
          canonicalType: "text",
          purpose: "Internal support note stored on billing accounts",
          aliases: ["billing note"],
          approved: "#40",
        },
      },
      tables: {
        ...validDict.tables,
        accounts: {
          ...validDict.tables.accounts,
          columns: {
            ...validDict.tables.accounts.columns,
            note: {
              type: "text",
              nullable: true,
              concept: "billing.note",
              purpose: "Internal support note for billing ops",
            },
          },
        },
      },
    });
    const fixed = await check(repo.root, base, { contracts: ["dictionary"] });
    expect(byName(fixed, "dictionary")?.status).toBe("PASS");
  });
});

describe("migrations gate", () => {
  it("enforces immutability, naming, migrator list, destructive markers, and regex CHECK ban", async () => {
    const repo = makeBaseRepo({
      migrations: {
        dir: "db/migrations",
        migrator: "drizzle",
        list: "db/migrations/meta/_journal.json",
        lint: "test -d db/migrations",
      },
    });
    repo.write("db/migrations/0001_init.sql", "CREATE TABLE items (id integer primary key);\n");
    repo.writeJson("db/migrations/meta/_journal.json", {
      entries: [{ idx: 0, tag: "0001_init" }],
    });
    const base = repo.commit("base");
    repo.branch("feat/mig");

    // Valid new migration
    repo.write("db/migrations/0002_add_name.sql", "ALTER TABLE items ADD COLUMN name text;\n");
    repo.writeJson("db/migrations/meta/_journal.json", {
      entries: [
        { idx: 0, tag: "0001_init" },
        { idx: 1, tag: "0002_add_name" },
      ],
    });
    const ok = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(ok, "migrations")?.status).toBe("PASS");

    // Destructive statement without marker fails
    repo.write("db/migrations/0002_add_name.sql", "DROP TABLE items;\n");
    const destructive = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(destructive, "migrations")?.status).toBe("FAIL");
    expect(byName(destructive, "migrations")?.errors.join("\n")).toContain("destructive-ok");

    // With -- destructive-ok #40 passes
    repo.write(
      "db/migrations/0002_add_name.sql",
      "-- destructive-ok #40: retiring obsolete items table\nDROP TABLE items;\n",
    );
    const marked = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(marked, "migrations")?.status).toBe("PASS");

    // Regex CHECK fails
    repo.write(
      "db/migrations/0002_add_name.sql",
      "ALTER TABLE items ADD COLUMN code text CHECK (code ~ '^[A-Z]+$');\n",
    );
    const regexFail = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(regexFail, "migrations")?.status).toBe("FAIL");
    expect(byName(regexFail, "migrations")?.errors.join("\n")).toContain("regex");

    // Editing applied history fails without override, passes with override
    repo.write("db/migrations/0002_add_name.sql", "ALTER TABLE items ADD COLUMN name text;\n");
    repo.write("db/migrations/0001_init.sql", "CREATE TABLE items (id bigint primary key);\n");
    const mutated = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(mutated, "migrations history")?.status).toBe("FAIL");
    expect(byName(mutated, "migrations history")?.errors.join("\n")).toContain(
      "merged migration edited",
    );

    const allowed = await check(repo.root, base, {
      contracts: ["migrations"],
      override: async () => true,
    });
    expect(byName(allowed, "migrations history")?.status).toBe("PASS");
  });
});

describe("design gate", () => {
  it("checks appearance slots both ways, runs design.command, and refuses symlinked tokens", async () => {
    const repo = makeBaseRepo({
      design: {
        tokens: "design/tokens.json",
        ui: "src/ui",
        client: ["src/ui/"],
        slots: "design/slots.json",
        slot_calls: ["useSlot"],
        command:
          "node -e 'process.stdin.resume(); process.stdin.on(\"end\", () => console.log(JSON.stringify({ findings: [], files: 1 })))'",
      },
    });
    repo.writeJson("design/tokens.json", { color: { accent: "#2255cc" } });
    repo.writeJson("design/slots.json", {
      slots: { accent: { drawnBy: ["src/ui/btn.tsx"] } },
    });
    repo.write("src/ui/btn.tsx", 'export const Btn = () => useSlot("accent");\n');
    const base = repo.commit("base");
    repo.branch("feat/design");

    const pass = await check(repo.root, base, { contracts: ["design"] });
    expect(byName(pass, "design")?.status).toBe("PASS");
    expect(byName(pass, "design slots")?.status).toBe("PASS");

    // Missing drawnBy reference in client file fails slots check
    repo.write("src/ui/btn.tsx", "export const Btn = () => null;\n");
    const badSlot = await check(repo.root, base, { contracts: ["design"] });
    expect(byName(badSlot, "design slots")?.status).toBe("FAIL");
    expect(byName(badSlot, "design slots")?.errors.join("\n")).toContain("accent");

    // Symlinked tokens file refused
    repo.write("src/ui/btn.tsx", 'export const Btn = () => useSlot("accent");\n');
    NodeFS.rmSync(NodePath.join(repo.root, "design/tokens.json"));
    NodeFS.symlinkSync("/etc/hosts", NodePath.join(repo.root, "design/tokens.json"));
    const symlinked = await check(repo.root, base, { contracts: ["design"] });
    expect(byName(symlinked, "design")?.status).toBe("FAIL");
    expect(byName(symlinked, "design")?.summary).toContain("symlink");
  });
});

describe("actions gate", () => {
  it("composes with @t3tools/surface, validates evidence tests, and rejects vacuous oracles", async () => {
    const evidenceScript = [
      "console.log(JSON.stringify({",
      "  tests: [{",
      "    file: 'tests/create.e2e.ts', line: 10, title: 'creates room', kind: 'e2e',",
      "    actions: ['rooms.create'], selectors: ['create-room-btn']",
      "  }]",
      "}))",
    ].join(" ");
    const repo = makeBaseRepo({
      intent: { contracts: { surface: "config/feature-surfaces.json" } },
      actions: {
        file: "config/user-actions.json",
        evidence: {
          run: `node -e "${evidenceScript}"`,
          tests: "^tests/.*\\.e2e\\.ts$",
        },
      },
    });
    repo.writeJson("config/feature-surfaces.json", {
      routes: {
        "/v1/rooms": { methods: ["POST"], domain: "rooms", apiFile: "src/rooms.ts" },
      },
    });
    repo.writeJson("config/user-actions.schema.json", {
      type: "object",
      required: ["actions"],
      properties: { actions: { type: "object" } },
    });
    repo.writeJson("config/user-actions.json", {
      $schema: "user-actions.schema.json",
      actions: {
        "rooms.create": {
          surface: "web",
          testID: "create-room-btn",
          file: "src/rooms.ts",
          apiRoute: "POST /v1/rooms",
          oracle: "visible: room-title",
          level: "journey",
        },
      },
    });
    repo.write("src/rooms.ts", "export const createRoom = () => {};\n");
    const base = repo.commit("base");
    repo.branch("feat/actions");

    const pass = await check(repo.root, base, { contracts: ["actions"] });
    expect(byName(pass, "actions")?.status).toBe("PASS");

    // Unknown API route fails via @t3tools/surface check
    repo.writeJson("config/user-actions.json", {
      $schema: "user-actions.schema.json",
      actions: {
        "rooms.create": {
          surface: "web",
          testID: "create-room-btn",
          file: "src/rooms.ts",
          apiRoute: "POST /v1/missing",
          oracle: "visible: room-title",
          level: "journey",
        },
      },
    });
    const badRoute = await check(repo.root, base, { contracts: ["actions"] });
    expect(byName(badRoute, "actions")?.status).toBe("FAIL");
    expect(byName(badRoute, "actions")?.errors.join("\n")).toContain("POST /v1/missing");

    // Vacuous shell oracle fails
    repo.writeJson("config/user-actions.json", {
      $schema: "user-actions.schema.json",
      actions: {
        "rooms.create": {
          surface: "web",
          testID: "create-room-btn",
          file: "src/rooms.ts",
          apiRoute: "POST /v1/rooms",
          oracle: "visible: rooms-page-container",
          level: "journey",
        },
      },
    });
    const vacuous = await check(repo.root, base, { contracts: ["actions"] });
    expect(byName(vacuous, "actions")?.status).toBe("FAIL");
    expect(byName(vacuous, "actions")?.errors.join("\n")).toContain("vacuous-oracle");
  });
});

describe("optimization gate", () => {
  it("refuses opt-out when routes exist, verifies committed receipts, and ratchets budgets", async () => {
    const repo = makeBaseRepo({
      intent: { contracts: { surface: "config/feature-surfaces.json" } },
      optimization: { none: "no routes or jobs declared yet" },
    });
    repo.writeJson("config/feature-surfaces.json", {
      routes: {
        "/v1/rooms": { methods: ["GET"], domain: "rooms", apiFile: "src/rooms.ts" },
      },
    });
    repo.write("src/rooms.ts", "export const listRooms = () => [];\n");
    const base0 = repo.commit("base0");
    repo.branch("feat/opt");

    const refusedOptOut = await check(repo.root, base0, { contracts: ["optimization"] });
    expect(byName(refusedOptOut, "optimization")?.status).toBe("FAIL");
    expect(byName(refusedOptOut, "optimization")?.summary).toContain("opts out");

    // Now configure real budgets + valid receipt
    const allSections = [
      "step_timing",
      "round_trips",
      "query_shape",
      "read_amplification",
      "fetch_utilization",
      "plan_stability",
      "payload",
      "caching",
      "search",
      "write_coalescing",
      "connection_hold",
      "cancellation",
      "transaction_scope",
      "memory_churn",
      "complexity",
      "bundle_size",
      "external_timeouts",
      "tail_latency",
      "render_bounds",
    ];
    const measurements = Object.fromEntries(
      allSections.map((sec) => [
        sec,
        sec === "step_timing" || sec === "round_trips"
          ? { by: "src/rooms.ts" }
          : { notApplicable: "fixture test covers step timing and round trips" },
      ]),
    );
    const budgetEntry = {
      steps: [{ name: "query", maxRoundTrips: 2, maxMs: 40 }],
      maxRoundTrips: 2,
      maxMs: 50,
    };
    const budgets = {
      version: 2,
      measurements,
      subjects: { "GET /v1/rooms": budgetEntry },
    };
    const receiptLedger = {
      version: 1,
      receipts: {
        "GET /v1/rooms": {
          budget: sha1(canonicalJson(budgetEntry)),
          source: sha1("export const listRooms = () => [];\n"),
          roundTrips: 1,
          ms: 12,
          steps: [{ name: "query", roundTrips: 1, ms: 10 }],
        },
      },
    };
    repo.writeJson(
      "playbook.json",
      declarationWithSize(
        { "src/a.ts": 5 },
        {
          intent: { contracts: { surface: "config/feature-surfaces.json" } },
          optimization: { file: "config/opt-budgets.json", receipts: "config/opt-receipts.json" },
        },
      ),
    );
    repo.writeJson("config/opt-budgets.json", budgets);
    repo.writeJson("config/opt-receipts.json", receiptLedger);
    const base1 = repo.commit("adopt budgets");

    const pass = await check(repo.root, base1, { contracts: ["optimization"] });
    expect(byName(pass, "optimization")?.status).toBe("PASS");

    // Loosening maxRoundTrips without justify fails ratchet
    const looserEntry = { ...budgetEntry, maxRoundTrips: 4 };
    repo.writeJson("config/opt-budgets.json", {
      ...budgets,
      subjects: { "GET /v1/rooms": looserEntry },
    });
    repo.writeJson("config/opt-receipts.json", {
      version: 1,
      receipts: {
        "GET /v1/rooms": {
          ...receiptLedger.receipts["GET /v1/rooms"],
          budget: sha1(canonicalJson(looserEntry)),
        },
      },
    });
    const loosened = await check(repo.root, base1, { contracts: ["optimization"] });
    const ratchetRes = byName(loosened, "optimization ratchet") ?? byName(loosened, "optimization");
    expect(ratchetRes?.status).toBe("FAIL");
    expect(ratchetRes?.errors.join("\n")).toContain("maxRoundTrips");
  });
});

describe("generations and intent gates", () => {
  it("forbids GENERATED markers when command is null and validates umbrella scripts", async () => {
    const repo = makeBaseRepo();
    const base = repo.commit("base");
    repo.branch("feat/gen");

    repo.write("src/gen.ts", "// GENERATED from schema.json\nexport const x = 1;\n");
    const forbidden = await check(repo.root, base, { contracts: ["generations"] });
    expect(byName(forbidden, "generations")?.status).toBe("FAIL");
    expect(byName(forbidden, "generations")?.summary).toContain("command is null");
    expect(byName(forbidden, "generations")?.errors.join("\n")).toContain("GENERATED from");
  });

  it("marks intent UNPROVEN when the declared surface has zero routes", async () => {
    const repo = makeBaseRepo({
      intent: { contracts: { surface: "config/feature-surfaces.json" } },
    });
    repo.writeJson("config/feature-surfaces.json", { routes: {} });
    const base = repo.commit("base");
    repo.branch("feat/intent");

    const empty = await check(repo.root, base, {
      contracts: ["intent"],
      body: "## Contract Intent\nNone.\n",
    });
    expect(byName(empty, "intent")?.status).toBe("UNPROVEN");
  });
});

describe("auxiliary deterministic gates: ci, docs, py-deps", () => {
  it("checks ci for static sleeps and forced serial flags", async () => {
    const repo = makeBaseRepo();
    repo.write("src/sample.test.ts", "export const ok = true;\n");
    const base = repo.commit("base");
    repo.branch("feat/ci");

    const clean = await check(repo.root, base, { contracts: ["ci"] });
    expect(byName(clean, "ci")?.status).toBe("PASS");

    repo.write("src/bad.test.ts", "await new Promise((r) => setTimeout(r, 500));\n");
    repo.writeJson("package.json", {
      name: "fixture",
      scripts: { test: "vitest run --runInBand" },
    });
    const bad = await check(repo.root, base, { contracts: ["ci"] });
    expect(byName(bad, "ci")?.status).toBe("FAIL");
    expect(byName(bad, "ci")?.errors.join("\n")).toContain("static-sleep");
    expect(byName(bad, "ci")?.errors.join("\n")).toContain("--runInBand");
  });

  it("checks docs for broken relative links and symlink escapes", async () => {
    const repo = makeBaseRepo();
    repo.write("docs/guide.md", "See [code](../src/a.ts).\n");
    const base = repo.commit("base");
    repo.branch("feat/docs");

    const clean = await check(repo.root, base, { contracts: ["docs"] });
    expect(byName(clean, "docs")?.status).toBe("PASS");

    repo.write("docs/guide.md", "See [missing](./nope.md).\n");
    const broken = await check(repo.root, base, { contracts: ["docs"] });
    expect(byName(broken, "docs")?.status).toBe("FAIL");
    expect(byName(broken, "docs")?.errors.join("\n")).toContain("./nope.md");
  });

  it("checks py-deps for lockfiles, duplicate/unsafe pins, and tools deps coverage", async () => {
    const repo = makeBaseRepo({
      tools: {
        steps: [{ name: "py-audit", class: "deps", run: "true", languages: ["python"] }],
      },
    });
    repo.write("pyproject.toml", '[project]\nname = "demo"\nversion = "0.1.0"\n');
    repo.write("uv.lock", "version = 1\n");
    repo.write("requirements.txt", "httpx==0.28.1\n");
    const base = repo.commit("base");
    repo.branch("feat/py");

    const clean = await check(repo.root, base, { contracts: ["py-deps"] });
    expect(byName(clean, "py-deps")?.status).toBe("PASS");

    repo.write(
      "requirements.txt",
      "httpx==0.28.1\nhttpx==0.28.2\n-e /tmp/local-pkg\nrequests>=2.0\n",
    );
    const bad = await check(repo.root, base, { contracts: ["py-deps"] });
    expect(byName(bad, "py-deps")?.status).toBe("FAIL");
    const msg = byName(bad, "py-deps")?.errors.join("\n") ?? "";
    expect(msg).toContain("duplicate Python dependency");
    expect(msg).toContain("unsafe path");
  });
});

describe("hardening and edge-case regressions", () => {
  it("rejects absolute and parent-traversal paths in contracts.design settings", async () => {
    const repo = makeBaseRepo({
      design: {
        tokens: "design/tokens.json",
        ui: "src/ui",
        client: ["src/ui/"],
        command:
          "node -e 'process.stdin.resume(); process.stdin.on(\"end\", () => console.log(JSON.stringify({ findings: [], files: 0 })))'",
      },
    });
    repo.writeJson("design/tokens.json", {});
    const base = repo.commit("base");
    repo.branch("feat/design-path");

    for (const badTokens of ["/etc/passwd", "../../outside/tokens.json"]) {
      const { designGate } = await import("./gates/designGate.ts");
      const results = await designGate({
        root: repo.root,
        settings: {
          tokens: badTokens,
          ui: "src/ui",
          client: ["src/ui/"],
          command: "true",
        },
        declaration: {},
        entries: [],
        base,
      });
      expect(results[0]?.status).toBe("FAIL");
      expect(results[0]?.summary).toContain("plain repository-relative path");
    }
  });

  it("fails closed on symlinked migrations/manifests and refuses SQL comment override bypass", async () => {
    const repo = makeBaseRepo({
      dictionary: { file: "config/dictionary.json" },
      migrations: {
        dir: "db/migrations",
        migrator: "raw",
        protection: { override: "app.allow_member_writes", guards: "guard_" },
        lint: "true",
      },
    });
    repo.writeJson("config/dictionary.json", {
      roles: ["owner"],
      concepts: {
        "member.identity": {
          canonicalType: "uuid",
          purpose: "Canonical member identifier across tenant tables",
          aliases: ["member identity"],
        },
      },
      tables: {
        accounts: {
          purpose: "Billing accounts registered for workspace tenants",
          volume: "small",
          primaryKey: ["id"],
          protection: {
            tier: "member_state",
            owner: "owner_id",
            why: "Customer account metadata and plan tier",
            agentRead: true,
          },
          columns: {
            id: {
              type: "uuid",
              nullable: false,
              concept: "member.identity",
              purpose: "Account record identity in billing ledger",
            },
            owner_id: {
              type: "uuid",
              nullable: false,
              concept: "member.identity",
              role: "owner",
              purpose: "Workspace member who owns the billing account",
            },
          },
        },
      },
    });
    repo.write("db/migrations/001_init.sql", "CREATE TABLE accounts (id uuid primary key);\n");
    const base = repo.commit("base");
    repo.branch("feat/sql-hardening");

    // Comment mentioning override must NOT bypass protected-table write guard
    repo.write(
      "db/migrations/002_comment_bypass.sql",
      "-- app.allow_member_writes = 'on'\nDELETE FROM accounts WHERE id = '00000000-0000-0000-0000-000000000000';\n",
    );
    const commentBypass = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(commentBypass, "migrations")?.status).toBe("FAIL");
    expect(byName(commentBypass, "migrations")?.errors.join("\n")).toContain(
      "writes/truncates protected table 'accounts'",
    );

    // Real SQL setting passes
    repo.write(
      "db/migrations/002_comment_bypass.sql",
      "SET LOCAL app.allow_member_writes = 'on';\nDELETE FROM accounts WHERE id = '00000000-0000-0000-0000-000000000000';\n",
    );
    const realOverride = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(realOverride, "migrations")?.status).toBe("PASS");

    // Symlinked migration fails closed in both migrations and dictionary gates
    NodeFS.rmSync(NodePath.join(repo.root, "db/migrations/002_comment_bypass.sql"));
    NodeFS.symlinkSync(
      "/etc/hosts",
      NodePath.join(repo.root, "db/migrations/002_comment_bypass.sql"),
    );
    repo.commit("add symlink migration");
    const migSymlink = await check(repo.root, base, { contracts: ["migrations"] });
    expect(byName(migSymlink, "migrations")?.status).toBe("FAIL");
    expect(byName(migSymlink, "migrations")?.errors.join("\n")).toContain("cannot be read");

    const dictSymlink = await check(repo.root, base, { contracts: ["dictionary"] });
    expect(byName(dictSymlink, "dictionary")?.status).toBe("FAIL");
    expect(byName(dictSymlink, "dictionary")?.errors.join("\n")).toContain("cannot be read");

    // Symlinked requirements.txt fails closed in py-deps gate
    NodeFS.symlinkSync("/etc/hosts", NodePath.join(repo.root, "requirements.txt"));
    const pySymlink = await check(repo.root, base, { contracts: ["py-deps"] });
    expect(byName(pySymlink, "py-deps")?.status).toBe("FAIL");
    expect(byName(pySymlink, "py-deps")?.errors.join("\n")).toContain("cannot be read");
  });

  it("reports malformed actions schema JSON instead of silently skipping validation", async () => {
    const evidenceScript = [
      "console.log(JSON.stringify({",
      "  tests: [{",
      "    file: 'tests/create.e2e.ts', line: 10, title: 'creates room', kind: 'e2e',",
      "    actions: ['rooms.create'], selectors: ['create-room-btn']",
      "  }]",
      "}))",
    ].join(" ");
    const repo = makeBaseRepo({
      actions: {
        file: "config/user-actions.json",
        evidence: {
          run: `node -e "${evidenceScript}"`,
          tests: "^tests/.*\\.e2e\\.ts$",
        },
      },
    });
    repo.write("config/user-actions.schema.json", "{ broken json\n");
    repo.writeJson("config/user-actions.json", {
      $schema: "user-actions.schema.json",
      actions: {
        "rooms.create": {
          surface: "web",
          testID: "create-room-btn",
          file: "src/a.ts",
          oracle: "visible: room-title",
          level: "journey",
        },
      },
    });
    const base = repo.commit("base");
    repo.branch("feat/bad-actions-schema");

    const res = await check(repo.root, base, { contracts: ["actions"] });
    expect(byName(res, "actions")?.status).toBe("FAIL");
    expect(byName(res, "actions")?.errors.join("\n")).toContain("cannot be parsed as strict JSON");
  });

  it("ratchets optimization maxPayloadBytes and isolates fleet codeRoots path boundaries", async () => {
    const allSections = [
      "step_timing",
      "round_trips",
      "query_shape",
      "read_amplification",
      "fetch_utilization",
      "plan_stability",
      "payload",
      "caching",
      "search",
      "write_coalescing",
      "connection_hold",
      "cancellation",
      "transaction_scope",
      "memory_churn",
      "complexity",
      "bundle_size",
      "external_timeouts",
      "tail_latency",
      "render_bounds",
    ];
    const measurements = Object.fromEntries(
      allSections.map((sec) => [
        sec,
        sec === "step_timing" || sec === "round_trips" || sec === "payload"
          ? { by: "src/a.ts" }
          : { notApplicable: "fixture covers timing, round trips, and payload" },
      ]),
    );
    const repo = makeBaseRepo({
      intent: { contracts: { surface: "config/feature-surfaces.json" } },
      fleet: { file: "fleet.json", reads: 'echo \'{"SHARED_KEY":["packages/app-other/x.ts"]}\'' },
      optimization: { file: "config/opt-budgets.json", receipts: "config/opt-receipts.json" },
    });
    repo.write("packages/app-other/x.ts", "export const x = process.env.SHARED_KEY;\n");
    repo.writeJson("fleet.json", {
      ...starterShape("sample-repo"),
      codeRoots: { main: { roots: ["packages/app"], why: "Main app root" } },
      apps: { api: { why: "API service", provider: "host", root: "src" } },
      env: { SHARED_KEY: { why: "Shared config key", apps: ["api"] } },
      providers: {
        host: {
          kind: "declared",
          platform: "custom",
          why: "Declared fixture host",
        },
      },
    });
    repo.writeJson("config/feature-surfaces.json", {
      routes: { "/v1/a": { methods: ["GET"], domain: "a", apiFile: "src/a.ts" } },
    });
    const budgetEntry = {
      steps: [{ name: "query", maxRoundTrips: 1, maxMs: 20 }],
      maxRoundTrips: 1,
      maxMs: 25,
      maxPayloadBytes: 4096,
    };
    repo.writeJson("config/opt-budgets.json", {
      version: 2,
      measurements,
      subjects: { "GET /v1/a": budgetEntry },
    });
    repo.writeJson("config/opt-receipts.json", {
      version: 1,
      receipts: {
        "GET /v1/a": {
          budget: sha1(canonicalJson(budgetEntry)),
          source: sha1("export const a = 1;\n"),
          roundTrips: 1,
          ms: 10,
          steps: [{ name: "query", roundTrips: 1, ms: 8 }],
        },
      },
    });
    const base = repo.commit("base");
    repo.branch("feat/payload-and-coderoot");

    // Fleet codeRoot "packages/app" must NOT allow reads under "packages/app-other/x.ts"
    const fleetRes = await check(repo.root, base, { contracts: ["fleet"] });
    expect(byName(fleetRes, "fleet")?.status).toBe("FAIL");
    expect(byName(fleetRes, "fleet")?.errors.join("\n")).toContain("packages/app-other/x.ts");

    // Loosening maxPayloadBytes without justify fails ratchet
    const looser = { ...budgetEntry, maxPayloadBytes: 8192 };
    repo.writeJson("config/opt-budgets.json", {
      version: 2,
      measurements,
      subjects: { "GET /v1/a": looser },
    });
    repo.writeJson("config/opt-receipts.json", {
      version: 1,
      receipts: {
        "GET /v1/a": {
          budget: sha1(canonicalJson(looser)),
          source: sha1("export const a = 1;\n"),
          roundTrips: 1,
          ms: 10,
          steps: [{ name: "query", roundTrips: 1, ms: 8 }],
        },
      },
    });
    const optRes = await check(repo.root, base, { contracts: ["optimization"] });
    const ratchet = byName(optRes, "optimization ratchet") ?? byName(optRes, "optimization");
    expect(ratchet?.status).toBe("FAIL");
    expect(ratchet?.errors.join("\n")).toContain("maxPayloadBytes");
  });
});
