// @effect-diagnostics nodeBuiltinImport:off - tests read the example shape with node:fs.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { checkFleetShape } from "./fleetCheck.ts";
import { normalizeKind, OldFleetForm, parseEntities, queryEntities } from "./fleetEntities.ts";
import { fleetFindings } from "./fleetFindings.ts";
import { renderEntity } from "./fleetRender.ts";
import {
  Arr,
  Enum,
  Int,
  Obj,
  optional,
  Rec,
  schemaErrors,
  Str,
  Union,
} from "./fleetSchemaNodes.ts";
import { FLEET_SHAPE_SCHEMA } from "./fleetShapeSchema.ts";

const EXAMPLE = NodeURL.fileURLToPath(
  new URL("../examples/fleet-shape.example.json", import.meta.url),
);

function example(): Record<string, any> {
  return JSON.parse(NodeFS.readFileSync(EXAMPLE, "utf8"));
}

describe("fleet schema language", () => {
  it("refuses unknown keys, missing fields and wrong types with a path", () => {
    const schema = Obj({
      name: Str({ min: 2 }),
      count: optional(Int(1)),
      tags: optional(Arr(Str())),
    });
    expect(schemaErrors(schema, { name: "a", count: 0, extra: 1, tags: ["x", 3] })).toEqual([
      "(root): unrecognized key(s) [extra]",
      "name: too short (at least 2 characters)",
      "count: must be at least 1",
      "tags.1: expected string, got int",
    ]);
    expect(schemaErrors(schema, {})).toEqual(["name: required"]);
    expect(schemaErrors(schema, [])).toEqual(["(root): expected an object"]);
  });

  it("checks record keys, enums, booleans that are not integers, and unions", () => {
    const schema = Rec(Obj({ level: Enum("a", "b"), n: optional(Int()) }), "^[a-z]+$");
    expect(schemaErrors(schema, { Bad: { level: "c", n: true } })).toEqual([
      "Bad: key does not match ^[a-z]+$",
      "Bad.level: 'c' is not one of: a, b",
      "Bad.n: expected an integer",
    ]);
    expect(schemaErrors(Union(Str(), Int()), [1])).toEqual([
      "(root): matches none of the allowed shapes: (root): expected string, got list | (root): expected an integer",
    ]);
  });
});

