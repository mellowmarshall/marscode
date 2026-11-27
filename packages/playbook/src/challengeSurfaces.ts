/**
 * Which surfaces a change touches, to guide the declaration challenge's reviewer (every change
 * is reviewed): routes, SQL-holding files, UI, declarations, new modules, CI and check files.
 */
import { contractsOf, parseDeclarationText } from "./declaration.ts";
import { diffText, parseConf, showFile, showFiles, type ChangedFile } from "./git.ts";
import { isRecord } from "./strictJson.ts";

export const DECLARATION_PATTERNS = [
  ".tree-guard.conf",
  "playbook.json",
  "fleet-shape.json",
  "config/contracts",
  "config/schema",
  "config/baselines",
  "config/playbook",
  "scripts/ship",
  "migrations",
] as const;

const SQL_STATEMENT =
  /\b(?:select\b[^;]{0,2000}?\bfrom|insert\s+into|delete\s+from|update\s+[\w."]+\s+set|with\s+(?:recursive\s+)?[\w"]+\s+as\s*\(|on\s+conflict|merge\s+into|create\s+(?:unique\s+)?(?:table|index|view)|alter\s+table|drop\s+(?:table|index|view)|truncate\s+table)\b/i;

const ROUTE_PATTERNS = [
  "/routes/",
  "/route.",
  "/routes.",
  "/endpoints/",
  "/api/",
  "/handlers/",
  "/controllers/",
  "/server/",
  "routes.py",
  "route.py",
  "router.py",
  "routes.ts",
  "route.ts",
  "router.ts",
  "handlers.go",
  "routes.go",
  "server.go",
  "app.py",
  "server.ts",
  "server.js",
];
const DB_PATTERNS = [
  "/migrations/",
  "/models/",
  "/queries/",
  "/db/",
  "/database/",
  "/schema/",
  "/sql/",
  "schema.sql",
  "models.py",
  "queries.sql",
  ".sql",
  "dictionary.json",
  "drizzle",
  "prisma",
  "alembic",
];
const UI_PATTERNS = [
  "/components/",
  "/web/",
  "/ui/",
  "/views/",
  "/pages/",
  "/frontend/",
  "/client/",
  "/app/",
  "/screens/",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".html",
];
const CODE_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".vue",
  ".svelte",
  ".sql",
];
const CI_CHECK_PREFIXES = [
  "scripts/ci/",
  "scripts/playbook/",
  "scripts/gates/",
  "scripts/ship/",
  "scripts/lint/",
  "scripts/generate/",
  "scripts/drills/",
  ".githooks/",
  ".github/workflows/",
];
const CI_CHECK_EXACT = new Set(["playbook.json", ".tree-guard.conf", "ci-local.sh", "ci_local.sh"]);
const CMD_FILE_RE =
  /["']?(?:\.\/)?([A-Za-z0-9_][A-Za-z0-9_./-]*(?:\/[A-Za-z0-9_./-]+|\.(?:sh|bash|py|mjs|js|cjs|ts|json)))\b/g;

const has = (p: string, list: ReadonlyArray<string>) => list.some((x) => p.includes(x));

/** Changed files (by tip path) whose content at the tip, or at the base under the old path, holds SQL. */
export function sqlChangedPaths(
  root: string,
  base: string,
  tip: string,
  changed: ReadonlyArray<ChangedFile>,
): ReadonlySet<string> {
  const sides = (f: ChangedFile) => [`${tip}:${f.path}`, `${base}:${f.oldPath ?? f.path}`];
  const blobs = showFiles(root, changed.flatMap(sides));
  return new Set(
    changed
      .filter((f) => sides(f).some((spec) => SQL_STATEMENT.test(blobs.get(spec) ?? "")))
      .map((f) => f.path),
  );
}

/** The `apiFile` of every route the feature surface declares at BASE and TIP; null when none. */
export function declaredRouteFiles(root: string, refs: ReadonlyArray<string>): Set<string> | null {
  const files = new Set<string>();
  for (const ref of refs) {
    const text = showFile(root, ref, "playbook.json");
    if (text === null) continue;
    const intent = contractsOf(parseDeclarationText(text, { base: true }).data).intent;
    const surfaceRel =
      isRecord(intent) && isRecord(intent.contracts) ? intent.contracts.surface : null;
    if (typeof surfaceRel !== "string") continue;
    let surface: unknown = null;
    try {
      surface = JSON.parse(showFile(root, ref, surfaceRel) ?? "null") as unknown;
    } catch {
      continue;
    }
    const routes = isRecord(surface) ? surface.routes : null;
    for (const route of isRecord(routes) ? Object.values(routes) : []) {
      if (isRecord(route) && typeof route.apiFile === "string") files.add(route.apiFile);
    }
  }
  return files.size > 0 ? files : null;
}

function classifyFile(
  path: string,
  isNew: boolean,
  routes: ReadonlySet<string> | null,
  sqlChanged: boolean,
): Set<string> {
  const cats = new Set<string>();
  const p = `/${path.replaceAll("\\", "/").toLowerCase()}`;
  const base = p.split("/").at(-1) ?? "";
  if (DECLARATION_PATTERNS.some((d) => p.includes(d.toLowerCase()))) cats.add("declaration");
  if (
    has(p, [".test.", "_test.", ".spec.", "/tests/", "/test/", "/testing/", "/ci/"]) ||
    base.startsWith("test_") ||
    base.startsWith("test-")
  ) {
    return cats.add("test");
  }
  if (/\.(md|txt|rst|adoc)$/.test(p) || p.includes("/docs/") || p.includes("/doc/")) {
    return cats.add("docs");
  }
  if (has(p, ["/scripts/", ".githooks"]) || /ci[-_]local\.sh$/.test(p)) return cats.add("other");
  const patterns = routes === null ? ROUTE_PATTERNS : ROUTE_PATTERNS.filter((r) => r !== "/api/");
  if (routes?.has(path) || has(p, patterns)) cats.add("route");
  if (sqlChanged || has(p, DB_PATTERNS)) cats.add("database");
  if (has(p, UI_PATTERNS)) {
    const native = p.endsWith(".go") || p.endsWith(".py");
    if (!native || has(p, ["component", "view", "template", "html", "render"])) cats.add("ui");
  }
  const code = CODE_EXTS.some((ext) => p.endsWith(ext));
  if (isNew && code) cats.add("new_feature");
  else if (code && !["route", "database", "ui", "declaration"].some((c) => cats.has(c))) {
    cats.add("backend");
  }
  if (cats.size === 0) cats.add("other");
  return cats;
}

export function formatSurfacesSummary(
  changed: ReadonlyArray<ChangedFile>,
  routes: ReadonlySet<string> | null,
  sqlPaths: ReadonlySet<string>,
): string {
  const groups: Record<string, string[]> = {
    route: [],
    database: [],
    ui: [],
    new_feature: [],
    declaration: [],
    backend: [],
    other: [],
  };
  for (const file of changed) {
    const isNew = file.status === "A";
    const label = isNew
      ? `[NEW] ${file.path}`
      : file.oldPath
        ? `[MOVED] ${file.oldPath} -> ${file.path}`
        : `[MOD] ${file.path}`;
    const cats = classifyFile(file.path, isNew, routes, sqlPaths.has(file.path));
    if (file.oldPath && classifyFile(file.oldPath, false, routes, false).has("route")) {
      cats.add("route");
      cats.delete("backend");
    }
    for (const key of ["route", "database", "ui", "new_feature", "declaration", "backend"]) {
      if (cats.has(key)) groups[key]!.push(label);
    }
    if (cats.has("test") || cats.has("docs") || cats.has("other")) groups.other!.push(label);
  }
  const titles: ReadonlyArray<readonly [string, string, number]> = [
    ["route", "Routes / APIs touched", 15],
    ["database", "Database / Queries touched", 15],
    ["ui", "UI / Frontend touched", 15],
    ["new_feature", "New Feature Code / Modules added", 15],
    ["declaration", "Declarations & Contracts touched", 15],
    ["backend", "Backend & Service Logic modified", 15],
    ["other", "Other files (tests/docs/tooling)", 10],
  ];
  const sections = titles
    .filter(([key]) => groups[key]!.length > 0)
    .map(([key, title, cap]) => {
      const list = groups[key]!;
      return `${title} (${list.length}):\n  ${list.slice(0, cap).join("\n  ")}`;
    });
  const runtime = ["route", "database", "ui", "new_feature", "backend"];
  if (runtime.every((k) => groups[k]!.length === 0)) {
    sections.unshift(
      "Runtime surfaces touched: None (0 routes, 0 queries, 0 UI, 0 backend files).",
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : "No surfaces changed.";
}

function commandPaths(cmd: unknown): ReadonlyArray<string> {
  if (Array.isArray(cmd)) return cmd.flatMap(commandPaths);
  if (typeof cmd !== "string") return [];
  return [...cmd.matchAll(CMD_FILE_RE)].map((m) => m[1]!).filter((p) => !p.startsWith(".."));
}

function declaredCheckFiles(root: string, ref: string): Set<string> {
  const out = new Set(CI_CHECK_EXACT);
  for (const values of Object.values(parseConf(showFile(root, ref, ".tree-guard.conf") ?? ""))) {
    for (const v of values)
      for (const part of v.split(",")) commandPaths(part).forEach((p) => out.add(p));
  }
  const text = showFile(root, ref, "playbook.json");
  const contracts = text ? contractsOf(parseDeclarationText(text, { base: true }).data) : {};
  for (const c of Object.values(contracts)) {
    if (!isRecord(c)) continue;
    for (const k of ["command", "lint", "render", "allowlist", "slots", "reads"]) {
      commandPaths(c[k]).forEach((p) => out.add(p));
    }
    for (const step of Array.isArray(c.steps) ? c.steps : []) {
      if (isRecord(step)) commandPaths(step.run).forEach((p) => out.add(p));
    }
  }
  return out;
}

/** Changed CI or playbook check files and their diff, or "(none)". */
export function ciAndCheckChanges(
  root: string,
  base: string,
  tip: string,
  changed: ReadonlyArray<ChangedFile>,
): string {
  const known = new Set([...declaredCheckFiles(root, base), ...declaredCheckFiles(root, tip)]);
  const isCheck = (path: string) => {
    const norm = path.replaceAll("\\", "/").replace(/^\.\//, "");
    return (
      known.has(norm) ||
      CI_CHECK_EXACT.has(norm.split("/").at(-1) ?? "") ||
      CI_CHECK_PREFIXES.some((p) => norm.startsWith(p))
    );
  };
  const touched: string[] = [];
  const diffPaths: string[] = [];
  for (const f of changed) {
    if (!isCheck(f.path) && !(f.oldPath && isCheck(f.oldPath))) continue;
    if (!touched.includes(f.path)) touched.push(f.path);
    for (const p of f.oldPath ? [f.oldPath, f.path] : [f.path]) {
      if (!diffPaths.includes(p)) diffPaths.push(p);
    }
  }
  if (touched.length === 0) return "(none)";
  let text = diffText(root, base, tip, diffPaths).trim();
  if (text.length > 24_000)
    text = `${text.slice(0, 24_000)}\n... (CI/check diff truncated at 24k chars)`;
  const list = touched.map((p) => `  - ${p}`).join("\n");
  return `CI / Playbook check files modified (${touched.length}):\n${list}\n\n${text || "(no diff text)"}`;
}
