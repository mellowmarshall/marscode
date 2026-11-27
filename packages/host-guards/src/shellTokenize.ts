// @effect-diagnostics nodeBuiltinImport:off - Shell heredoc stripping, POSIX word tokenization, command substitution extraction, and wrapper unwrapping.
import * as NodePath from "node:path";

const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  builtin: new Set(),
  command: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  setsid: new Set(),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-h", "-p", "-r", "-t"]),
};

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s;
const HEREDOC_RE = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([^\s;&|<>()]+)|([A-Za-z_][A-Za-z0-9_-]*))/;

/**
 * Strips heredoc bodies from a shell command string so text inside heredocs
 * (such as PR bodies or commit messages) never triggers command rules.
 */
export function stripHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    out.push(line);
    const pending: Array<{ readonly delim: string; readonly stripTabs: boolean }> = [];
    let quote: "'" | '"' | null = null;
    for (let pos = 0; pos < line.length; pos += 1) {
      const ch = line[pos]!;
      if (quote) {
        if (ch === "\\" && quote === '"' && pos + 1 < line.length) {
          pos += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "#") break;
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "\\" && pos + 1 < line.length) {
        pos += 1;
        continue;
      }
      if (ch === "<" && line[pos + 1] === "<" && line[pos + 2] !== "<") {
        const slice = line.slice(pos);
        const match = HEREDOC_RE.exec(slice);
        if (match) {
          const delim = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
          if (delim) {
            pending.push({ delim, stripTabs: match[1] === "-" });
            pos += match[0].length - 1;
          }
        }
      }
    }
    i += 1;
    for (const hd of pending) {
      while (i < lines.length) {
        const candidate = hd.stripTabs ? lines[i]!.replace(/^\t+/, "") : lines[i]!;
        i += 1;
        if (candidate === hd.delim) break;
      }
    }
  }
  return out.join("\n");
}

/**
 * Extracts inner shell commands from `$(...)` and backtick substitutions outside single quotes.
 */
export function extractCommandSubstitutions(segment: string): ReadonlyArray<string> {
  const out: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === "$" && segment[i + 1] === "(") {
      let depth = 1;
      const start = i + 2;
      let j = start;
      let innerQuote: "'" | '"' | null = null;
      while (j < segment.length && depth > 0) {
        const c = segment[j]!;
        if (innerQuote) {
          if (c === "\\" && innerQuote === '"' && j + 1 < segment.length) {
            j += 2;
            continue;
          }
          if (c === innerQuote) innerQuote = null;
          j += 1;
          continue;
        }
        if (c === "'" || c === '"') innerQuote = c;
        else if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        const inner = segment.slice(start, j - 1).trim();
        if (inner) out.push(inner);
        i = j - 1;
      }
      continue;
    }
    if (ch === "`") {
      const start = i + 1;
      let j = start;
      while (j < segment.length && segment[j] !== "`") {
        if (segment[j] === "\\" && j + 1 < segment.length) j += 2;
        else j += 1;
      }
      if (j < segment.length) {
        const inner = segment.slice(start, j).trim();
        if (inner) out.push(inner);
        i = j;
      }
    }
  }
  return out;
}

/**
 * Tokenizes a single simple shell segment into POSIX words, stripping redirections and their targets.
 */
export function tokenizeSimpleCommand(segment: string): ReadonlyArray<string> {
  const tokens: Array<{ readonly text: string; readonly op: boolean }> = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let hadQuote = false;

  const pushWord = () => {
    if (cur.length > 0 || hadQuote) {
      tokens.push({ text: cur, op: false });
      cur = "";
      hadQuote = false;
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    const next = segment[i + 1] ?? "";
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length && /["\\$`\n]/.test(next)) {
        cur += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hadQuote = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += next;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (/^\d+$/.test(cur)) {
        cur = "";
      } else {
        pushWord();
      }
      let op = ch;
      if (
        next === ch ||
        next === "&" ||
        (ch === ">" && next === "|") ||
        (ch === "<" && next === ">")
      ) {
        op += next;
        i += 1;
        if (op === "<<" && segment[i + 1] === "<") {
          op += "<";
          i += 1;
        }
      }
      tokens.push({ text: op, op: true });
      continue;
    }
    if (ch === "&" && next === ">") {
      pushWord();
      tokens.push({ text: "&>", op: true });
      i += 1;
      continue;
    }
    cur += ch;
  }
  pushWord();

  const words: string[] = [];
  let skipTarget = false;
  for (const tok of tokens) {
    if (tok.op) {
      skipTarget = true;
      continue;
    }
    if (skipTarget) {
      skipTarget = false;
      continue;
    }
    words.push(tok.text);
  }
  return words;
}

/**
 * Strips leading `VAR=val` assignments and transparent wrappers (`env`, `command`, `exec`, `timeout`, etc.).
 */
export function unwrapCommand(words: ReadonlyArray<string>): {
  readonly command: ReadonlyArray<string>;
  readonly assigned: Readonly<Record<string, string>>;
} {
  const assigned: Record<string, string> = {};
  let i = 0;

  while (i < words.length) {
    const w = words[i]!;
    if (ENV_ASSIGN_RE.test(w)) {
      const eq = w.indexOf("=");
      assigned[w.slice(0, eq)] = w.slice(eq + 1);
      i += 1;
      continue;
    }
    const base = NodePath.basename(w);
    if (!(base in WRAPPERS)) break;
    const valOpts = WRAPPERS[base]!;
    i += 1;
    if (base === "timeout") {
      while (i < words.length && (words[i] ?? "").startsWith("-")) {
        const opt = words[i]!;
        if (opt === "--") {
          i += 1;
          break;
        }
        const optName = opt.split("=", 1)[0] ?? "";
        i += !opt.includes("=") && valOpts.has(optName) ? 2 : 1;
      }
      if (i < words.length) i += 1;
      continue;
    }
    while (i < words.length) {
      const opt = words[i]!;
      if (opt === "--") {
        i += 1;
        break;
      }
      if (base === "env" && ENV_ASSIGN_RE.test(opt)) {
        const eq = opt.indexOf("=");
        assigned[opt.slice(0, eq)] = opt.slice(eq + 1);
        i += 1;
        continue;
      }
      if (!opt.startsWith("-") || opt === "-") break;
      const optName = opt.split("=", 1)[0] ?? "";
      i += !opt.includes("=") && valOpts.has(optName) ? 2 : 1;
    }
  }

  return { command: words.slice(i), assigned };
}
