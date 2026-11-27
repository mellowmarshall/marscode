// @effect-diagnostics nodeBuiltinImport:off - Reads playbook.json from the real worktree.
/**
 * playbook.json: the single loader and parser (strict JSON, retired keys and
 * settings, closed-field schema validation). Every reader of the declaration
 * (the CLI, the gates, the challenger, the server's declaration view) uses it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import schemaJson from "../schema/playbook.schema.json" with { type: "json" };
import { validateAgainstSchema } from "./declarationSchema.ts";
import { isRecord, parseStrictJson, StrictJsonError } from "./strictJson.ts";

const isStrictJsonError = Schema.is(StrictJsonError);

export const HOST_VERSION = "7";
export const DECLARATION = "playbook.json";
const MAX_DECLARATION_BYTES = 512 * 1024;

/** Contracts in gate order: design first so its scan reads files before any check runs repo code. */
export const CONTRACT_NAMES = [
  "design",
  "size",
  "tools",
  "migrations",
  "dictionary",
  "fleet",
  "generations",
  "intent",
  "actions",
  "optimization",
] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

const PIN =
  "the version pin is removed: one rule set applies to every repo the moment it is released; delete";
const MOVED =
  "no longer read here: the owner's exceptions are in host-guards/exceptions.json; delete bypass from playbook.json";
const ONE = "one rule set for every repo: ";
const OWN = "the repo declares its own checks: ";

const RETIRED_KEYS: Readonly<Record<string, string>> = {
  playbook: `${PIN} the 'playbook' key from playbook.json`,
  version: `${PIN} the 'version' key from playbook.json`,
  stack_overrides:
    "removed: whether a repo has a DB, a UI or an API is detected from its tree; delete stack_overrides",
  bypass: MOVED,
};

const RETIRED_SETTING_LIST: ReadonlyArray<readonly [string, string, string]> = [
  ["size", "limit", `${ONE}the limit is 500 for every repo; delete size.limit`],
  ["size", "scope", `${ONE}the scope is every source language the host counts; delete size.scope`],
  ["size", "formatter", `${OWN}the repo's size.command counts its files; delete size.formatter`],
  ["fleet", "form", `${ONE}one fleet schema with providers as data; delete fleet.form`],
  ["dictionary", "markdown", `${ONE}a generated catalog is the generations contract's`],
  ["dictionary", "protection", `${ONE}every table declares its protection tier`],
  ["tools", "tools", `${OWN}declare each lint, typecheck and other step in tools.steps`],
  ["tools", "osv", `${OWN}declare the dependency audit as a deps step in tools.steps`],
  ["tools", "baselines", `${OWN}the playbook holds no tool Baseline; delete tools.baselines`],
  ["tools", "exceptions", `${OWN}accepted advisories are the deps step's own config`],
  ["tools", "knip_env", `${OWN}a step's environment is its own command's`],
  ["migrations", "name", `${ONE}a new migration's name follows its runner's naming`],
  ["migrations", "runner", `${OWN}declare migrations.lint and migrations.replay.command`],
  ["actions", "tests", `${OWN}declare actions.evidence`],
  ...[
    "size",
    "tools",
    "migrations",
    "dictionary",
    "fleet",
    "generations",
    "intent",
    "actions",
    "design",
    "optimization",
  ].map((c) => [c, "bypass", MOVED] as const),
];

const RETIRED_SETTINGS: ReadonlyMap<string, string> = new Map(
  RETIRED_SETTING_LIST.map(([contract, key, why]) => [`${contract}.${key}`, why]),
);

const RETIRED_CONTRACTS: Readonly<Record<string, string>> = {
  junk: `${ONE}tracked junk is the ship queue's house stage in every repo; delete contracts.junk`,
};

export type DeclarationData = Readonly<Record<string, unknown>>;

export interface Declaration {
  readonly path: string;
  readonly data: DeclarationData | null;
  readonly errors: ReadonlyArray<string>;
}

