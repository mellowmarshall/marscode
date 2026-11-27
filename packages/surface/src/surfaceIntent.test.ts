import { describe, expect, it } from "vite-plus/test";

import {
  canonical,
  contractDiff,
  modifiedFields,
  routeMatches,
  surfaceItems,
} from "./surfaceIntentItems.ts";
import { judgeIntent, parseIntent } from "./surfaceIntentJudge.ts";
import { authText, clientServices, matchRoutes, type FeatureSurface } from "./surfaceQuery.ts";

const route = (method: string, domain: string, auth?: string) => ({
  path: "/x",
  method,
  methods: method.split(", "),
  domain,
  apiFile: `apps/api/src/${domain}.ts`,
  ...(auth ? { auth } : {}),
});

describe("contract items", () => {
  it("keys surface items by method and path, ignoring key order", () => {
    expect(canonical({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
    const items = surfaceItems({ routes: { "/x": route("GET, POST", "x") } });
    expect([...items.keys()]).toEqual(["GET /x", "POST /x"]);
  });

  it("diffs added, modified and removed items in the head's order", () => {
    const base = {
      routes: {
        "/a": { ...route("GET", "a"), path: "/a" },
        "/b": { ...route("GET", "b"), path: "/b" },
      },
    };
    const head = {
      routes: {
        "/c": { ...route("PUT", "c"), path: "/c" },
        "/a": { ...route("GET", "moved"), path: "/a" },
      },
    };
    expect(contractDiff("surface", base, head)).toEqual([
      { contract: "surface", action: "ADD", item: "PUT /c" },
      { contract: "surface", action: "MODIFY", item: "GET /a" },
      { contract: "surface", action: "REMOVE", item: "GET /b" },
    ]);
  });

  it("compares auth only once the base records it", () => {
    const unrecorded = { routes: { "/x": route("GET", "x") } };
    const recorded = { routes: { "/x": route("GET", "x", "public") } };
    expect(contractDiff("surface", unrecorded, recorded)).toEqual([]);
    const user = { routes: { "/x": route("GET", "x", "user") } };
    expect(contractDiff("surface", recorded, user)).toEqual([
      { contract: "surface", action: "MODIFY", item: "GET /x" },
    ]);
  });

  it("keys fleet, dictionary, actions and slots items", () => {
    expect(
      contractDiff(
        "fleet",
        { apps: { api: { why: "a" } } },
        { apps: { api: { why: "b" }, web: {} } },
      ),
    ).toEqual([
      { contract: "fleet", action: "MODIFY", item: "apps.api" },
      { contract: "fleet", action: "ADD", item: "apps.web" },
    ]);
    const table = {
      tables: { t: { columns: { c: { type: "text", concept: "email" } } } },
      concepts: { email: {} },
    };
    expect(contractDiff("dictionary", {}, table).map((c) => c.item)).toEqual([
      "t",
      "t.c",
      "concept:email",
    ]);
    expect(contractDiff("actions", { actions: { a: 1 } }, { actions: {} })[0]?.action).toBe(
      "REMOVE",
    );
    expect(contractDiff("slots", {}, { treatments: { t: {} } })[0]?.item).toBe("treatment:t");
  });

  it("names the fields a modification changed", () => {
    expect(
      modifiedFields('{"auth":"public","domain":"x"}', '{"auth":"user","domain":"x"}'),
    ).toEqual(['auth: "public" -> "user"']);
  });

  it("matches calls to route templates", () => {
    expect(routeMatches("/v1/items/:id", "/v1/items/:itemId")).toBe(true);
    expect(routeMatches("/v1/files/a/b", "/v1/files/*")).toBe(true);
    expect(routeMatches("/v1/other/a", "/v1/files/*")).toBe(false);
    expect(routeMatches("/v1/items", "/v1/items/:id")).toBe(false);
  });
});

describe("contract intent", () => {
  const changes = [
    { contract: "surface" as const, action: "ADD" as const, item: "POST /v1/rooms" },
    { contract: "surface" as const, action: "MODIFY" as const, item: "GET /v1/rooms/:id" },
  ];

  it("passes a body that declares every change exactly", () => {
    const body = [
      "## Summary",
      "Rooms.",
      "",
      "## Contract Intent",
      "- ADD surface POST /v1/rooms (members create rooms from the lobby)",
      "- MODIFY surface GET /v1/rooms/:id (the room now carries its members)",
      "",
      "## Test plan",
      "- unit tests",
    ].join("\n");
    const { issues, audited } = judgeIntent(changes, body, new Set());
    expect(issues).toEqual([]);
    expect(audited.map((a) => a.why)).toEqual([
      "members create rooms from the lobby",
      "the room now carries its members",
    ]);
  });

  it("reports an undeclared change, a declared one that did not happen, and a missing reason", () => {
    const body =
      "## Contract Intent\n- ADD surface POST /v1/rooms (no)\n- REMOVE surface GET /v1/old (gone for good)\n";
    expect(judgeIntent(changes, body, new Set()).issues).toEqual([
      'Say why for ADD surface POST /v1/rooms: "no" is not a reason.',
      'Undeclared contract change: MODIFY surface GET /v1/rooms/:id. Add "- MODIFY surface GET /v1/rooms/:id (why)" under "## Contract Intent" in the PR body.',
      "Declared but not changed: REMOVE surface GET /v1/old.",
    ]);
  });

  it("refuses a malformed line and reads the legacy Surface Intent block", () => {
    const { declared, errors } = parseIntent(
      "## Contract Intent\n- ADD surface POST /v1/rooms\n\n## Surface Intent\n+ POST /v1/rooms/: members create rooms\n",
    );
    expect(errors[0]).toContain('Invalid Contract Intent line: "- ADD surface POST /v1/rooms"');
    expect(declared).toEqual([
      {
        action: "ADD",
        contract: "surface",
        legacy: true,
        path: "/v1/rooms",
        method: "POST",
        why: "members create rooms",
      },
    ]);
    expect(
      judgeIntent(
        [changes[0]!],
        "## Surface Intent\n+ POST /v1/rooms: members create rooms\n",
        new Set(),
      ).issues,
    ).toEqual([]);
  });

  it("lets a new contract be added whole with *", () => {
    const body = "## Contract Intent\n- ADD surface * (the first surface of this repo)\n";
    expect(judgeIntent([changes[0]!], body, new Set(["surface"])).issues).toEqual([]);
    expect(judgeIntent([changes[0]!], body, new Set()).issues[0]).toContain(
      "Undeclared contract change",
    );
  });

  it("lets a new table's line cover its columns", () => {
    const tableChanges = [
      { contract: "dictionary" as const, action: "ADD" as const, item: "orders" },
      { contract: "dictionary" as const, action: "ADD" as const, item: "orders.total" },
    ];
    const body = "## Contract Intent\n- ADD dictionary orders (orders are stored now)\n";
    expect(judgeIntent(tableChanges, body, new Set()).issues).toEqual([]);
  });
});

describe("surface queries", () => {
  const surface: FeatureSurface = {
    routes: {
      "/v1/items": {
        path: "/v1/items",
        method: "GET",
        domain: "items",
        apiFile: "api/items.ts",
        auth: { GET: "public", POST: "admin" },
        clientConsumers: ["web/items.ts"],
      },
      "/v1/users": {
        path: "/v1/users",
        method: "GET",
        domain: "users",
        apiFile: "api/users.ts",
        auth: "user",
      },
    },
    webServices: { "web/items.ts": { file: "web/items.ts", routesCalled: ["/v1/items"] } },
    mobileServices: { "mobile/users.ts": { file: "mobile/users.ts", routesCalled: ["/v1/users"] } },
  };

  it("reads auth as one level or per method", () => {
    expect(authText(surface.routes!["/v1/items"]!)).toBe("GET public, POST admin");
    expect(authText(surface.routes!["/v1/users"]!)).toBe("user");
  });

  it("finds routes by caller unless api-only, and client services by file or call", () => {
    expect(matchRoutes(surface, "web/items", false).map((r) => r.path)).toEqual(["/v1/items"]);
    expect(matchRoutes(surface, "web/items", true)).toEqual([]);
    expect(matchRoutes(surface, "admin", true).map((r) => r.path)).toEqual(["/v1/items"]);
    expect(clientServices(surface, "users").map((s) => `${s.kind} ${s.file}`)).toEqual([
      "mobile mobile/users.ts",
    ]);
    expect(clientServices(surface, "").map((s) => s.kind)).toEqual(["mobile", "web"]);
  });
});
