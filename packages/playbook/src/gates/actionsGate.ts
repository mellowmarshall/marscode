// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check actions`: user actions catalog and test evidence (PLAYBOOK §9).
 * Composes with `@t3tools/surface` (`surfaceItems`) to validate `apiRoute`/`request:` routes,
 * runs `contracts.actions.evidence.run`, validates schema immutability, and judges findings vs Baseline.
 */
import * as NodePath from "node:path";

import { surfaceItems } from "@t3tools/surface";
import * as Schema from "effect/Schema";

import { fingerprint, type BaselineEntry } from "../baseline.ts";
import { sectionRuleReasons, type Bypasses } from "../bypass.ts";
import { SchemaKeywordError, validateAgainstSchema } from "../declarationSchema.ts";
import { changedFiles, readWorktreeFile, showFile, worktreePathExists } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import {
  isVacuousOracle,
  parseOracle,
  patternRegex,
  runActionsEvidence,
  selectsAction,
} from "./actionsEvidence.ts";
import { findingIdentity, judgeFindings, type GateFinding } from "./findings.ts";

const CHECK = "actions";
const isSchemaKeywordError = Schema.is(SchemaKeywordError);
const EVIDENCE_RULES = new Set(["actions/untested", "actions/untagged-test"]);

function schemaPathFor(catalogRel: string, catalogText: string | null): string {
  try {
    const parsed = catalogText ? (JSON.parse(catalogText) as unknown) : null;
    if (isRecord(parsed) && typeof parsed.$schema === "string" && parsed.$schema) {
      return NodePath.posix.normalize(
        NodePath.posix.join(NodePath.posix.dirname(catalogRel), parsed.$schema),
      );
    }
  } catch {
    // fall through
  }
  return catalogRel.endsWith(".json")
    ? `${catalogRel.slice(0, -5)}.schema.json`
    : `${catalogRel}.schema.json`;
}

function readSurfaceRoutes(root: string, surfaceRel: string | null): ReadonlySet<string> | null {
  if (!surfaceRel) return null;
  const text = readWorktreeFile(root, surfaceRel);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    return new Set(surfaceItems(parsed, false).keys());
  } catch {
    return null;
  }
}

