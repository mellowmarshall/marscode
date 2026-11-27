/**
 * `playbook check fleet`: composes with `@t3tools/fleet` (`checkFleetShape`) so schema,
 * entity, cross-reference, and rotation rules live in one place with zero duplication,
 * then judges `contracts.fleet.reads` env reads and provider kind switches against the base.
 */
import { checkFleetShape } from "@t3tools/fleet";

import type { BaselineEntry } from "../baseline.ts";
import { changedFiles, readWorktreeFile, showFile, trackedFiles } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import { judgeFindings, type GateFinding } from "./findings.ts";

const CHECK = "fleet";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_ENV = new Set(
  "HOME PATH USER LOGNAME SHELL PWD OLDPWD TMPDIR TMP TEMP LANG LC_ALL TZ TERM HOSTNAME CI NODE_ENV NODE_OPTIONS DEV PROD MODE SSR BASE_URL XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR DISPLAY EDITOR PAGER".split(
    " ",
  ),
);

function underRoot(rel: string, root: string): boolean {
  const clean = root.replace(/\/+$/, "");
  return rel === root || clean === "" || clean === "." || rel.startsWith(`${clean}/`);
}

function envReadFindings(
  shape: Readonly<Record<string, unknown>>,
  used: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<GateFinding> {
  const out: GateFinding[] = [];
  const env = isRecord(shape.env) ? shape.env : {};
  const apps = isRecord(shape.apps) ? shape.apps : {};
  const backups = isRecord(shape.backups) ? shape.backups : {};
  const codeRootsRaw = isRecord(shape.codeRoots) ? shape.codeRoots : {};
  const roots = new Map<string, string>();
  for (const [name, app] of Object.entries(apps)) {
    if (isRecord(app)) roots.set(name, typeof app.root === "string" ? app.root : "");
  }
  const appRoots = [...roots.values()].filter((r) => r !== "" && r !== ".");
  const codeRoots: string[] = [];
  for (const cr of Object.values(codeRootsRaw)) {
    if (isRecord(cr) && Array.isArray(cr.roots)) {
      for (const r of cr.roots) if (typeof r === "string") codeRoots.push(r);
    }
  }

  for (const [name, files] of [...used.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const entry = env[name];
    if (!isRecord(entry)) {
      if (RUNTIME_ENV.has(name)) continue;
      out.push({
        rule: "fleet/env",
        file: name,
        text: name,
        message: `read in ${files[0]} but not declared under env`,
      });
      continue;
    }
    const entryApps = Array.isArray(entry.apps)
      ? entry.apps.filter((a): a is string => typeof a === "string")
      : [];
    const placed: string[] = [];
    for (const appName of entryApps) {
      const r = roots.get(appName);
      if (r !== undefined) placed.push(r);
      const b = backups[appName];
      if (isRecord(b)) {
        if (typeof b.script === "string") placed.push(b.script);
        if (typeof b.drill === "string") placed.push(b.drill);
      }
    }
    for (const rel of files) {
      if (placed.some((r) => underRoot(rel, r))) continue;
      if (entry.tooling === true && !appRoots.some((r) => underRoot(rel, r))) continue;
      if (codeRoots.some((r) => underRoot(rel, r))) continue;
      out.push({
        rule: "fleet/env",
        file: name,
        text: name,
        message: `read in ${rel}, which is under none of its apps (${entryApps.join(", ") || "none"})`,
      });
      break;
    }
  }
  return out;
}

function providerChangesNeedingOwner(
  baseShape: unknown,
  headShape: unknown,
): ReadonlyArray<string> {
  const headProviders =
    isRecord(headShape) && isRecord(headShape.providers) ? headShape.providers : {};
  const baseProviders =
    isRecord(baseShape) && isRecord(baseShape.providers) ? baseShape.providers : {};
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(headProviders).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isRecord(raw)) continue;
    const prev = isRecord(baseProviders[name]) ? baseProviders[name] : null;
    if (raw.kind === "declared" && prev && prev.kind !== "declared") {
      problems.push(`provider '${name}' switched from '${String(prev.kind)}' to 'declared'`);
    }
    if (
      raw.kind === "declared" &&
      typeof raw.live === "string" &&
      typeof raw.tokenVariable === "string"
    ) {
      const prevLive = prev && typeof prev.live === "string" ? prev.live : null;
      const prevTok = prev && typeof prev.tokenVariable === "string" ? prev.tokenVariable : null;
      if (prevLive !== raw.live || prevTok !== raw.tokenVariable) {
        problems.push(
          `provider '${name}' adds or changes a credentialed declared live command (${raw.tokenVariable})`,
        );
      }
    }
  }
  return problems;
}

