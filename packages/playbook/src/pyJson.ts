/**
 * Python's json.loads (its C scanner), for the ported `actions` command: the same
 * values (NaN and Infinity read, floats kept apart from ints, keys in file order)
 * and the same error text ("Expecting ',' delimiter: line 3 column 5 (char 41)"),
 * so a refusal reads byte for byte as the original's.
 */
import * as Schema from "effect/Schema";

import { PyDict, PyFloat, pyRepr, type PyValue } from "./pyValues.ts";

/** A json.JSONDecodeError or the original's DuplicateKey (also a UnicodeDecodeError): its str() is the message. */
export class PyJsonError extends Schema.TaggedError<PyJsonError>()("PyJsonError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const isPyJsonError = Schema.is(PyJsonError);

class StopIteration {
  readonly idx: number;
  constructor(idx: number) {
    this.idx = idx;
  }
}

const WS = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

function decodeError(msg: string, doc: string, pos: number): PyJsonError {
  const before = doc.slice(0, pos);
  const cpPos = [...before].length;
  const lineno = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const colno = lastNl < 0 ? cpPos + 1 : cpPos - Array.from(doc.slice(0, lastNl)).length;
  return new PyJsonError({ detail: `${msg}: line ${lineno} column ${colno} (char ${cpPos})` });
}

interface Options {
  /** Refuse a key repeated in one object, as the original's declaration loader does. */
  readonly refuseDuplicates: boolean;
}

class Scanner {
  readonly s: string;
  readonly end: number;
  readonly opts: Options;
  constructor(s: string, opts: Options) {
    this.s = s;
    this.end = s.length - 1;
    this.opts = opts;
  }

  ws(idx: number): number {
    while (idx <= this.end && WS.has(this.s[idx]!)) idx += 1;
    return idx;
  }

  scanOnce(idx: number): [PyValue, number] {
    const s = this.s;
    if (idx > this.end) throw new StopIteration(idx);
    const c = s[idx]!;
    if (c === '"') return this.scanString(idx + 1);
    if (c === "{") return this.parseObject(idx + 1);
    if (c === "[") return this.parseArray(idx + 1);
    if (c === "n" && s.startsWith("null", idx)) return [null, idx + 4];
    if (c === "t" && s.startsWith("true", idx)) return [true, idx + 4];
    if (c === "f" && s.startsWith("false", idx)) return [false, idx + 5];
    if (c === "N" && s.startsWith("NaN", idx)) return [new PyFloat(Number.NaN), idx + 3];
    if (c === "I" && s.startsWith("Infinity", idx)) {
      return [new PyFloat(Number.POSITIVE_INFINITY), idx + 8];
    }
    if (c === "-" && s.startsWith("-Infinity", idx)) {
      return [new PyFloat(Number.NEGATIVE_INFINITY), idx + 9];
    }
    return this.number(idx);
  }

  number(start: number): [PyValue, number] {
    const s = this.s;
    let idx = start;
    if (s[idx] === "-") {
      idx += 1;
      if (idx > this.end) throw new StopIteration(start);
    }
    if (s[idx]! >= "1" && s[idx]! <= "9") {
      idx += 1;
      while (idx <= this.end && isDigit(s[idx])) idx += 1;
    } else if (s[idx] === "0") {
      idx += 1;
    } else {
      throw new StopIteration(start);
    }
    let isFloat = false;
    if (idx < this.end && s[idx] === "." && isDigit(s[idx + 1])) {
      isFloat = true;
      idx += 2;
      while (idx <= this.end && isDigit(s[idx])) idx += 1;
    }
    if (idx < this.end && (s[idx] === "e" || s[idx] === "E")) {
      const eStart = idx;
      idx += 1;
      if (idx < this.end && (s[idx] === "-" || s[idx] === "+")) idx += 1;
      while (idx <= this.end && isDigit(s[idx])) idx += 1;
      if (isDigit(s[idx - 1])) isFloat = true;
      else idx = eStart;
    }
    const text = s.slice(start, idx);
    if (isFloat) return [new PyFloat(Number(text)), idx];
    const n = Number(text);
    return [Number.isSafeInteger(n) ? n : BigInt(text), idx];
  }

  scanString(endStart: number): [string, number] {
    const s = this.s;
    const begin = endStart - 1;
    let end = endStart;
    let out = "";
    for (;;) {
      let next = end;
      let c = "";
      for (; next <= this.end; next += 1) {
        c = s[next]!;
        if (c === '"' || c === "\\") break;
        if (c.charCodeAt(0) <= 0x1f) throw decodeError("Invalid control character at", s, next);
      }
      if (next > this.end) throw decodeError("Unterminated string starting at", s, begin);
      out += s.slice(end, next);
      next += 1;
      if (c === '"') {
        end = next;
        break;
      }
      if (next > this.end) throw decodeError("Unterminated string starting at", s, begin);
      const esc = s[next]!;
      if (esc !== "u") {
        end = next + 1;
        const mapped = ESCAPES[esc];
        if (mapped === undefined) throw decodeError("Invalid \\escape", s, end - 2);
        out += mapped;
        continue;
      }
      next += 1;
      end = next + 4;
      if (end >= s.length) throw decodeError("Invalid \\uXXXX escape", s, next - 1);
      const hex = s.slice(next, end);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw decodeError("Invalid \\uXXXX escape", s, end - 5);
      let code = Number.parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff && end + 6 < s.length) {
        if (s[end] === "\\" && s[end + 1] === "u") {
          const hex2 = s.slice(end + 2, end + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex2)) {
            throw decodeError("Invalid \\uXXXX escape", s, end + 1);
          }
          const low = Number.parseInt(hex2, 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
            end += 6;
          }
        }
      }
      out += String.fromCodePoint(code);
    }
    return [out, end];
  }

  parseObject(start: number): [PyValue, number] {
    const s = this.s;
    const pairs: Array<[string, PyValue]> = [];
    let idx = this.ws(start);
    if (idx > this.end || s[idx] !== "}") {
      for (;;) {
        if (idx > this.end || s[idx] !== '"') {
          throw decodeError("Expecting property name enclosed in double quotes", s, idx);
        }
        const [key, afterKey] = this.scanString(idx + 1);
        idx = this.ws(afterKey);
        if (idx > this.end || s[idx] !== ":") throw decodeError("Expecting ':' delimiter", s, idx);
        idx = this.ws(idx + 1);
        const [val, afterVal] = this.scanOnce(idx);
        pairs.push([key, val]);
        idx = this.ws(afterVal);
        if (idx <= this.end && s[idx] === "}") break;
        if (idx > this.end || s[idx] !== ",") throw decodeError("Expecting ',' delimiter", s, idx);
        const comma = idx;
        idx = this.ws(idx + 1);
        if (idx <= this.end && s[idx] === "}") {
          throw decodeError("Illegal trailing comma before end of object", s, comma);
        }
      }
    }
    const dict = new PyDict();
    for (const [key, val] of pairs) {
      if (this.opts.refuseDuplicates && dict.has(key)) {
        throw new PyJsonError({ detail: `duplicate key ${pyRepr(key)}` });
      }
      dict.map.set(key, val);
    }
    return [dict, idx + 1];
  }

  parseArray(start: number): [PyValue, number] {
    const s = this.s;
    const out: PyValue[] = [];
    let idx = this.ws(start);
    if (idx <= this.end && s[idx] !== "]") {
      for (;;) {
        const [val, after] = this.scanOnce(idx);
        out.push(val);
        idx = this.ws(after);
        if (idx <= this.end && s[idx] === "]") break;
        if (idx > this.end || s[idx] !== ",") throw decodeError("Expecting ',' delimiter", s, idx);
        const comma = idx;
        idx = this.ws(idx + 1);
        if (idx <= this.end && s[idx] === "]") {
          throw decodeError("Illegal trailing comma before end of array", s, comma);
        }
      }
    }
    if (idx > this.end || s[idx] !== "]") throw new StopIteration(idx);
    return [out, idx + 1];
  }
}