export async function actionsGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly entries: ReadonlyArray<BaselineEntry>;
  readonly bypasses: Bypasses;
  readonly base: string | null;
  readonly baseData: Readonly<Record<string, unknown>> | null;
  readonly ask: (reason: string) => Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const catalogRel = input.settings.file;
  if (typeof catalogRel !== "string" || !catalogRel.trim()) {
    return [failed(CHECK, "contracts.actions does not declare file", { files: ["playbook.json"] })];
  }
  const catalogText = readWorktreeFile(input.root, catalogRel);
  if (catalogText === null) {
    return [failed(CHECK, `${catalogRel}: cannot be read`, { files: [catalogRel] })];
  }
  let catalog: unknown;
  try {
    catalog = parseStrictJson(catalogText);
  } catch (cause) {
    return [
      failed(
        CHECK,
        `${catalogRel}: cannot be read as JSON (${cause instanceof Error ? cause.message : String(cause)})`,
        {
          files: [catalogRel],
        },
      ),
    ];
  }
  const actions = isRecord(catalog) && isRecord(catalog.actions) ? catalog.actions : null;
  if (!actions) {
    return [failed(CHECK, `${catalogRel}: missing 'actions' object`, { files: [catalogRel] })];
  }

  const evRes = await runActionsEvidence(input);
  if (!evRes.ok) return [evRes.result];

  const hardProblems: string[] = [];
  const softProblems: string[] = [];
  const schemaRel = schemaPathFor(catalogRel, catalogText);
  const schemaText = readWorktreeFile(input.root, schemaRel);
  if (schemaText !== null) {
    let schemaObj: unknown;
    try {
      schemaObj = parseStrictJson(schemaText);
    } catch (cause) {
      hardProblems.push(
        `${schemaRel}: cannot be parsed as strict JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      );
      schemaObj = null;
    }
    if (schemaObj !== null) {
      if (!isRecord(schemaObj)) {
        hardProblems.push(`${schemaRel}: schema must be a JSON object`);
      } else {
        try {
          for (const err of validateAgainstSchema(catalog, schemaObj)) {
            hardProblems.push(`${catalogRel}: ${err}`);
          }
        } catch (cause) {
          if (!isSchemaKeywordError(cause)) {
            hardProblems.push(
              `${schemaRel}: schema validation failed (${cause instanceof Error ? cause.message : String(cause)})`,
            );
          }
        }
      }
    }
  }

  const heldBack = isRecord(input.settings.held_back) ? input.settings.held_back : null;
  if (heldBack && typeof heldBack.file === "string") {
    const hbText = readWorktreeFile(input.root, heldBack.file);
    if (hbText === null) {
      hardProblems.push(`contracts.actions.held_back names ${heldBack.file}, which does not exist`);
    } else {
      try {
        const hb = JSON.parse(hbText) as unknown;
        const features = isRecord(hb) && isRecord(hb.features) ? hb.features : {};
        for (const rawAct of Object.values(actions)) {
          if (!isRecord(rawAct) || typeof rawAct.featureFlag !== "string") continue;
          if (!(rawAct.featureFlag in features)) continue;
          const feat = features[rawAct.featureFlag];
          if (!isRecord(feat) || !Array.isArray(feat.modules)) {
            softProblems.push(
              `${heldBack.file}: feature ${rawAct.featureFlag} has no modules list`,
            );
          }
        }
      } catch (cause) {
        hardProblems.push(`${heldBack.file} is not valid JSON (${String(cause)})`);
      }
    }
  }

  const contracts = isRecord(input.declaration.contracts) ? input.declaration.contracts : {};
  const intentCfg =
    isRecord(contracts.intent) && isRecord(contracts.intent.contracts)
      ? contracts.intent.contracts
      : {};
  const surfaceRel = typeof intentCfg.surface === "string" ? intentCfg.surface : null;
  const routes = readSurfaceRoutes(input.root, surfaceRel);
  const surfaceName = surfaceRel ?? "the feature surface (intent.contracts.surface)";
  const actionIds = new Set(Object.keys(actions));
  const actionRecords = Object.values(actions).filter(isRecord);

  for (const [id, rawAct] of Object.entries(actions)) {
    if (!isRecord(rawAct)) continue;
    const oracle = parseOracle(rawAct.oracle);
    const needsJourney =
      Boolean(rawAct.apiRoute) || oracle?.kind === "navigatesTo" || oracle?.kind === "request";
    if (needsJourney && rawAct.level !== "journey") {
      hardProblems.push(`action '${id}' must have "level": "journey"`);
    }
    const routeRefs = [
      typeof rawAct.apiRoute === "string" ? rawAct.apiRoute : null,
      oracle?.kind === "request" ? oracle.value : null,
    ].filter((r): r is string => Boolean(r));
    for (const route of routeRefs) {
      if (!routes)
        softProblems.push(`action '${id}': ${surfaceName} cannot be read to check '${route}'`);
      else if (!routes.has(route))
        hardProblems.push(`action '${id}': '${route}' is not a route in ${surfaceName}`);
    }
    if (
      typeof rawAct.testIDPattern === "string" &&
      !patternRegex(rawAct.testIDPattern).test(String(rawAct.instance ?? ""))
    ) {
      hardProblems.push(
        `action '${id}': instance '${String(rawAct.instance)}' does not match testIDPattern '${rawAct.testIDPattern}'`,
      );
    }
    if (Array.isArray(rawAct.requires)) {
      for (const req of rawAct.requires) {
        if (typeof req !== "string") continue;
        if (!actionIds.has(req))
          hardProblems.push(`action '${id}': requires '${req}', which is not in the catalog`);
        if (req === id) hardProblems.push(`action '${id}': requires itself`);
      }
    }
    if (isRecord(rawAct.motion)) {
      const src = typeof rawAct.motion.source === "string" ? rawAct.motion.source : "";
      const paths = src.match(/(?:apps|packages)\/[^\s;,()]+/g) ?? [];
      if (paths.length === 0)
        hardProblems.push(
          `action '${id}': motion.source must name the file that defines the motion`,
        );
      for (const p of paths) {
        if (!worktreePathExists(input.root, p))
          hardProblems.push(`action '${id}': motion source not found: ${p}`);
      }
    }
  }

  for (const p of evRes.problems) hardProblems.push(`the action evidence reports: ${p}`);
  if (evRes.tests.length === 0 && actionIds.size > 0) {
    softProblems.push("the action evidence (contracts.actions.evidence) reports no test");
  }

  const proven = new Map<string, Set<string>>();
  const findings: GateFinding[] = [];
  for (const test of evRes.tests) {
    for (const id of test.actions) {
      const act = actions[id];
      if (!isRecord(act)) {
        hardProblems.push(
          `${test.file}:${test.line}: '${test.title}' names action ${id}, which is not in ${catalogRel}`,
        );
        continue;
      }
      if (!test.selectors.some((sel) => selectsAction(act, sel, actionRecords))) {
        const target = String(
          act.testID ?? `${String(act.instance)} (${String(act.testIDPattern)})`,
        );
        hardProblems.push(
          `${test.file}:${test.line}: '${test.title}' names action ${id} but never selects its testID ${target}`,
        );
        continue;
      }
      let set = proven.get(id);
      if (!set) {
        set = new Set();
        proven.set(id, set);
      }
      set.add(test.kind);
    }
    if (test.actions.length === 0 && test.kind === "e2e") {
      findings.push({
        rule: "actions/untagged-test",
        file: test.file,
        text: test.title,
        where: `${test.file}:${test.line}`,
        message: `'${test.title}' names no action; name the action it exercises in the evidence`,
      });
    }
  }
  for (const [id, rawAct] of Object.entries(actions)) {
    if (!isRecord(rawAct)) continue;
    const kind = rawAct.level === "widget" ? "component" : "e2e";
    if (!proven.get(id)?.has(kind)) {
      findings.push({
        rule: "actions/untested",
        file: catalogRel,
        text: `action ${id}`,
        where: catalogRel,
        message: `${id} (${String(rawAct.level ?? "journey")}) has no ${kind} test that exercises it`,
      });
    }
    if (isVacuousOracle(rawAct.oracle, rawAct.level)) {
      const oracle = parseOracle(rawAct.oracle);
      findings.push({
        rule: "actions/vacuous-oracle",
        file: catalogRel,
        text: `action ${id}`,
        where: catalogRel,
        message: `action '${id}' has a vacuous oracle 'visible: ${oracle?.value}'`,
      });
    }
  }

  const out: CheckResult[] = [];
  if (hardProblems.length > 0) {
    out.push(
      failed(CHECK, `${hardProblems.length} catalog problem(s)`, {
        errors: hardProblems,
        files: [catalogRel],
      }),
    );
  }
  if (softProblems.length > 0) {
    out.push(
      unproven(CHECK, `${softProblems.length} catalog check(s) could not look`, {
        errors: softProblems,
      }),
    );
  }

  const waived = sectionRuleReasons(input.bypasses, 9, ["Repo evidence"]);
  const activeFindings =
    waived.length > 0 ? findings.filter((f) => !EVIDENCE_RULES.has(f.rule)) : findings;
  if (waived.length > 0) {
    out.push(passed(`${CHECK} evidence`, `waived by the owner: ${waived[0]![1]}`));
  }

  const touched = new Set<string>();
  if (input.base && typeof input.settings.baseline === "string") {
    const changed = new Set(
      (changedFiles(input.root, input.base, "HEAD") ?? []).map((c) => c.path),
    );
    for (const [id, rawAct] of Object.entries(actions)) {
      if (!isRecord(rawAct)) continue;
      const owners = ["source", "module", "apiFile", "motionFile"]
        .map((k) => rawAct[k])
        .filter((v): v is string => typeof v === "string");
      if (owners.some((o) => changed.has(o))) {
        const fp = fingerprint(`action ${id}`);
        touched.add(JSON.stringify(["actions/untested", catalogRel, fp]));
        touched.add(JSON.stringify(["actions/vacuous-oracle", catalogRel, fp]));
        touched.add(findingIdentity("actions/untested", catalogRel, `action ${id}`));
      }
    }
  }
  const baselinePath = typeof input.settings.baseline === "string" ? input.settings.baseline : null;
  const judged = judgeFindings(activeFindings, input.entries, { baselinePath, touched });
  const summary = `${actionIds.size} action(s), ${evRes.tests.length} test(s) in the evidence`;
  if (judged.problems.length > 0) {
    out.push(
      failed(CHECK, `${judged.problems.length} catalog finding(s)`, {
        errors: judged.problems,
        files: [catalogRel],
      }),
    );
  } else if (hardProblems.length === 0 && softProblems.length === 0) {
    out.push(passed(CHECK, `${summary}; every action tested at its level, every e2e test tagged`));
  }

  // Schema immutability vs base
  const baseContracts = isRecord(input.baseData?.contracts) ? input.baseData.contracts : {};
  const baseActions = isRecord(baseContracts.actions) ? baseContracts.actions : {};
  if (input.base && typeof baseActions.file === "string") {
    const baseCatalogText = showFile(input.root, input.base, baseActions.file);
    const baseSchemaRel = schemaPathFor(baseActions.file, baseCatalogText);
    const baseSchemaText = showFile(input.root, input.base, baseSchemaRel);
    if (baseSchemaText !== null && (schemaRel !== baseSchemaRel || schemaText !== baseSchemaText)) {
      const reason = `actions schema changed: ${baseSchemaRel} -> ${schemaRel}`;
      if (await input.ask(reason)) {
        out.push(passed(`${CHECK} schema`, "the catalog's schema changed under override"));
      } else {
        out.push(
          failed(`${CHECK} schema`, `the catalog's schema ${schemaRel} differs from the base's`, {
            files: [schemaRel],
            fix: "restore the base's schema or request owner override",
          }),
        );
      }
    }
  }
  return out;
}