export function contractsOf(data: DeclarationData | null): Readonly<Record<string, unknown>> {
  const contracts = data?.contracts;
  return isRecord(contracts) ? contracts : {};
}

export function contractSettings(
  data: DeclarationData | null,
  name: string,
): Readonly<Record<string, unknown>> {
  const body = contractsOf(data)[name];
  return isRecord(body) ? body : {};
}

/** A contract declared only as `{"none": "<reason>"}`. */
export function optedOut(body: unknown): boolean {
  return isRecord(body) && Object.keys(body).length === 1 && "none" in body;
}

function dropRetired(data: Record<string, unknown>): Record<string, unknown> {
  const out = Object.fromEntries(Object.entries(data).filter(([k]) => !(k in RETIRED_KEYS)));
  const contracts = out.contracts;
  if (isRecord(contracts)) {
    const cleaned: Record<string, unknown> = {};
    for (const [name, body] of Object.entries(contracts)) {
      if (name in RETIRED_CONTRACTS) continue;
      cleaned[name] = isRecord(body)
        ? Object.fromEntries(
            Object.entries(body).filter(([k]) => !RETIRED_SETTINGS.has(`${name}.${k}`)),
          )
        : body;
    }
    out.contracts = cleaned;
  }
  return out;
}

/** Every problem with DATA: retired keys and settings first, then the schema's. */
export function validateDeclaration(data: unknown): ReadonlyArray<string> {
  const errors: string[] = [];
  let checked = data;
  if (isRecord(data)) {
    for (const [key, why] of Object.entries(RETIRED_KEYS)) {
      if (key in data) errors.push(`${key}: ${why}`);
    }
    const contracts = data.contracts;
    if (isRecord(contracts)) {
      for (const [name, body] of Object.entries(contracts)) {
        if (name in RETIRED_CONTRACTS) errors.push(`contracts.${name}: ${RETIRED_CONTRACTS[name]}`);
        if (!isRecord(body)) continue;
        for (const key of Object.keys(body)) {
          const why = RETIRED_SETTINGS.get(`${name}.${key}`);
          if (why) errors.push(`contracts.${name}.${key}: ${why}`);
        }
      }
    }
    checked = dropRetired(data);
  }
  errors.push(...validateAgainstSchema(checked, schemaJson as Readonly<Record<string, unknown>>));
  return errors;
}

export interface ParsedDeclaration {
  readonly data: DeclarationData | null;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Validate a declaration given as text. BASE: a base commit's copy, whose
 * retired keys and settings are dropped rather than refused, so the change
 * that removes them is compared with it.
 */
export function parseDeclarationText(
  text: string,
  options: { readonly base?: boolean } = {},
): ParsedDeclaration {
  let data: unknown;
  try {
    data = parseStrictJson(text);
  } catch (cause) {
    const why = isStrictJsonError(cause) ? cause.detail : String(cause);
    return { data: null, errors: [`not valid JSON: ${why}`] };
  }
  if (options.base === true && isRecord(data)) data = dropRetired(data);
  const errors = validateDeclaration(data);
  return { data: isRecord(data) ? data : null, errors };
}

/** The real worktree's playbook.json. */
export function loadDeclaration(root: string): Declaration {
  const path = NodePath.join(root, DECLARATION);
  let text: string;
  try {
    const st = NodeFS.lstatSync(path);
    if (!st.isFile()) return { path, data: null, errors: [`${DECLARATION} is not a regular file`] };
    if (st.size > MAX_DECLARATION_BYTES) {
      return { path, data: null, errors: [`${DECLARATION} is larger than 512 KiB`] };
    }
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return { path, data: null, errors: [`${DECLARATION} is missing`] };
  }
  const parsed = parseDeclarationText(text);
  return {
    path,
    data: parsed.data,
    errors: parsed.errors.map((e) =>
      e.startsWith("not valid JSON") ? `${DECLARATION} is ${e}` : e,
    ),
  };
}

/** The declaration as playbook.json is written: two-space JSON with a trailing newline. */
export function renderDeclaration(data: DeclarationData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
