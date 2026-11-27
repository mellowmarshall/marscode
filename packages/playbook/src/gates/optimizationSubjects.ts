/**
 * Optimization budget subject discovery and timing-aware schema preparation (PLAYBOOK §11).
 * Composes with `@t3tools/surface` (`surfaceItems`) to enumerate route subjects alongside
 * fleet roles and user actions.
 */
import { surfaceItems } from "@t3tools/surface";

import optSchemaJson from "../../schema/optimization-budgets.schema.json" with { type: "json" };
import { readWorktreeFile } from "../git.ts";
import { isRecord, parseStrictJson } from "../strictJson.ts";
import { isTimedBudgets } from "./optimizationRatchet.ts";

export function readStrictJsonFile(
  root: string,
  rel: unknown,
): { readonly data: unknown; readonly error: string | null } {
  if (typeof rel !== "string" || !rel) return { data: null, error: "not declared" };
  const text = readWorktreeFile(root, rel);
  if (text === null) return { data: null, error: "does not exist" };
  try {
    return { data: parseStrictJson(text), error: null };
  } catch (cause) {
    return {
      data: null,
      error: `cannot be read (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
}

export function listOptimizationSubjects(
  root: string,
  declaration: Readonly<Record<string, unknown>>,
): { readonly owners: ReadonlyMap<string, string | null>; readonly problems: string[] } {
  const contracts = isRecord(declaration.contracts) ? declaration.contracts : {};
  const owners = new Map<string, string | null>();
  const problems: string[] = [];

  const intentCfg =
    isRecord(contracts.intent) && isRecord(contracts.intent.contracts)
      ? contracts.intent.contracts
      : {};
  if (typeof intentCfg.surface === "string") {
    const { data, error } = readStrictJsonFile(root, intentCfg.surface);
    if (error) problems.push(`the feature surface ${intentCfg.surface} ${error}`);
    else if (isRecord(data)) {
      const routes = isRecord(data.routes) ? data.routes : {};
      for (const key of surfaceItems(data, false).keys()) {
        const path = key.split(" ", 2)[1] ?? "";
        const route = isRecord(routes[path]) ? routes[path] : {};
        owners.set(key, typeof route.apiFile === "string" ? route.apiFile : null);
      }
    }
  }
  for (const [contract, section, prefix] of [
    ["fleet", "roles", "role:"],
    ["actions", "actions", "action:"],
  ] as const) {
    const cfg = contracts[contract];
    const rel = isRecord(cfg) && typeof cfg.file === "string" ? cfg.file : null;
    if (!rel) continue;
    const { data, error } = readStrictJsonFile(root, rel);
    if (error) problems.push(`the ${contract} file ${rel} ${error}`);
    else if (isRecord(data) && isRecord(data[section])) {
      for (const [name, item] of Object.entries(data[section])) {
        const owner = isRecord(item)
          ? (["source", "module", "apiFile"]
              .map((k) => item[k])
              .find((v): v is string => typeof v === "string" && v.length > 0) ?? null)
          : null;
        owners.set(`${prefix}${name}`, owner);
      }
    }
  }
  return { owners, problems };
}

export function schemaWithTiming(data: unknown): Readonly<Record<string, unknown>> {
  const cloned = structuredClone(optSchemaJson) as Record<string, unknown>;
  if (isTimedBudgets(data)) {
    const defs = cloned.$defs as Record<string, Record<string, unknown>>;
    const budget = defs.budget!;
    budget.required = [...(budget.required as string[]), "maxMs"];
    const step = (budget.properties as Record<string, Record<string, unknown>>).steps!
      .items as Record<string, unknown>;
    step.required = [...(step.required as string[]), "maxMs"];
  }
  return cloned;
}
