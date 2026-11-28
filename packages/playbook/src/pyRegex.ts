/**
 * Python's `re`, as far as the ported `actions` command reads regexes: a pattern of the
 * original's schema searched with Python's meaning (`$` also before a final newline,
 * `.` stops only at a newline, `\S` by Python's whitespace), and the error text
 * re.compile gives for a regex it cannot compile (its parser's checks, in its order).
 */
import {
  AT,
  checkLookbehindGroup,
  DIGITS,
  escapeCode,
  FLAGS,
  isIdentifier,
  ONE,
  parseClass,
  parseFlags,
  refItem,
  ReError,
  Source,
  SPECIAL,
  type Item,
  type State,
} from "./pyRegexSource.ts";
import { pyRepr } from "./pyValues.ts";

const PY_SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** A JS RegExp (u flag) that matches as Python's re.search(PATTERN) does. */
export function pyPattern(pattern: string): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "\\") {
      const e = pattern[i + 1] ?? "";
      i += 1;
      if (e === "S" && !inClass) out += `[^${PY_SPACE_CLASS}]`;
      else if (e === "s") out += inClass ? PY_SPACE_CLASS : `[${PY_SPACE_CLASS}]`;
      else if (/[A-Za-z0-9]/.test(e)) {
        throw new Error(`pyPattern: the escape \\${e} has no translation`);
      } else out += `\\${e}`;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (pattern[i + 1] === "^") {
        out += "^";
        i += 1;
      }
      if (pattern[i + 1] === "]") {
        out += "\\]";
        i += 1;
      }
      continue;
    }
    if (c === ".") out += "[^\\n]";
    else if (c === "$") out += "(?=\\n?$)";
    else out += c;
  }
  return new RegExp(out, "u");
}

/** Alternatives: each a sequence; the width spans them all. */
function parseSub(src: Source, state: State, nested: number): readonly [number, number] {
  let first = true;
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (;;) {
    const w = width(parseSeq(src, state, nested + 1, nested === 0 && first));
    lo = Math.min(lo, w[0]);
    hi = Math.max(hi, w[1]);
    first = false;
    if (!src.match("|")) return [lo, hi];
  }
}

const width = (seq: ReadonlyArray<Item>): readonly [number, number] => [
  seq.reduce((n, i) => n + i.lo, 0),
  seq.reduce((n, i) => n + i.hi, 0),
];
const times = (n: number, k: number) => (n === 0 ? 0 : n * k);