/** Python's json.loads(TEXT); REFUSEDUPLICATES: the original's object_pairs_hook. */
export function pyJsonLoads(text: string, refuseDuplicates = false): PyValue {
  if (text.startsWith("\ufeff")) {
    throw decodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  }
  const scanner = new Scanner(text, { refuseDuplicates });
  let value: PyValue;
  let end: number;
  try {
    [value, end] = scanner.scanOnce(scanner.ws(0));
  } catch (cause) {
    if (cause instanceof StopIteration) throw decodeError("Expecting value", text, cause.idx);
    throw cause;
  }
  end = scanner.ws(end);
  if (end !== text.length) throw decodeError("Extra data", text, end);
  return value;
}

/** Python's UnicodeDecodeError text for the first bad UTF-8 sequence in BYTES, or null. */
function utf8Problem(bytes: Uint8Array): string | null {
  const hex = (b: number) => `0x${b.toString(16).padStart(2, "0")}`;
  const lead = "'utf-8' codec can't decode";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return `${lead} byte ${hex(b)} in position ${i}: invalid start byte`;
    for (let k = 1; k <= need; k += 1) {
      const c = bytes[i + k];
      if (c === undefined) {
        const last = bytes.length - 1;
        return last > i
          ? `${lead} bytes in position ${i}-${last}: unexpected end of data`
          : `${lead} byte ${hex(b)} in position ${i}: unexpected end of data`;
      }
      const min = k === 1 ? lo : 0x80;
      const max = k === 1 ? hi : 0xbf;
      if (c < min || c > max)
        return `${lead} byte ${hex(b)} in position ${i}: invalid continuation byte`;
    }
    i += need + 1;
  }
  return null;
}

/** Python's text-mode read: UTF-8 (strict, its UnicodeDecodeError text), universal newlines. */
export function pyReadText(bytes: Uint8Array): string {
  const problem = utf8Problem(bytes);
  if (problem !== null) throw new PyJsonError({ detail: problem });
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** Python's bytes.decode("utf-8", "replace"). */
export function pyDecodeReplace(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}
