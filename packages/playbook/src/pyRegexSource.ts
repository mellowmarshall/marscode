/**
 * Python's regex parser (sre) pieces for pyRegex.ts: its tokenizer over code points, its
 * escapes, character sets and inline flags, each refusal worded and placed as re.error is.
 */
import { pyRepr } from "./pyValues.ts";

export class ReError {
  readonly msg: string;
  readonly pos: number;
  constructor(msg: string, pos: number) {
    this.msg = msg;
    this.pos = pos;
  }
}

export const DIGITS = "0123456789";
const OCT = "01234567";
const HEX = "0123456789abcdefABCDEF";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SPECIAL = ".\\[{()*+?^$|";
// Python 3.14 reads \\z as \\Z.
const CATEGORY = "AbBdDsSwWZz";
const IN_CATEGORY = "dDsSwW";
const SIMPLE_ESCAPES = "afnrtv\\";
export const FLAGS = "imsxau";

/** sre's Tokenizer over code points: an escape is one two-character token. */
export class Source {
  readonly chars: string[];
  index = 0;
  next: string | null = null;
  constructor(pattern: string) {
    this.chars = [...pattern];
    this.advance();
  }
  private advance(): void {
    if (this.index >= this.chars.length) {
      this.next = null;
      return;
    }
    let ch = this.chars[this.index]!;
    if (ch === "\\") {
      const nxt = this.chars[this.index + 1];
      if (nxt === undefined)
        throw new ReError("bad escape (end of pattern)", this.chars.length - 1);
      ch += nxt;
    }
    this.index += ch.length === 2 && ch[0] === "\\" ? 2 : 1;
    this.next = ch;
  }
  match(c: string): boolean {
    if (this.next !== c) return false;
    this.advance();
    return true;
  }
  get(): string | null {
    const t = this.next;
    this.advance();
    return t;
  }
  getwhile(n: number, set: string): string {
    let out = "";
    for (let i = 0; i < n; i += 1) {
      const t = this.next;
      if (t === null || t.length !== 1 || !set.includes(t)) break;
      out += t;
      this.advance();
    }
    return out;
  }
  getuntil(term: string, name: string): string {
    let result = "";
    for (;;) {
      const c = this.next;
      this.advance();
      if (c === null) {
        if (!result) throw this.error(`missing ${name}`);
        throw this.error(`missing ${term}, unterminated name`, [...result].length);
      }
      if (c === term) {
        if (!result) throw this.error(`missing ${name}`, 1);
        return result;
      }
      result += c;
    }
  }
  tell(): number {
    return this.index - (this.next === null ? 0 : [...this.next].length);
  }
  seek(index: number): void {
    this.index = index;
    this.advance();
  }
  error(msg: string, offset = 0): ReError {
    return new ReError(msg, this.tell() - offset);
  }
}

/** What a parsed item is, for the repeat rules, and how many characters it matches. */
export interface Item {
  readonly kind: "lit" | "at" | "repeat" | "group" | "other";
  readonly lo: number;
  readonly hi: number;
}

export const ONE: Item = { kind: "lit", lo: 1, hi: 1 };
export const AT: Item = { kind: "at", lo: 0, hi: 0 };

export interface State {
  groups: number;
  /** A conditional's group number, and where it is named. */
  refs: Map<number, number>;
  names: Map<string, number>;
  open: Set<number>;
  /** Each closed group's width, for a reference to it. */
  widths: Map<number, readonly [number, number]>;
  /** The group count where the outermost look-behind began; null outside one. */
  lookbehind: number | null;
  /** A look-behind whose width is not fixed (re.compile refuses it after parsing). */
  variableLookbehind: boolean;
}

/** sre's checklookbehindgroup: a look-behind refers only to a closed group from before it. */
export function checkLookbehindGroup(src: Source, state: State, gid: number): void {
  if (state.lookbehind === null) return;
  if (!(gid < state.groups && !state.open.has(gid)))
    throw src.error("cannot refer to an open group");
  if (gid >= state.lookbehind) {
    throw src.error("cannot refer to group defined in the same lookbehind subpattern");
  }
}

/** The width of a reference to group GID. */
export function refItem(state: State, gid: number): Item {
  const [lo, hi] = state.widths.get(gid) ?? [0, 0];
  return { kind: "other", lo, hi };
}

export const isIdentifier = (s: string) =>
  /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(s);

