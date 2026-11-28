/** Text views of a fleet shape: the overview dashboard, an entity card, and a check report. */
import type { FleetEntity } from "./fleetEntities.ts";
import type { FleetCheckResult } from "./fleetCheck.ts";

const RULE = "=".repeat(80);
const LINE = "-".repeat(80);

/** Python's str() of a JSON value, so a card reads as devtools' fleet printed it. */
function pyStr(v: unknown): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null) return "None";
  if (typeof v === "object") return pyJson(v);
  return String(v);
}

/** Python's json.dumps with its default separators. */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`);
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(v);
}

/** Python's json.dumps(indent=2): two-space JSON with every non-ASCII character escaped (ensure_ascii). */
export function pythonJsonDumps(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Python's str.capitalize. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function renderDashboard(entities: ReadonlyArray<FleetEntity>, fleetFile: string): string {
  const count = (k: string) => entities.filter((e) => e.kind === k).length;
  const secrets = entities.filter((e) => e.kind === "secret");
  const classified = secrets.filter((s) => Boolean(s.rotation)).length;
  const lines = [
    RULE,
    "                       FLEET DECLARATION & TOPOLOGY",
    RULE,
    `  Declaration: ${fleetFile}`,
    LINE,
    `  Workloads:   ${count("service")} Services / Applications`,
    `  Hosts:       ${count("host")} Cloud Servers / Hosts`,
    `  Datastores:  ${count("datastore") + count("volume") + count("bucket")} Stores (${count("datastore")} DBs, ${count("volume")} Volumes, ${count("bucket")} Buckets)`,
    `  Background:  ${count("job")} Worker Roles & Jobs`,
    `  Security:    ${secrets.length} Secrets (${classified} with a rotation record, ${secrets.length - classified} without)`,
    `  Routing:     ${count("route")} Ingress Routes & Zones`,
  ];
  if (count("decision") > 0)
    lines.push(`  Decisions:   ${count("decision")} Open Architectural Decisions`);
  lines.push(
    LINE,
    "QUICK LOOKUP EXAMPLES:",
    "  fleet <name>               Lookup any app, host, secret, role, or bucket",
    "  fleet outbox               Inspect role execution, secret reads, and SLAs",
    "  fleet DATABASE_URL         Find where a secret is stored, who reads and checks it",
    "  fleet --kind host          List all cloud servers and private IPs",
    "  fleet --kind bucket        List all storage buckets",
    "  fleet --kind service       List all container services and applications",
    "  fleet check                Run full consistency and drift evaluation",
    RULE,
  );
  return lines.join("\n");
}

const SKIP = new Set(["name", "kind", "type", "sourceFile"]);

export function renderEntity(entity: FleetEntity): string {
  const lines = [LINE, `[${entity.kind.toUpperCase()}] ${entity.name} (${entity.type})`, LINE];
  for (const [k, v] of Object.entries(entity)) {
    if (SKIP.has(k) || v === null || v === undefined || v === "") continue;
    const label = capitalize(k.replaceAll("_", " ")).padEnd(16);
    const value = Array.isArray(v) ? (v.length > 0 ? v.map(pyStr).join(", ") : "none") : pyStr(v);
    lines.push(`  ${label}: ${value}`);
  }
  return lines.join("\n");
}

export function renderCheck(result: FleetCheckResult): string {
  const lines: string[] = [];
  const problems = result.schemaErrors.length + result.findings.length;
  const verdict = problems === 0 ? "PASS" : "FAIL";
  lines.push(
    `fleet check: ${verdict} ${result.file}: ${result.entityCount} entities, ` +
      `${result.schemaErrors.length} schema error(s), ${result.findings.length} finding(s)`,
  );
  for (const e of result.schemaErrors) lines.push(`  fleet/schema  ${e}`);
  for (const f of result.findings) lines.push(`  ${f.rule.padEnd(13)} ${f.item}: ${f.problem}`);
  return lines.join("\n");
}
