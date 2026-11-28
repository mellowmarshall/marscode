// @effect-diagnostics nodeBuiltinImport:off - Reads playbook.json and runs bash's ERE check, as the original playbook does.
/**
 * playbook.json as the original playbook reads it for `actions`: its loader, retired keys and
 * settings, and closed-field validator over schema/original-playbook.schema.json (the original's
 * schema without its prose), so a refusal names the same problems in the same words and order.
 */ import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import schemaJson from "../schema/original-playbook.schema.json" with { type: "json" };
import { isPyJsonError, pyJsonLoads, pyReadText } from "./pyJson.ts";
import { pyPattern, pyRegexError } from "./pyRegex.ts";
import {
  fromPlain,
  isDict,
  isInt,
  numeric,
  PyDict,
  PyFloat,
  pyLen,
  pyRepr,
  pyEq,
  type PyValue,
} from "./pyValues.ts";

const DECLARATION = "playbook.json";
const SCHEMA = fromPlain(schemaJson) as PyDict;

const PIN =
  "the version pin is removed: one rule set applies to every repo the moment the playbook releases it; delete the";
const MOVED =
  "no longer read here: the owner's exceptions are in host-guards/exceptions.json; delete bypass from playbook.json";
const ONE = "one rule set for every repo: ";
const OWN = "the repo declares its own checks: ";

const RETIRED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["playbook", `${PIN} 'playbook' key from playbook.json`],
  ["version", `${PIN} 'version' key from playbook.json`],
  [
    "stack_overrides",
    "removed: whether a repo has a DB, a UI or an API is detected from its tree (migrations, UI files, routes), never declared; delete stack_overrides from playbook.json",
  ],
  ["bypass", MOVED],
];

const RETIRED_SETTINGS: ReadonlyArray<readonly [string, string, string]> = [
  ["size", "limit", `${ONE}the limit is 500 for every repo; delete size.limit`],
  ["size", "scope", `${ONE}the scope is every source language the host counts; delete size.scope`],
  ["size", "formatter", `${OWN}the repo's size.command counts its files; delete size.formatter`],
  [
    "fleet",
    "form",
    `${ONE}one fleet schema with providers as data (pb_fleet_shape); delete fleet.form and migrate the file`,
  ],
  [
    "dictionary",
    "markdown",
    `${ONE}a generated catalog is the generations contract's; delete dictionary.markdown`,
  ],
  [
    "dictionary",
    "protection",
    `${ONE}every table declares its protection tier; delete dictionary.protection`,
  ],
  ["tools", "tools", `${OWN}declare each lint, typecheck and other step in tools.steps`],
  ["tools", "osv", `${OWN}declare the dependency audit as a deps step in tools.steps`],
  [
    "tools",
    "baselines",
    `${OWN}the playbook holds no tool Baseline; declare tools.steps and delete tools.baselines`,
  ],
  [
    "tools",
    "exceptions",
    `${OWN}accepted advisories are the deps step's own config; delete tools.exceptions`,
  ],
  ["tools", "knip_env", `${OWN}a step's environment is its own command's; delete tools.knip_env`],
  [
    "migrations",
    "name",
    `${ONE}a new migration's name follows its runner's naming (pb_migration_names); delete migrations.name`,
  ],
  [
    "migrations",
    "runner",
    `${OWN}declare the migration lint (migrations.lint) and the replay (migrations.replay.command); delete migrations.runner`,
  ],
  [
    "actions",
    "tests",
    `${OWN}declare actions.evidence (the command that prints each test's actions and selectors); delete actions.tests`,
  ],
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
    "docs",
  ].map((c) => [c, "bypass", MOVED] as const),
];

const RETIRED_CONTRACTS: ReadonlyArray<readonly [string, string]> = [
  [
    "junk",
    `${ONE}tracked junk is the ship queue's house stage in every repo; delete contracts.junk`,
  ],
];

const BAD_ESCAPE = /\\([A-Za-z0-9])/;
const LAZY = /[*+?}][?+]/;

