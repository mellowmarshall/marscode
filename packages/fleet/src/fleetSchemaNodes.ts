/**
 * A closed-object schema language for the fleet shape (devtools' pb_fleet_schema):
 * an unknown field is an error, open maps stay open, closed sets are enums.
 * `schemaErrors(schema, value)` gives one `path: message` line per problem.
 */

export interface SchemaNode {
  check(value: unknown, path: string, out: string[]): void;
}

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The Python type name devtools' messages use, so both report one shape the same way. */
export function typeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** Python's repr of a JSON scalar. */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return JSON.stringify(v);
}

function say(out: string[], path: string, msg: string): void {
  out.push(`${path || "(root)"}: ${msg}`);
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

export interface StrOptions {
  readonly min?: number;
  readonly regex?: string;
  readonly url?: boolean;
  readonly msg?: string;
}

class StrNode implements SchemaNode {
  readonly min: number;
  readonly regex: RegExp | null;
  readonly regexSource: string;
  readonly url: boolean;
  readonly msg: string | null;
  constructor(options: StrOptions) {
    this.min = options.min ?? 0;
    this.regexSource = options.regex ?? "";
    this.regex = options.regex ? new RegExp(options.regex) : null;
    this.url = options.url ?? false;
    this.msg = options.msg ?? null;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (typeof v !== "string") return say(out, path, `expected string, got ${typeName(v)}`);
    if (Array.from(v).length < this.min)
      say(out, path, `too short (at least ${this.min} characters)`);
    if (this.regex && !this.regex.test(v)) {
      say(out, path, this.msg ?? `does not match ${this.regexSource}`);
    }
    if (this.url && !URL.canParse(v)) say(out, path, "expected a URL");
  }
}

class IntNode implements SchemaNode {
  readonly min: number | null;
  constructor(min: number | null) {
    this.min = min;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (typeof v !== "number" || !Number.isInteger(v)) return say(out, path, "expected an integer");
    if (this.min !== null && v < this.min) say(out, path, `must be at least ${this.min}`);
  }
}

class BoolNode implements SchemaNode {
  check(v: unknown, path: string, out: string[]): void {
    if (typeof v !== "boolean") say(out, path, "expected a boolean");
  }
}

class EnumNode implements SchemaNode {
  readonly values: ReadonlyArray<string>;
  constructor(values: ReadonlyArray<string>) {
    this.values = values;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (typeof v !== "string" || !this.values.includes(v)) {
      say(out, path, `${pyRepr(v)} is not one of: ${this.values.join(", ")}`);
    }
  }
}

class ArrNode implements SchemaNode {
  readonly item: SchemaNode;
  readonly min: number;
  constructor(item: SchemaNode, min: number) {
    this.item = item;
    this.min = min;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (!Array.isArray(v)) return say(out, path, "expected an array");
    if (v.length < this.min) say(out, path, `needs at least ${this.min} item(s)`);
    v.forEach((x, i) => this.item.check(x, join(path, i), out));
  }
}

class RecNode implements SchemaNode {
  readonly value: SchemaNode;
  readonly key: RegExp | null;
  readonly keySource: string;
  readonly msg: string | null;
  constructor(value: SchemaNode, key: string | null, msg: string | null) {
    this.value = value;
    this.key = key ? new RegExp(key) : null;
    this.keySource = key ?? "";
    this.msg = msg;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (!isObject(v)) return say(out, path, "expected an object");
    for (const [k, x] of Object.entries(v)) {
      const where = join(path, k);
      if (this.key && !this.key.test(k))
        say(out, where, this.msg ?? `key does not match ${this.keySource}`);
      this.value.check(x, where, out);
    }
  }
}

/** An optional field of an Obj. */
export class Opt {
  readonly node: SchemaNode;
  constructor(node: SchemaNode) {
    this.node = node;
  }
}

class NullableNode implements SchemaNode {
  readonly node: SchemaNode;
  constructor(node: SchemaNode) {
    this.node = node;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (v !== null) this.node.check(v, path, out);
  }
}

export type Fields = Readonly<Record<string, SchemaNode | Opt>>;
export type Refinement = (value: JsonObject) => string | null;

class ObjNode implements SchemaNode {
  readonly fields: Fields;
  readonly catchall: SchemaNode | null;
  readonly refine: ReadonlyArray<Refinement>;
  constructor(fields: Fields, catchall: SchemaNode | null, refine: ReadonlyArray<Refinement>) {
    this.fields = fields;
    this.catchall = catchall;
    this.refine = refine;
  }
  check(v: unknown, path: string, out: string[]): void {
    if (!isObject(v)) return say(out, path, "expected an object");
    const before = out.length;
    const unknown = Object.keys(v).filter((k) => !Object.hasOwn(this.fields, k));
    if (unknown.length > 0 && this.catchall === null) {
      say(out, path, `unrecognized key(s) [${unknown.join(", ")}]`);
    }
    for (const [k, spec] of Object.entries(this.fields)) {
      const where = join(path, k);
      if (!Object.hasOwn(v, k)) {
        if (!(spec instanceof Opt)) say(out, where, "required");
        continue;
      }
      (spec instanceof Opt ? spec.node : spec).check(v[k], where, out);
    }
    if (this.catchall !== null) {
      for (const k of unknown) this.catchall.check(v[k], join(path, k), out);
    }
    // As zod: a refinement runs on an object that parsed.
    if (before === out.length) {
      for (const fn of this.refine) {
        const msg = fn(v);
        if (msg) say(out, path, msg);
      }
    }
  }
}

class UnionNode implements SchemaNode {
  readonly options: ReadonlyArray<SchemaNode>;
  constructor(options: ReadonlyArray<SchemaNode>) {
    this.options = options;
  }
  check(v: unknown, path: string, out: string[]): void {
    const tries: string[][] = [];
    for (const option of this.options) {
      const errs: string[] = [];
      option.check(v, path, errs);
      if (errs.length === 0) return;
      tries.push(errs);
    }
    say(
      out,
      path,
      `matches none of the allowed shapes: ${tries.map((t) => t.slice(0, 2).join("; ")).join(" | ")}`,
    );
  }
}

/** Any JSON value: a vendor's own record kept whole, judged by its adapter. */
class JsonNode implements SchemaNode {
  check(v: unknown, path: string, out: string[]): void {
    const ok = v === null || ["object", "string", "number", "boolean"].includes(typeof v);
    if (!ok) say(out, path, `expected JSON, got ${typeName(v)}`);
  }
}

export const Str = (options: StrOptions = {}): SchemaNode => new StrNode(options);
export const Int = (min: number | null = null): SchemaNode => new IntNode(min);
export const Bool = (): SchemaNode => new BoolNode();
export const Enum = (...values: string[]): SchemaNode => new EnumNode(values);
export const Arr = (item: SchemaNode, min = 0): SchemaNode => new ArrNode(item, min);
export const Rec = (
  value: SchemaNode,
  key: string | null = null,
  msg: string | null = null,
): SchemaNode => new RecNode(value, key, msg);
export const optional = (node: SchemaNode): Opt => new Opt(node);
export const Nullable = (node: SchemaNode): SchemaNode => new NullableNode(node);
export const Obj = (
  fields: Fields,
  catchall: SchemaNode | null = null,
  refine: ReadonlyArray<Refinement> = [],
): SchemaNode => new ObjNode(fields, catchall, refine);
export const Union = (...options: SchemaNode[]): SchemaNode => new UnionNode(options);
export const Json = (): SchemaNode => new JsonNode();

/** One line per problem, `path: message`. */
export function schemaErrors(schema: SchemaNode, value: unknown): string[] {
  const out: string[] = [];
  schema.check(value, "", out);
  return out;
}
