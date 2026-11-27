/**
 * rustSource.mjs: Just enough of Rust's lexical structure to read axum routers.
 *
 * stripRust blanks comments and #[cfg(test)] modules (same length, so offsets
 * hold) and keeps string literals; the other helpers walk the result with
 * strings skipped, so a "{" or ")" inside a path literal never counts.
 */

const OPEN = { "(": ")", "{": "}", "[": "]" };

/** Index just past the string or char literal starting at i, or -1 when none starts there. */
function literalEnd(s, i) {
  const raw = /^b?r(#*)"/.exec(s.slice(i, i + 12));
  if (raw && (i === 0 || !/[\w]/.test(s[i - 1]))) {
    const close = `"${raw[1]}`;
    const end = s.indexOf(close, i + raw[0].length);
    return end < 0 ? s.length : end + close.length;
  }
  if (s[i] === '"' || (s[i] === "b" && s[i + 1] === '"' && (i === 0 || !/\w/.test(s[i - 1])))) {
    let j = s[i] === "b" ? i + 2 : i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (s[i] === "'") {
    // A char literal ('a', '\n', '\u{1F600}'); otherwise a lifetime ('a).
    const m = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/.exec(s.slice(i, i + 12));
    if (m) return i + m[0].length;
  }
  return -1;
}

export function stripRust(content) {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const end = literalEnd(content, i);
    if (end > 0) {
      out += content.slice(i, end);
      i = end;
    } else if (content.startsWith("//", i)) {
      const nl = content.indexOf("\n", i);
      const stop = nl < 0 ? content.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (content.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      do {
        if (content.startsWith("/*", j)) { depth++; j += 2; } else if (content.startsWith("*/", j)) { depth--; j += 2; } else j++;
      } while (depth > 0 && j < content.length);
      out += content.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else {
      out += content[i++];
    }
  }
  return blankTestModules(out);
}

function blankTestModules(s) {
  const re = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\][\s\S]{0,200}?\bmod\s+\w+\s*\{/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const open = m.index + m[0].length - 1;
    const close = matching(s, open);
    if (close < 0) break;
    s = s.slice(0, m.index) + s.slice(m.index, close + 1).replace(/[^\n]/g, " ") + s.slice(close + 1);
    re.lastIndex = close + 1;
  }
  return s;
}

/** Index of the bracket closing the one at `open`, or -1. */
function matching(s, open) {
  const stack = [OPEN[s[open]]];
  for (let i = open + 1; i < s.length; i++) {
    const end = literalEnd(s, i);
    if (end > 0) { i = end - 1; continue; }
    if (OPEN[s[i]]) stack.push(OPEN[s[i]]);
    else if (s[i] === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The arguments inside the parentheses at `open`, split at top-level commas. */
export function splitArgs(s, open) {
  const close = matching(s, open);
  if (close < 0) return { args: [], end: s.length };
  const args = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const end = literalEnd(s, i);
    if (end > 0) { i = end - 1; continue; }
    if (OPEN[s[i]] || (s[i] === "<" && /\w$/.test(s.slice(start, i)))) {
      const inner = s[i] === "<" ? angleEnd(s, i) : matching(s, i);
      if (inner > 0) i = inner;
    } else if (s[i] === ",") {
      args.push({ text: s.slice(start, i).trim(), at: start });
      start = i + 1;
    }
  }
  const last = s.slice(start, close).trim();
  if (last) args.push({ text: last, at: start });
  return { args, end: close + 1 };
}

function angleEnd(s, open) {
  let depth = 0;
  for (let i = open; i < s.length && i < open + 400; i++) {
    if (s[i] === "<") depth++;
    else if (s[i] === ">" && s[i - 1] !== "-" && s[i - 1] !== "=") {
      depth--;
      if (depth === 0) return i;
    } else if (s[i] === ";" || s[i] === "{") return -1;
  }
  return -1;
}

/** The text of a string literal argument, or null when the argument is not one. */
export function stringLiteral(text) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim()) || /^r#*"([\s\S]*?)"#*$/.exec(text.trim());
  return m ? m[1] : null;
}

/** Every `fn name(...) ... { body }`: name, the whole item's span, and its body's span. */
export function functions(s) {
  const out = [];
  const re = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^{};]*?>)?\s*\(/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const params = matching(s, m.index + m[0].length - 1);
    if (params < 0) continue;
    let i = params + 1;
    while (i < s.length && s[i] !== "{" && s[i] !== ";") {
      const end = literalEnd(s, i);
      i = end > 0 ? end : i + 1;
    }
    if (s[i] !== "{") continue;
    const close = matching(s, i);
    if (close < 0) continue;
    out.push({ name: m[1], start: m.index, bodyStart: i, end: close + 1 });
    re.lastIndex = i + 1;
  }
  return out;
}