describe("fleet shape", () => {
  it("passes the example shape whole", () => {
    const result = checkFleetShape(example(), "examples/fleet-shape.example.json");
    expect(result.schemaErrors).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entityCount).toBe(13);
  });

  it("refuses an unknown section, an unknown field and an unknown provider kind", () => {
    const shape = example();
    shape.applications = {};
    shape.apps.api.colour = "blue";
    shape.providers.mystery = { kind: "mainframe", why: "x" };
    const errors = schemaErrors(FLEET_SHAPE_SCHEMA, shape);
    expect(errors).toContain("(root): unrecognized key(s) [applications]");
    expect(errors).toContain("apps.api: unrecognized key(s) [colour]");
    expect(
      errors.some((e) =>
        e.startsWith("providers.mystery: no adapter for provider kind 'mainframe'"),
      ),
    ).toBe(true);
  });

  it("judges each provider kind by its own shape", () => {
    const shape = example();
    shape.providers.cloud.servers["app-host"].files = { "relative/path": "x" };
    shape.providers.cloud.network = { subnet: "not-a-subnet" };
    const errors = schemaErrors(FLEET_SHAPE_SCHEMA, shape);
    expect(errors).toContain(
      "providers.cloud.servers.app-host.files.relative/path: remote path must be absolute (start with /)",
    );
    expect(errors).toContain(
      "providers.cloud.network.subnet: does not match ^\\d+\\.\\d+\\.\\d+\\.\\d+/\\d+$",
    );
  });

  it("finds broken references and missing rotation stories", () => {
    const shape = example();
    shape.apps.api.provider = "nowhere";
    shape.apps.api.roles.push("ghost");
    shape.roles.orphan = { why: "runs nowhere", reads: ["NO_SUCH_NAME"] };
    shape.env.API_TOKEN = { why: "a token", apps: ["stranger"], secret: true };
    shape.permissions.loose = { why: "who knows", grants: ["x"] };
    shape.providers.unused = { kind: "planned", why: "not yet" };
    const problems = fleetFindings(shape).map((f) => `${f.rule} ${f.item}: ${f.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        "fleet/cross api: app api names provider nowhere, which is not declared",
        "fleet/cross api: app api carries role ghost, which is not declared",
        "fleet/cross orphan: role orphan is declared but no app or server carries it",
        "fleet/cross orphan: role orphan reads NO_SUCH_NAME, which env does not declare",
        "fleet/cross API_TOKEN: env API_TOKEN names reader stranger, which is no declared app, role, backup, tool or code root",
        "fleet/rotation API_TOKEN: API_TOKEN is a secret with no rotation story: rotation.{vendor, reason, retirement, vault}",
        "fleet/cross loose: permission loose names neither holders nor the provider that enforces it",
        "fleet/cross unused: provider unused is declared but no app, store, permission, vault or provider names it",
      ]),
    );
  });

  it("finds a role reading a name none of its apps holds, and a copy with no retire command", () => {
    const shape = example();
    shape.env.OTHER = { why: "another app's name", apps: ["compose"] };
    shape.roles.outbox.reads.push("OTHER");
    shape.env.DATABASE_URL.rotation.alsoLivesAt = ["a laptop"];
    const problems = fleetFindings(shape).map((f) => f.problem);
    expect(problems).toContain("role outbox reads OTHER, which none of its apps (api) holds");
    expect(problems).toContain(
      "DATABASE_URL lives outside the stores (a laptop) but names no retire command that reaches it",
    );
  });
});

describe("fleet entities", () => {
  it("flattens every section with its kind", () => {
    const entities = parseEntities(example(), "fleet.json");
    const kinds = Object.fromEntries(entities.map((e) => [e.name, e.kind]));
    expect(kinds).toMatchObject({
      api: "service",
      box: "provider",
      "app-host": "host",
      "api.example.test": "route",
      outbox: "job",
      DATABASE_URL: "secret",
      LOG_LEVEL: "name",
      pgdata: "volume",
      "ops-console": "permission",
      dump: "backup",
      hosting: "decision",
    });
    const api = entities.find((e) => e.name === "api");
    expect(api?.type).toBe("App (compose)");
    const secret = entities.find((e) => e.name === "DATABASE_URL");
    expect(secret?.readers).toEqual(["api"]);
    expect(secret?.vendor).toBe("postgres");
    expect(entities.find((e) => e.name === "app-host")?.provider).toBe("cloud");
    // A block's own `kind` never replaces the entity kind (devtools' fleet lost providers so).
    expect(entities.find((e) => e.name === "box")?.declaredKind).toBe("compose");
    expect(entities.find((e) => e.name === "dump")?.declaredKind).toBe("logical-dump");
    expect(queryEntities(entities, "", "provider").map((e) => e.name)).toEqual([
      "box",
      "cloud",
      "edge",
    ]);
  });

  it("refuses an old form", () => {
    expect(() => parseEntities({ why: ["old"], applications: {} }, "old.json")).toThrow(
      OldFleetForm,
    );
  });

  it("matches an exact name first, else any field that contains the query", () => {
    const entities = parseEntities(example(), "fleet.json");
    expect(queryEntities(entities, "API", null).map((e) => e.name)).toEqual(["api"]);
    expect(queryEntities(entities, "postgres", null).map((e) => e.name)).toEqual(["DATABASE_URL"]);
    expect(queryEntities(entities, "", "host").map((e) => e.name)).toEqual(["app-host"]);
    expect(normalizeKind("Servers")).toBe("host");
    expect(normalizeKind("roles")).toBe("job");
    expect(normalizeKind("nonsense")).toBe("nonsense");
  });

  it("renders a card as devtools' fleet does", () => {
    const [secret] = queryEntities(parseEntities(example(), "fleet.json"), "DATABASE_URL", null);
    const card = renderEntity(secret!).split("\n");
    expect(card[1]).toBe("[SECRET] DATABASE_URL (Secret)");
    expect(card).toContain("  Secret          : True");
    expect(card).toContain("  Vendor          : postgres");
    expect(card).toContain("  Readers         : api");
  });
});