async function runEnvReads(input: {
  readonly root: string;
  readonly command: string;
  readonly base: string | null;
  readonly shape: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal | undefined;
}): Promise<{
  readonly reads: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly error: CheckResult | null;
}> {
  const ran = await runStep(
    input.root,
    input.command,
    { PLAYBOOK_BASE: input.base ?? "" },
    undefined,
    input.signal,
  );
  if (ran.code === null) {
    return {
      reads: new Map(),
      error: unproven(CHECK, `the env-read command did not run: ${ran.why}`, {
        errors: tailLines(ran, 10),
        files: ["playbook.json"],
        fix: "make contracts.fleet.reads runnable on this host",
      }),
    };
  }
  if (ran.code !== 0) {
    return {
      reads: new Map(),
      error: failed(CHECK, `the env-read command exited ${ran.code}`, {
        errors: tailLines(ran, 10),
        files: ["playbook.json"],
        fix: "contracts.fleet.reads must exit 0 and print the env names the code reads",
      }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout) as unknown;
  } catch (cause) {
    return {
      reads: new Map(),
      error: failed(CHECK, `the env-read command printed no JSON object: ${String(cause)}`, {
        errors: tailLines(ran, 5),
        files: ["playbook.json"],
        fix: 'contracts.fleet.reads prints {"NAME": ["file", ...], ...}',
      }),
    };
  }
  if (!isRecord(parsed)) {
    return {
      reads: new Map(),
      error: failed(CHECK, "the env-read command's answer is not a JSON object", {
        files: ["playbook.json"],
        fix: 'contracts.fleet.reads prints {"NAME": ["file", ...], ...}',
      }),
    };
  }
  const tracked = new Set(trackedFiles(input.root) ?? []);
  const bad: string[] = [];
  const reads = new Map<string, ReadonlyArray<string>>();
  for (const [name, rawFiles] of Object.entries(parsed)) {
    if (!ENV_NAME_RE.test(name)) {
      bad.push(`'${name}' is not an env name`);
      continue;
    }
    if (
      !Array.isArray(rawFiles) ||
      rawFiles.length === 0 ||
      !rawFiles.every((f): f is string => typeof f === "string")
    ) {
      bad.push(`${name}: its value is not a non-empty list of files`);
      continue;
    }
    const missing = rawFiles.find((f) => !tracked.has(f));
    if (missing) {
      bad.push(`${name}: ${missing} is not a tracked file of the repo`);
      continue;
    }
    reads.set(name, [...new Set(rawFiles)].toSorted());
  }
  if (bad.length > 0) {
    return {
      reads: new Map(),
      error: failed(
        CHECK,
        `the env-read command's answer is not in the fixed shape (${bad.length} problem(s))`,
        {
          errors: bad.slice(0, 10),
          files: ["playbook.json"],
          fix: 'contracts.fleet.reads prints {"NAME": ["tracked file", ...], ...}',
        },
      ),
    };
  }
  const providers = isRecord(input.shape.providers) ? input.shape.providers : {};
  const tokens = new Set<string>();
  for (const p of Object.values(providers)) {
    if (isRecord(p) && typeof p.tokenVariable === "string") tokens.add(p.tokenVariable);
  }
  const env = isRecord(input.shape.env) ? input.shape.env : {};
  const declaredPlaced = Object.entries(env).filter(
    ([name, e]) =>
      !tokens.has(name) &&
      isRecord(e) &&
      ((Array.isArray(e.apps) && e.apps.length > 0) || e.tooling === true),
  ).length;
  if (reads.size === 0 && declaredPlaced > 0) {
    return {
      reads: new Map(),
      error: unproven(
        CHECK,
        `the env-read command named no env name, though the shape says code reads ${declaredPlaced}`,
        {
          files: ["playbook.json"],
          fix: "contracts.fleet.reads prints every env name the code reads",
        },
      ),
    };
  }
  return { reads, error: null };
}

export async function fleetGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly base: string | null;
  readonly ask: (reason: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const file = input.settings.file;
  if (typeof file !== "string" || !file.trim()) {
    return [failed(CHECK, "contracts.fleet.file is not declared", { files: ["playbook.json"] })];
  }
  const text = readWorktreeFile(input.root, file);
  if (text === null) {
    return [
      failed(CHECK, `${file} cannot be read (missing or symlink outside repo)`, {
        files: [file],
        fix: "create the fleet shape file declared in contracts.fleet.file",
      }),
    ];
  }
  let shape: unknown;
  try {
    shape = parseStrictJson(text);
  } catch (cause) {
    return [
      failed(
        CHECK,
        `${file} cannot be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          files: [file],
        },
      ),
    ];
  }
  const readsCmd = input.settings.reads;
  if (typeof readsCmd !== "string" || !readsCmd.trim()) {
    return [
      failed(
        CHECK,
        "contracts.fleet.reads is not declared: the repo's own command lists the env names its code reads",
        {
          files: ["playbook.json"],
          fix: 'declare contracts.fleet.reads, a command that prints {"NAME": ["file", ...]}',
        },
      ),
    ];
  }
  const shapeObj = isRecord(shape) ? shape : {};
  const envRun = await runEnvReads({
    root: input.root,
    command: readsCmd,
    base: input.base,
    shape: shapeObj,
    signal: input.signal,
  });
  if (envRun.error) return [envRun.error];

  const fleetResult = checkFleetShape(shape, file);
  const findings: GateFinding[] = [
    ...fleetResult.schemaErrors.map((err) => ({
      rule: "fleet/schema",
      file: err.split(":", 1)[0] ?? "(root)",
      text: err,
      message: err,
    })),
    ...fleetResult.findings.map((f) => ({
      rule: f.rule,
      file: f.item,
      text: f.problem,
      message: f.problem,
    })),
  ];
  if (fleetResult.schemaErrors.length === 0 && isRecord(shape)) {
    findings.push(...envReadFindings(shape, envRun.reads));
  }

  const touched = new Set<string>();
  if (input.base && typeof input.settings.baseline === "string") {
    const changed = new Set(
      (changedFiles(input.root, input.base, "HEAD") ?? []).map((c) => c.path),
    );
    for (const [name, srcFiles] of envRun.reads) {
      if (srcFiles.some((f) => changed.has(f))) touched.add(name);
    }
  }
  const baselinePath = typeof input.settings.baseline === "string" ? input.settings.baseline : null;
  const judged = judgeFindings(findings, input.entries, { baselinePath, touched });
  const results: CheckResult[] = [];
  if (judged.problems.length > 0) {
    results.push(
      failed(CHECK, `${judged.problems.length} fleet finding(s) in ${file}`, {
        errors: judged.problems,
        files: [file],
        fix: `fix each finding in ${file} or baseline existing debt in contracts.fleet.baseline`,
      }),
    );
  } else {
    const nonRuntimeCount = [...envRun.reads.keys()].filter((n) => !RUNTIME_ENV.has(n)).length;
    results.push(
      passed(
        CHECK,
        `${nonRuntimeCount} env name(s) read in code, ${fleetResult.entityCount} fleet entit(ies) valid`,
      ),
    );
  }

  const baseShapeText = input.base ? showFile(input.root, input.base, file) : null;
  let baseShape: unknown = {};
  if (baseShapeText) {
    try {
      baseShape = JSON.parse(baseShapeText) as unknown;
    } catch {
      baseShape = {};
    }
  }
  const providerMoves = providerChangesNeedingOwner(baseShape, shape);
  if (providerMoves.length > 0) {
    const reason = `fleet providers: ${providerMoves.join("; ").slice(0, 360)}`;
    if (await input.ask(reason)) {
      results.push(
        passed(`${CHECK} providers`, `${providerMoves.length} provider change(s) under override`),
      );
    } else {
      results.push(
        failed(`${CHECK} providers`, providerMoves[0]!, {
          errors: providerMoves,
          files: [file],
          fix: "keep the provider kind and declared live command as on the base, or request owner override",
        }),
      );
    }
  }
  return results;
}