/** Why VALUE does not mean the same in Python and in bash ERE, or null (the original's check, bash included). */
function portableRegexProblem(value: string, binPath: string): string | null {
  const escape = BAD_ESCAPE.exec(value);
  if (escape) return `\\${escape[1]} is not an ERE escape (write a bracket class such as [0-9])`;
  if (value.includes("[:")) {
    return "[: (a POSIX class such as [[:alpha:]]) is ERE only; Python reads it as a set; list the characters, [a-z]";
  }
  if (value.includes("(?"))
    return "(? groups (non-capturing, lookaround, flags) are not ERE; use plain ( )";
  const lazy = LAZY.exec(value);
  if (lazy) return `${lazy[0]} (a lazy or possessive quantifier) is not ERE`;
  const compiled = pyRegexError(value);
  if (compiled !== null) return `not a valid regex (${compiled})`;
  const res = NodeChildProcess.spawnSync(
    "bash",
    ["-c", "[[ x =~ $1 ]]; [ $? -ne 2 ]", "_", value],
    {
      timeout: 5000,
      stdio: "ignore",
      env: { PATH: binPath },
    },
  );
  if (res.error || res.status === null) return null;
  return res.status === 0 ? null : "bash cannot compile it as an ERE";
}

function resolve(node: PyDict): PyDict {
  let current = node;
  while (current.has("$ref")) {
    let target: PyValue | undefined = SCHEMA;
    for (const part of String(current.get("$ref")).slice(2).split("/")) {
      target = isDict(target) ? target.get(part) : undefined;
    }
    current = target as PyDict;
  }
  return current;
}

