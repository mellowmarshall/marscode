// @effect-diagnostics nodeBuiltinImport:off - headless CLI on node:* builtins only.
/**
 * The `fleet` command line: query, check and start a repo's fleet shape (the
 * one fleet schema: apps, roles, env, stores, permissions, providers).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { checkFleetShape } from "./fleetCheck.ts";
import {
  type FleetEntity,
  normalizeKind,
  OldFleetForm,
  parseEntities,
  queryEntities,
} from "./fleetEntities.ts";
import { FLEET_LOCATIONS, findFleetDeclaration, findRepoRoot } from "./fleetLocate.ts";
import { pythonJsonDumps, renderCheck, renderDashboard, renderEntity } from "./fleetRender.ts";

export const HELP = `fleet: Infrastructure and fleet declaration query, validation, and onboarding engine.

Provides sub-20ms lookup across declared infrastructure:
  - Workloads, applications, and compose services
  - Cloud hosts, machines, and network topologies
  - Datastores, volumes, and object buckets
  - Worker roles, background jobs, leases, and SLAs
  - Secret names, rotation policies, and credential classification
  - Edge routing, hostnames, and ingress policies

Usage:
  fleet                      # Fleet inventory overview
  fleet <name>               # Deep lookup by app, host, secret, role, or bucket
  fleet <name> --json        # Machine-readable JSON output
  fleet --kind <kind>        # Filter entities by kind (host, service, role, secret, etc.)
  fleet check [--json]       # Schema, cross-reference and rotation check of the shape
  fleet init [dir] [--force] # Write a first fleet shape in the one schema

The fleet file is the one the repo's playbook.json declares (contracts.fleet.file),
else ${FLEET_LOCATIONS.join(", ")}.`;

export interface FleetCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
}

const DEFAULT_IO: FleetCliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: process.cwd(),
};

/** A first shape: every section of the one schema, empty, so `fleet check` passes on it. */
export function starterShape(repoName: string): Record<string, unknown> {
  return {
    why: [`${repoName}: what is deployed, what runs, the env it reads, and where it all lives`],
    apps: {},
    roles: {},
    env: {},
    stores: {},
    permissions: {},
    providers: {},
  };
}

function initFleet(target: string, force: boolean, io: FleetCliIo): number {
  const file = NodePath.join(target, "fleet-shape.json");
  if (NodeFS.existsSync(file) && !force) {
    io.err(`fleet: ${file} already exists (pass --force to replace it)\n`);
    return 1;
  }
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.writeFileSync(
    file,
    `${JSON.stringify(starterShape(NodePath.basename(target)), null, 2)}\n`,
  );
  io.out(
    `fleet: wrote ${file}\nNext: declare apps, roles, env, stores, permissions and providers, then run fleet check.\n`,
  );
  return 0;
}

interface Query {
  readonly json: boolean;
  readonly kind: string | null;
  readonly query: string;
}

function parseQuery(argv: ReadonlyArray<string>): Query {
  let json = false;
  let kind: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") json = true;
    else if ((arg === "--kind" || arg === "-k") && i + 1 < argv.length) {
      i += 1;
      kind = normalizeKind(argv[i]);
    } else if (arg.startsWith("--kind=")) kind = normalizeKind(arg.slice("--kind=".length));
    else if (!arg.startsWith("-")) words.push(arg);
  }
  return { json, kind, query: words.join(" ").trim().toLowerCase() };
}

function loadShape(repoRoot: string, io: FleetCliIo): { file: string; shape: unknown } | null {
  const full = findFleetDeclaration(repoRoot);
  if (!full) {
    io.err(
      `fleet: error: no fleet declaration found in ${repoRoot}.\nSearched: ${FLEET_LOCATIONS.join(", ")}\n` +
        "Run 'fleet init' to scaffold fleet infrastructure declaration.\n",
    );
    return null;
  }
  const file = NodePath.relative(repoRoot, full);
  try {
    return { file, shape: JSON.parse(NodeFS.readFileSync(full, "utf8")) };
  } catch (error) {
    io.err(`fleet: error: could not parse ${full}: ${(error as Error).message}\n`);
    return null;
  }
}

function lookup(
  entities: ReadonlyArray<FleetEntity>,
  file: string,
  q: Query,
  io: FleetCliIo,
): number {
  if (!q.query && !q.kind) {
    io.out(`${q.json ? pythonJsonDumps(entities) : renderDashboard(entities, file)}\n`);
    return 0;
  }
  const results = queryEntities(entities, q.query, q.kind);
  if (q.json) {
    io.out(`${pythonJsonDumps(results)}\n`);
    return 0;
  }
  if (results.length === 0) {
    io.err(
      `No declared fleet entity matches '${q.query || q.kind}'.\nUndeclared is a finding: add it to ${file}.\n`,
    );
    return 1;
  }
  io.out(`${results.length} match(es) in ${file}:\n\n${results.map(renderEntity).join("\n\n")}\n`);
  return 0;
}

/** Runs the CLI; returns its exit code. */
export function runFleetCli(argv: ReadonlyArray<string>, io: FleetCliIo = DEFAULT_IO): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(`${HELP}\n`);
    return 0;
  }
  const repoRoot = findRepoRoot(io.cwd);
  if (argv[0] === "init") {
    const dir = argv.slice(1).find((a) => !a.startsWith("-"));
    const target = NodePath.resolve(io.cwd, dir ?? repoRoot ?? io.cwd);
    return initFleet(target, argv.includes("--force"), io);
  }
  if (!repoRoot) {
    io.err("fleet: error: must be run inside a git repository.\n");
    return 1;
  }
  const loaded = loadShape(repoRoot, io);
  if (!loaded) return 1;
  if (argv[0] === "check") {
    const result = checkFleetShape(loaded.shape, loaded.file);
    io.out(`${argv.includes("--json") ? JSON.stringify(result, null, 2) : renderCheck(result)}\n`);
    return result.ok ? 0 : 1;
  }
  let entities: FleetEntity[];
  try {
    entities = parseEntities(loaded.shape, loaded.file);
  } catch (error) {
    if (!(error instanceof OldFleetForm)) throw error;
    io.err(`fleet: error: ${error.message}\n`);
    return 1;
  }
  return lookup(entities, loaded.file, parseQuery(argv), io);
}
