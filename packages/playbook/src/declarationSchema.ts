/**
 * The closed-field validator for playbook.json (and other playbook files read
 * against a JSON Schema). It covers the subset of JSON Schema the shipped
 * schema uses; a keyword outside that subset throws, so the schema cannot ask
 * for a rule the validator silently skips.
 */
import * as Schema from "effect/Schema";
import { isRecord } from "./strictJson.ts";

type SchemaNode = Readonly<Record<string, unknown>>;

const KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "format",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
]);

export class SchemaKeywordError extends Schema.TaggedError<SchemaKeywordError>()(
  "SchemaKeywordError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Why VALUE does not read the same in JavaScript, Python and bash ERE, or null. */
export function portableRegexProblem(value: string): string | null {
  const escape = /\\([A-Za-z0-9])/.exec(value);
  if (escape) return `\\${escape[1]} is not an ERE escape (write a bracket class such as [0-9])`;
  if (value.includes("[:")) {
    return "[: (a POSIX class such as [[:alpha:]]) is ERE only; list the characters, [a-z]";
  }
  if (value.includes("(?")) return "(? groups (non-capturing, lookaround, flags) are not ERE";
  const lazy = /[*+?}][?+]/.exec(value);
  if (lazy) return `${lazy[0]} (a lazy or possessive quantifier) is not ERE`;
  try {
    RegExp(value);
  } catch (cause) {
    return `not a valid regex (${cause instanceof Error ? cause.message : String(cause)})`;
  }
  return null;
}

function resolveRef(node: SchemaNode, root: SchemaNode): SchemaNode {
  let current = node;
  while (typeof current.$ref === "string") {
    const ref = current.$ref;
    if (!ref.startsWith("#/"))
      throw new SchemaKeywordError({ detail: `only local $ref is supported: ${ref}` });
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      target = isRecord(target) ? target[part] : undefined;
    }
    if (!isRecord(target)) throw new SchemaKeywordError({ detail: `$ref ${ref} does not resolve` });
    current = target;
  }
  return current;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "object" ? "object" : typeof value;
}

function typeOk(value: unknown, names: ReadonlyArray<string>): boolean {
  const actual = typeName(value);
  return names.some((n) => n === actual || (n === "number" && actual === "integer"));
}

const where = (path: string) => path || "top level";

function show(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : JSON.stringify(value);
}

function check(
  value: unknown,
  rawNode: SchemaNode,
  root: SchemaNode,
  path: string,
  errors: string[],
): void {
  const node = resolveRef(rawNode, root);
  const unknown = Object.keys(node).filter((k) => !KEYWORDS.has(k));
  if (unknown.length > 0) {
    throw new SchemaKeywordError({
      detail: `schema keyword not implemented by the validator: ${unknown.toSorted().join(", ")}`,
    });
  }
  if (node.format !== undefined && node.format !== "regex") {
    throw new SchemaKeywordError({
      detail: `schema format not implemented: ${String(node.format)}`,
    });
  }
  if (node.type !== undefined) {
    const names = (Array.isArray(node.type) ? node.type : [node.type]).map(String);
    if (!typeOk(value, names)) {
      errors.push(`${where(path)}: expected ${names.join(" or ")}, got ${typeName(value)}`);
      return;
    }
  }
  if (Array.isArray(node.enum) && !node.enum.some((e) => e === value)) {
    const allowed = node.enum.map((v) => (v === null ? "null" : String(v))).join(", ");
    errors.push(`${where(path)}: ${show(value)} is not one of: ${allowed}`);
    return;
  }
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push(`${where(path)}: must not be empty`);
    }
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
      errors.push(`${where(path)}: ${show(value)} does not match ${node.pattern}`);
    }
    if (node.format === "regex") {
      const why = portableRegexProblem(value);
      if (why) errors.push(`${where(path)}: ${show(value)} is not a portable regex: ${why}`);
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push(`${where(path)}: ${value} is below ${node.minimum}`);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push(`${where(path)}: ${value} is above ${node.maximum}`);
    }
  }
  if (isRecord(value)) {
    const props = isRecord(node.properties) ? node.properties : {};
    for (const key of Array.isArray(node.required) ? node.required : []) {
      if (!(String(key) in value)) errors.push(`${where(path)}: missing required key '${key}'`);
    }
    const extra = node.additionalProperties;
    const unknownKeys = Object.keys(value).filter((k) => !(k in props));
    if (unknownKeys.length > 0 && extra === false) {
      const allowed = Object.keys(props).join(", ") || "none";
      errors.push(
        `${where(path)}: unknown key ${unknownKeys.map((k) => `'${k}'`).join(", ")} (allowed: ${allowed})`,
      );
    }
    for (const [key, sub] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isRecord(node.propertyNames)) check(key, node.propertyNames, root, childPath, errors);
      const prop = props[key];
      if (isRecord(prop)) check(sub, prop, root, childPath, errors);
      else if (!(key in props) && isRecord(extra)) check(sub, extra, root, childPath, errors);
    }
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push(`${where(path)}: needs at least ${node.minItems} item(s)`);
    }
    if (isRecord(node.items)) {
      const items = node.items;
      value.forEach((item, i) => check(item, items, root, `${path}[${i}]`, errors));
    }
  }
}

/** DATA against SCHEMA; every problem named by its path. */
export function validateAgainstSchema(data: unknown, schema: SchemaNode): ReadonlyArray<string> {
  const errors: string[] = [];
  check(data, schema, schema, "", errors);
  return errors;
}