function parseSeq(src: Source, state: State, nested: number, first: boolean): Item[] {
  const seq: Item[] = [];
  for (;;) {
    const t = src.next;
    if (t === null || t === "|" || t === ")") return seq;
    src.get();
    if (t.length === 2) {
      seq.push(escapeCode(src, t, state, false));
    } else if (!SPECIAL.includes(t)) {
      seq.push(ONE);
    } else if (t === "[") {
      parseClass(src, state);
      seq.push(ONE);
    } else if ("*+?{".includes(t)) {
      const here = src.tell();
      let min = t === "+" ? 1 : 0;
      let max = t === "?" ? 1 : Number.POSITIVE_INFINITY;
      if (t === "{") {
        if (src.next === "}") {
          seq.push(ONE);
          continue;
        }
        const lo = src.getwhile(Number.MAX_SAFE_INTEGER, DIGITS);
        const hi = src.match(",") ? src.getwhile(Number.MAX_SAFE_INTEGER, DIGITS) : lo;
        if (!src.match("}")) {
          seq.push(ONE);
          src.seek(here);
          continue;
        }
        if (lo && hi && Number(hi) < Number(lo)) {
          throw src.error("min repeat greater than max repeat", src.tell() - here);
        }
        min = lo ? Number(lo) : 0;
        max = hi ? Number(hi) : Number.POSITIVE_INFINITY;
      }
      const item = seq.at(-1);
      if (item === undefined || item.kind === "at")
        throw src.error("nothing to repeat", src.tell() - here + 1);
      if (item.kind === "repeat") throw src.error("multiple repeat", src.tell() - here + 1);
      if (!src.match("?")) src.match("+");
      seq[seq.length - 1] = { kind: "repeat", lo: times(item.lo, min), hi: times(item.hi, max) };
    } else if (t === ".") {
      seq.push(ONE);
    } else if (t === "^" || t === "$") {
      seq.push(AT);
    } else if (t === "(") {
      const start = src.tell() - 1;
      let capture = true;
      let name: string | null = null;
      if (src.match("?")) {
        const ch = src.get();
        if (ch === null) throw src.error("unexpected end of pattern");
        if (ch === "P") {
          if (src.match("<")) {
            name = src.getuntil(">", "group name");
            if (!isIdentifier(name)) {
              throw src.error(`bad character in group name ${pyRepr(name)}`, [...name].length + 1);
            }
          } else if (src.match("=")) {
            const ref = src.getuntil(")", "group name");
            if (!isIdentifier(ref)) {
              throw src.error(`bad character in group name ${pyRepr(ref)}`, [...ref].length + 1);
            }
            const gid = state.names.get(ref);
            if (gid === undefined)
              throw src.error(`unknown group name ${pyRepr(ref)}`, [...ref].length + 1);
            if (state.open.has(gid))
              throw src.error("cannot refer to an open group", [...ref].length + 1);
            checkLookbehindGroup(src, state, gid);
            seq.push(refItem(state, gid));
            continue;
          } else {
            const nx = src.get();
            if (nx === null) throw src.error("unexpected end of pattern");
            throw src.error(`unknown extension ?P${nx}`, [...nx].length + 2);
          }
        } else if (ch === "(") {
          const cond = src.getuntil(")", "group name");
          const span = [...cond].length + 1;
          let gid: number;
          if (/^[0-9]+$/.test(cond)) {
            gid = Number(cond);
            if (gid === 0) throw src.error("bad group number", span);
            if (!state.refs.has(gid)) state.refs.set(gid, src.tell() - span);
          } else {
            if (!isIdentifier(cond))
              throw src.error(`bad character in group name ${pyRepr(cond)}`, span);
            const named = state.names.get(cond);
            if (named === undefined) throw src.error(`unknown group name ${pyRepr(cond)}`, span);
            gid = named;
          }
          checkLookbehindGroup(src, state, gid);
          const yes = width(parseSeq(src, state, nested + 1, false));
          let no: readonly [number, number] | null = null;
          if (src.match("|")) {
            no = width(parseSeq(src, state, nested + 1, false));
            if (src.next === "|")
              throw src.error("conditional backref with more than two branches");
          }
          if (!src.match(")"))
            throw src.error("missing ), unterminated subpattern", src.tell() - start);
          seq.push(
            no === null
              ? { kind: "other", lo: 0, hi: yes[1] }
              : { kind: "other", lo: Math.min(yes[0], no[0]), hi: Math.max(yes[1], no[1]) },
          );
          continue;
        } else if (ch === ":" || ch === ">") {
          capture = false;
        } else if (ch === "#") {
          for (;;) {
            if (src.next === null)
              throw src.error("missing ), unterminated comment", src.tell() - start);
            if (src.get() === ")") break;
          }
          continue;
        } else if ("=!<".includes(ch)) {
          let behind = false;
          if (ch === "<") {
            const nx = src.get();
            if (nx === null) throw src.error("unexpected end of pattern");
            if (!"=!".includes(nx))
              throw src.error(`unknown extension ?<${nx}`, [...nx].length + 2);
            behind = true;
          }
          const outer = behind && state.lookbehind === null;
          if (outer) state.lookbehind = state.groups;
          const [lo, hi] = parseSub(src, state, nested + 1);
          if (outer) state.lookbehind = null;
          if (behind && lo !== hi) state.variableLookbehind = true;
          if (!src.match(")"))
            throw src.error("missing ), unterminated subpattern", src.tell() - start);
          seq.push({ kind: "group", lo: 0, hi: 0 });
          continue;
        } else if (FLAGS.includes(ch) || ch === "L" || ch === "-") {
          if (parseFlags(src, ch) === "global") {
            if (!first || seq.length > 0) {
              throw src.error(
                "global flags not at the start of the expression",
                src.tell() - start,
              );
            }
            continue;
          }
          capture = false;
        } else {
          throw src.error(`unknown extension ?${ch}`, [...ch].length + 1);
        }
      }
      let group: number | null = null;
      if (capture) {
        group = state.groups;
        state.groups += 1;
        if (name !== null) {
          const was = state.names.get(name);
          if (was !== undefined) {
            throw src.error(
              `redefinition of group name ${pyRepr(name)} as group ${group}; was group ${was}`,
              [...name].length + 1,
            );
          }
          state.names.set(name, group);
        }
        state.open.add(group);
      }
      const [lo, hi] = parseSub(src, state, nested + 1);
      if (!src.match(")"))
        throw src.error("missing ), unterminated subpattern", src.tell() - start);
      if (group !== null) {
        state.open.delete(group);
        state.widths.set(group, [lo, hi]);
      }
      seq.push({ kind: "group", lo, hi });
    }
  }
}

/** Python's re.error text (`msg at position N`) for PATTERN, or null when re.compile takes it. */
export function pyRegexError(pattern: string): string | null {
  try {
    const src = new Source(pattern);
    const state: State = {
      groups: 1,
      refs: new Map(),
      names: new Map(),
      open: new Set(),
      widths: new Map(),
      lookbehind: null,
      variableLookbehind: false,
    };
    parseSub(src, state, 0);
    if (src.next !== null) throw src.error("unbalanced parenthesis");
    for (const [gid, pos] of state.refs) {
      if (gid >= state.groups) throw new ReError(`invalid group reference ${gid}`, pos);
    }
    // re.compile's own check, after the parse, with no position.
    if (state.variableLookbehind) return "look-behind requires fixed-width pattern";
    return null;
  } catch (cause) {
    if (cause instanceof ReError) return `${cause.msg} at position ${cause.pos}`;
    throw cause;
  }
}