export function escapeCode(src: Source, esc: string, state: State, inClass: boolean): Item {
  const c = esc[1]!;
  if (inClass) {
    if (SIMPLE_ESCAPES.includes(c) || c === "b" || IN_CATEGORY.includes(c)) return ONE;
  } else if (CATEGORY.includes(c)) return "AbBZz".includes(c) ? AT : ONE;
  else if (SIMPLE_ESCAPES.includes(c)) return ONE;
  const width = (want: number, set: string) => {
    const got = esc + src.getwhile(want, set);
    if (got.length !== want + 2) throw src.error(`incomplete escape ${got}`, got.length);
    return got;
  };
  if (c === "x") return (width(2, HEX), ONE);
  if (c === "u") return (width(4, HEX), ONE);
  if (c === "U") {
    const got = width(8, HEX);
    if (Number.parseInt(got.slice(2), 16) > 0x10ffff)
      throw src.error(`bad escape ${got}`, got.length);
    return ONE;
  }
  if (c === "N") {
    if (!src.match("{")) throw src.error("missing {");
    const name = src.getuntil("}", "character name");
    // No Unicode name table here: a name in a name's form (letters, digits, spaces, hyphens)
    // is taken as one Python knows, as a real name is; anything else is undefined, as in Python.
    if (!/^[A-Za-z][A-Za-z0-9 -]*$/.test(name)) {
      throw src.error(`undefined character name ${pyRepr(name)}`, [...name].length + 4);
    }
    return ONE;
  }
  if (inClass && OCT.includes(c)) {
    const got = esc + src.getwhile(2, OCT);
    if (Number.parseInt(got.slice(1), 8) > 0o377) {
      throw src.error(`octal escape value ${got} outside of range 0-0o377`, got.length);
    }
    return ONE;
  }
  if (!inClass && c === "0") return (src.getwhile(2, OCT), ONE);
  if (!inClass && DIGITS.includes(c)) {
    let got = esc;
    if (src.next !== null && DIGITS.includes(src.next)) {
      got += src.get();
      if (
        OCT.includes(got[1]!) &&
        OCT.includes(got[2]!) &&
        src.next !== null &&
        OCT.includes(src.next)
      ) {
        got += src.get();
        if (Number.parseInt(got.slice(1), 8) > 0o377) {
          throw src.error(`octal escape value ${got} outside of range 0-0o377`, got.length);
        }
        return ONE;
      }
    }
    const group = Number(got.slice(1));
    if (group < state.groups) {
      if (state.open.has(group)) throw src.error("cannot refer to an open group", got.length);
      checkLookbehindGroup(src, state, group);
      return refItem(state, group);
    }
    throw src.error(`invalid group reference ${group}`, got.length - 1);
  }
  if (!DIGITS.includes(c) && LETTERS.includes(c)) throw src.error(`bad escape ${esc}`, esc.length);
  if (DIGITS.includes(c)) throw src.error(`bad escape ${esc}`, esc.length);
  return ONE;
}

const SIMPLE_CODES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  "\\": 92,
};

/** A class member's escape: its code point, or null for a category (\\d, \\w, ...). */
function classEscape(src: Source, esc: string, state: State): number | null {
  const from = src.tell();
  escapeCode(src, esc, state, true);
  const digits = src.chars.slice(from, src.tell()).join("");
  const c = esc[1]!;
  if (IN_CATEGORY.includes(c)) return null;
  const simple = SIMPLE_CODES[c];
  if (simple !== undefined) return simple;
  if (c === "x" || c === "u" || c === "U") return Number.parseInt(digits, 16);
  if (OCT.includes(c)) return Number.parseInt(c + digits, 8);
  return c.codePointAt(0)!;
}

export function parseClass(src: Source, state: State): void {
  const here = src.tell() - 1;
  src.match("^");
  let first = true;
  for (;;) {
    const t = src.get();
    if (t === null) throw new ReError("unterminated character set", here);
    if (t === "]" && !first) return;
    first = false;
    const code1 = t.length === 2 ? classEscape(src, t, state) : t.codePointAt(0)!;
    if (!src.match("-")) continue;
    const that = src.get();
    if (that === null) throw new ReError("unterminated character set", here);
    if (that === "]") return;
    const code2 = that.length === 2 ? classEscape(src, that, state) : that.codePointAt(0)!;
    if (code1 === null || code2 === null || code1 > code2) {
      throw src.error(`bad character range ${t}-${that}`, [...t].length + 1 + [...that].length);
    }
  }
}

export function parseFlags(src: Source, first: string): "global" | "scoped" {
  const unknown = (ch: string, otherwise: string) =>
    src.error(/^\p{L}$/u.test(ch) ? "unknown flag" : otherwise, [...ch].length);
  const added = new Set<string>();
  const removed = new Set<string>();
  let ch: string | null = first;
  if (ch !== "-") {
    for (;;) {
      if (ch === "L") throw src.error("bad inline flags: cannot use 'L' flag with a str pattern");
      added.add(ch);
      if ((ch === "a" || ch === "u") && added.has("a") && added.has("u")) {
        throw src.error("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
      }
      ch = src.get();
      if (ch === null) throw src.error("missing -, : or )");
      if (")-:".includes(ch)) break;
      if (!FLAGS.includes(ch) && ch !== "L") throw unknown(ch, "missing -, : or )");
    }
  }
  if (ch === ")") return "global";
  if (ch === "-") {
    ch = src.get();
    if (ch === null) throw src.error("missing flag");
    if (!FLAGS.includes(ch) && ch !== "L") throw unknown(ch, "missing flag");
    for (;;) {
      if (ch === "a" || ch === "u" || ch === "L") {
        throw src.error("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
      }
      removed.add(ch);
      ch = src.get();
      if (ch === null) throw src.error("missing :");
      if (ch === ":") break;
      if (!FLAGS.includes(ch) && ch !== "L") throw unknown(ch, "missing :");
    }
  }
  if ([...added].some((f) => removed.has(f))) {
    throw src.error("bad inline flags: flag turned on and off", 1);
  }
  return "scoped";
}
