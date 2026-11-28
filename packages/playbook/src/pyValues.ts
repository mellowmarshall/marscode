/**
 * JSON values as the original (Python) playbook holds them, so the ported `actions`
 * command compares, sorts and prints them the same way: an object keeps its keys in
 * file order (PyDict), a float stays apart from an int (PyFloat), an int too large
 * for a double stays exact (bigint), and repr, equality, strip and sort follow Python.
 */

/** A JSON object in file order, including keys that look like integers. */
export class PyDict {
  readonly map: Map<string, PyValue>;
  constructor(entries: Iterable<readonly [string, PyValue]> = []) {
    this.map = new Map(entries);
  }
  get(key: string): PyValue | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  entries(): Array<[string, PyValue]> {
    return [...this.map.entries()];
  }
  get size(): number {
    return this.map.size;
  }
}

/** A JSON number written with a fraction or an exponent: Python's float. */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type PyValue = null | boolean | number | bigint | string | PyFloat | PyValue[] | PyDict;

export const isDict = (v: unknown): v is PyDict => v instanceof PyDict;
/** Python's isinstance(v, int) and not isinstance(v, bool). */
export const isInt = (v: unknown): v is number | bigint =>
  typeof v === "bigint" || typeof v === "number";
/** Python's isinstance(v, (int, float)) and not isinstance(v, bool). */
export const isNumber = (v: unknown): boolean => isInt(v) || v instanceof PyFloat;

/** The number's value as a double (for an ordering against a bound). */
export function numeric(v: number | bigint | PyFloat): number | bigint {
  return v instanceof PyFloat ? v.value : v;
}

/** Python's truthiness of a JSON value. */
export function pyTruthy(v: PyValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (v instanceof PyFloat) return v.value !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyDict) return v.size > 0;
  return true;
}

/** Python's == for JSON values (True == 1 == 1.0; NaN equals nothing). */
export function pyEq(a: PyValue | undefined, b: PyValue | undefined): boolean {
  const num = (v: PyValue | undefined): number | bigint | null =>
    typeof v === "boolean"
      ? Number(v)
      : typeof v === "number" || typeof v === "bigint"
        ? v
        : v instanceof PyFloat
          ? v.value
          : null;
  const na = num(a);
  const nb = num(b);
  if (na !== null || nb !== null) {
    if (na === null || nb === null) return false;
    // Loose equality compares a bigint and a double exactly.
    return na == nb;
  }
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEq(x, b[i]));
  }
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.size !== b.size) return false;
    return a.entries().every(([k, v]) => b.has(k) && pyEq(v, b.get(k)));
  }
  return false;
}

/** Python's str.isspace() characters: what str.strip() removes. */
const PY_SPACE =
  "\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

const isPySpace = (ch: string): boolean => ch.length === 1 && PY_SPACE.includes(ch);

/** Python's str.strip(). */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isPySpace(s[start]!)) start += 1;
  while (end > start && isPySpace(s[end - 1]!)) end -= 1;
  return s.slice(start, end);
}

/** Python's str.splitlines(): every line boundary Python knows. */
export function pySplitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\u000b\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
  if (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

/** Python's ordering of two strings: by code point (JS compares UTF-16 units). */
function pyCmp(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Python's sorted() of strings. */
export function pySorted(items: Iterable<string>): string[] {
  return [...items].toSorted(pyCmp);
}

/** Python's len() of a string: code points. */
export const pyLen = (s: string): number => [...s].length;

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, "0")}`;
      else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/** Python's repr() of a float. */
function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, expText] = x.toExponential().split("e") as [string, string];
  const exp = Number(expText);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  const sign = neg ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
  const frac = digits.slice(exp + 1);
  return `${sign}${intPart}.${frac || "0"}`;
}

/** Python's repr() of a JSON value. */
export function pyRepr(v: PyValue): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof PyFloat) return floatRepr(v.value);
  if (typeof v === "string") return strRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${v
    .entries()
    .map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`)
    .join(", ")}}`;
}

/**
 * A text equal for two values exactly when Python's
 * json.dumps(v, sort_keys=True, separators=(",", ":")) is (an int and a float differ).
 */
export function pyCanon(v: PyValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof PyFloat) return `f${floatRepr(v.value)}`;
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyCanon).join(",")}]`;
  const keys = pySorted(v.keys());
  return `{${keys.map((k) => `${JSON.stringify(k)}:${pyCanon(v.get(k)!)}`).join(",")}}`;
}

/** A plain JSON value (an imported schema) as a PyValue. */
export function fromPlain(v: unknown): PyValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? v : new PyFloat(v);
  if (Array.isArray(v)) return v.map(fromPlain);
  if (typeof v === "object") {
    return new PyDict(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fromPlain(x)]),
    );
  }
  throw new TypeError(`not a JSON value: ${typeof v}`);
}
