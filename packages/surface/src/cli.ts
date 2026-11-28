// @effect-diagnostics nodeBuiltinImport:off - headless CLI on node:* builtins only.
/**
 * The `surface` command line: query a repo's generated feature surface, judge
 * contract intent, and onboard a repo. It runs no repo code.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { gateBase } from "./surfaceBase.ts";
import { checkIntent, exitCodeOf, renderIntentResults } from "./surfaceIntentCheck.ts";
import { runIntentDiff } from "./surfaceIntentDiff.ts";
import { initSurface } from "./surfaceInit.ts";
import {
  declaredContracts,
  findContractPath,
  findRepoRoot,
  generateCommand,
} from "./surfaceLocate.ts";
import { clientServices, domainRows, type FeatureSurface, matchRoutes } from "./surfaceQuery.ts";
import {
  dashboardJson,
  pythonJsonDumps,
  renderClientServices,
  renderDashboard,
  renderDomains,
  renderRoutes,
} from "./surfaceRender.ts";

export const EXIT_UNPROVEN = 3;

export const HELP = `surface: System-wide feature surface query and onboarding engine for AI agents and developers.

Provides sub-20ms lookup across cross-stack seams:
  - Route handlers, methods and auth levels (public / user / admin / service)
  - Domain categorization
  - Client / mobile service callers
  - Storage / cache keys
  - Background worker roles

Usage:
  surface                      # Dashboard overview
  surface <query>              # Deep lookup by route, domain, worker, or service
  surface api <filter>         # Routes whose path, domain, handler file or auth matches
  surface client <filter>      # Client services whose file or called path matches
  surface <query> --json       # Compact JSON output for agents & tooling
  surface --list               # List all domains with route and worker counts
  surface diff [base_ref] [--json]
                               # Contract changes against base (as playbook intent-diff prints them)
  surface check [--base REF] [--body FILE]
                               # Judge the PR body's ## Contract Intent (body: --body, else SHIP_QUEUE_BODYFILE)
  surface verify-intent FILE   # surface check with that body file
  surface init [--force]       # Onboard the current repository to feature surfaces

surface reads the repo's generated surface file (playbook.json
contracts.intent.contracts.surface, else .tree-guard.conf surface_contract, else
config/contracts/feature-surfaces.json). It runs no repo code: the repo's own
generate command writes the file. A surface file with no route proves nothing
about the API it declares: it is UNPROVEN (exit 3), never a pass.`;

export interface SurfaceCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_IO: SurfaceCliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
};

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--base", "--body"]);

/** The first argument that is neither a flag nor a value flag's value. */
function positional(args: ReadonlyArray<string>): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (VALUE_FLAGS.has(a)) i += 1;
    else if (!a.startsWith("-")) return a;
  }
  return null;
}

function flagValue(args: ReadonlyArray<string>, flag: string): string | null {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1] ?? null;
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

function query(contractPath: string, args: ReadonlyArray<string>, io: SurfaceCliIo): number {
  const surface = JSON.parse(NodeFS.readFileSync(contractPath, "utf8")) as FeatureSurface;
  const json = args.includes("--json");
  const words = args.filter((a) => !a.startsWith("-"));
  const print = (v: unknown, text: string) =>
    io.out(json ? `${pythonJsonDumps(v)}\n` : `${text}\n`);
  if (args.includes("--list") || args.includes("-l")) {
    const rows = domainRows(surface);
    print(rows, renderDomains(rows));
  } else if (words[0] === "client") {
    const q = words.slice(1).join(" ").trim().toLowerCase();
    const found = clientServices(surface, q);
    print(
      found,
      found.length > 0 ? renderClientServices(found) : `  No client services match "${q}".\n`,
    );
  } else if (words.length > 0) {
    const apiOnly = words[0] === "api";
    const q = (apiOnly ? words.slice(1) : words).join(" ").trim().toLowerCase();
    const matched = matchRoutes(surface, q, apiOnly);
    print(
      matched,
      matched.length > 0 ? renderRoutes(matched) : `  No routes or services match "${q}".\n`,
    );
  } else {
    print(dashboardJson(surface), renderDashboard(surface));
  }
  if (Object.keys(surface.routes ?? {}).length === 0) {
    io.err(
      `UNPROVEN surface: ${NodePath.relative(io.cwd, contractPath)} records 0 routes; the repo declares an API, so a scan that ` +
        "found nothing proves nothing (configure its route roots and regenerate)\n",
    );
    return EXIT_UNPROVEN;
  }
  return 0;
}

function readBody(
  path: string | null,
  io: SurfaceCliIo,
): { body: string | null; code: number | null } {
  if (path === null) return { body: null, code: null };
  const full = NodePath.resolve(io.cwd, path);
  try {
    return { body: NodeFS.readFileSync(full, "utf8"), code: null };
  } catch {
    io.err(`surface: ${full} does not exist\n`);
    return { body: null, code: 2 };
  }
}

function check(
  root: string,
  args: ReadonlyArray<string>,
  bodyPath: string | null,
  io: SurfaceCliIo,
): number {
  const { body, code } = readBody(bodyPath, io);
  if (code !== null) return code;
  const base = flagValue(args, "--base") ?? gateBase(root, io.env).sha;
  const results = checkIntent({ root, base, body, inQueueJob: Boolean(io.env.SHIP_QUEUE_JOB) });
  io.out(
    `${args.includes("--json") ? JSON.stringify(results, null, 2) : renderIntentResults(results)}\n`,
  );
  return exitCodeOf(results);
}

/** `surface diff [base_ref] [--json]`: the original's `playbook intent-diff --contract surface`. */
function diff(root: string, args: ReadonlyArray<string>, io: SurfaceCliIo): number {
  const surface = declaredContracts(root).surface;
  return runIntentDiff({
    root,
    files: surface ? { surface } : {},
    base: args.find((a) => a !== "--json") ?? null,
    json: args.includes("--json"),
    env: io.env,
    out: io.out,
    err: io.err,
  });
}

/** Runs the CLI; returns its exit code. */
export function runSurfaceCli(argv: ReadonlyArray<string>, io: SurfaceCliIo = DEFAULT_IO): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out(`${HELP}\n`);
    return 0;
  }
  const root = findRepoRoot(io.cwd);
  if (!root) {
    io.err("surface: not inside a git repository\n");
    return 1;
  }
  const [cmd = "", ...rest] = argv;
  if (cmd === "init" || cmd === "onboard") {
    return initSurface(root, rest.includes("--force") || rest.includes("-f"), io);
  }
  if (cmd === "diff") return diff(root, rest, io);
  if (cmd === "verify-intent" || cmd === "verify") {
    const body = positional(rest) ?? (io.env.SHIP_QUEUE_BODYFILE || null);
    if (!body) {
      io.err("surface: verify-intent needs the PR body file: surface verify-intent body.md\n");
      return 2;
    }
    return check(root, rest, body, io);
  }
  if (cmd === "check" || argv.includes("--check")) {
    return check(root, rest, flagValue(rest, "--body") ?? (io.env.SHIP_QUEUE_BODYFILE || null), io);
  }
  if (argv.includes("--generate")) {
    io.err(
      "surface: surface runs no repo code; regenerate the surface with the repo's generate " +
        `command: ${generateCommand(root)}\n`,
    );
    return 2;
  }
  const contractPath = findContractPath(root);
  if (!contractPath) {
    io.err(
      `surface: no feature surface contract found in ${root}.\n\nTo onboard this repository, run:\n  surface init\n\n` +
        "It writes the generator into the repo and derives the first contract.\n",
    );
    return 1;
  }
  return query(contractPath, argv, io);
}