function typeOk(value: PyValue, name: string): boolean {
  switch (name) {
    case "null":
      return value === null;
    case "object":
      return isDict(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return isInt(value);
    case "number":
      return isInt(value) || value instanceof PyFloat;
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

const gotName = (v: PyValue) =>
  v === null
    ? "null"
    : typeof v === "boolean"
      ? "bool"
      : isInt(v)
        ? "int"
        : v instanceof PyFloat
          ? "float"
          : typeof v === "string"
            ? "str"
            : Array.isArray(v)
              ? "list"
              : "dict";

const where = (path: string) => path || "top level";
const num = (v: PyValue | undefined, fallback: number) =>
  typeof v === "number" ? v : v instanceof PyFloat ? v.value : fallback;

function check(value: PyValue, raw: PyDict, path: string, errors: string[], binPath: string): void {
  const node = resolve(raw);
  const type = node.get("type");
  if (type !== undefined) {
    const names = (Array.isArray(type) ? type : [type]).map(String);
    if (!names.some((n) => typeOk(value, n))) {
      errors.push(`${where(path)}: expected ${names.join(" or ")}, got ${gotName(value)}`);
      return;
    }
  }
  const enumValues = node.get("enum");
  if (Array.isArray(enumValues) && !enumValues.some((e) => pyEq(e, value))) {
    const allowed = enumValues.map((v) => (v === null ? "null" : String(v))).join(", ");
    errors.push(`${where(path)}: ${pyRepr(value)} is not one of: ${allowed}`);
    return;
  }
  if (typeof value === "string") {
    if (pyLen(value) < num(node.get("minLength"), 0))
      errors.push(`${where(path)}: must not be empty`);
    const pattern = node.get("pattern");
    if (typeof pattern === "string" && !pyPattern(pattern).test(value)) {
      errors.push(`${where(path)}: ${pyRepr(value)} does not match ${pattern}`);
    }
    if (node.get("format") === "regex") {
      const compiled = pyRegexError(value);
      if (compiled !== null) {
        errors.push(`${where(path)}: ${pyRepr(value)} is not a valid regex (${compiled})`);
      } else {
        const why = portableRegexProblem(value, binPath);
        if (why) {
          errors.push(
            `${where(path)}: ${pyRepr(value)} is not a regex Python and bash read the same: ${why}`,
          );
        }
      }
    }
  }
  if (isInt(value)) {
    const min = node.get("minimum");
    const max = node.get("maximum");
    if (min !== undefined && value < numeric(min as number)) {
      errors.push(`${where(path)}: ${value} is below ${pyRepr(min)}`);
    }
    if (max !== undefined && value > numeric(max as number)) {
      errors.push(`${where(path)}: ${value} is above ${pyRepr(max)}`);
    }
  }
  if (isDict(value)) {
    const minProps = num(node.get("minProperties"), 0);
    if (value.size < minProps) errors.push(`${where(path)}: needs at least ${minProps} key(s)`);
    const propsNode = node.get("properties");
    const props = isDict(propsNode) ? propsNode : new PyDict();
    const required = node.get("required");
    for (const key of Array.isArray(required) ? required : []) {
      if (!value.has(String(key)))
        errors.push(`${where(path)}: missing required key ${pyRepr(key)}`);
    }
    const unknown = value.keys().filter((k) => !props.has(k));
    const extra = node.get("additionalProperties");
    if (unknown.length > 0 && extra === false) {
      const names = unknown.map((k) => pyRepr(k)).join(", ");
      errors.push(
        `${where(path)}: unknown key ${names} (allowed: ${props.keys().join(", ") || "none"})`,
      );
    }
    const names = node.get("propertyNames");
    for (const [key, sub] of value.entries()) {
      const child = path ? `${path}.${key}` : key;
      if (isDict(names)) check(key, names, child, errors, binPath);
      const prop = props.get(key);
      if (prop !== undefined) check(sub, prop as PyDict, child, errors, binPath);
      else if (isDict(extra)) check(sub, extra, child, errors, binPath);
    }
  }
  if (Array.isArray(value)) {
    const minItems = num(node.get("minItems"), 0);
    if (value.length < minItems) errors.push(`${where(path)}: needs at least ${minItems} item(s)`);
    const items = node.get("items");
    if (isDict(items))
      value.forEach((item, i) => check(item, items, `${path}[${i}]`, errors, binPath));
  }
}

/** Every problem with DATA: the retired keys, settings and contracts first, then the schema's. */
function validate(data: PyValue, binPath: string): string[] {
  const errors: string[] = [];
  let checked = data;
  if (isDict(data)) {
    for (const [key, why] of RETIRED_KEYS) if (data.has(key)) errors.push(`${key}: ${why}`);
    const top = new PyDict(data.entries().filter(([k]) => !RETIRED_KEYS.some(([r]) => r === k)));
    const contracts = top.get("contracts");
    if (isDict(contracts)) {
      const copy = new PyDict(
        contracts.entries().map(([k, v]) => [k, isDict(v) ? new PyDict(v.entries()) : v] as const),
      );
      for (const [contract, key, why] of RETIRED_SETTINGS) {
        const body = copy.get(contract);
        if (isDict(body) && body.has(key)) {
          errors.push(`contracts.${contract}.${key}: ${why}`);
          body.map.delete(key);
        }
      }
      for (const [contract, why] of RETIRED_CONTRACTS) {
        if (copy.has(contract)) {
          errors.push(`contracts.${contract}: ${why}`);
          copy.map.delete(contract);
        }
      }
      top.map.set("contracts", copy);
    }
    checked = top;
  }
  check(checked, SCHEMA, "", errors, binPath);
  return errors;
}

export interface OriginalDeclaration {
  readonly data: PyDict | null;
  readonly errors: ReadonlyArray<string>;
}

/** The working tree's playbook.json, read as the original's pb_declaration.load reads it. */
export function loadOriginalDeclaration(root: string, env: NodeJS.ProcessEnv): OriginalDeclaration {
  const path = NodePath.join(root, DECLARATION);
  let bytes: Buffer;
  try {
    if (!NodeFS.statSync(path).isFile())
      return { data: null, errors: [`${DECLARATION} is missing`] };
  } catch {
    return { data: null, errors: [`${DECLARATION} is missing`] };
  }
  try {
    bytes = NodeFS.readFileSync(path);
  } catch (cause) {
    // Python's OSError text for the read the original's open() refuses.
    const why =
      (cause as NodeJS.ErrnoException).code === "EACCES"
        ? "[Errno 13] Permission denied"
        : String(cause);
    return { data: null, errors: [`${DECLARATION} is not valid JSON: ${why}: ${pyRepr(path)}`] };
  }
  let data: PyValue;
  try {
    data = pyJsonLoads(pyReadText(bytes), true);
  } catch (cause) {
    if (!isPyJsonError(cause)) throw cause;
    return { data: null, errors: [`${DECLARATION} is not valid JSON: ${cause.message}`] };
  }
  return { data: isDict(data) ? data : null, errors: validate(data, env.PATH ?? "") };
}

/** A base commit's playbook.json, as the original's parse_text(base=True) yields its data. */
export function parseBaseDeclaration(text: string): PyDict | null {
  try {
    const data = pyJsonLoads(text, true);
    return isDict(data) ? data : null;
  } catch (cause) {
    if (isPyJsonError(cause)) return null;
    throw cause;
  }
}
