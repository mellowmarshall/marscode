// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off - Standalone Node CLI shell segment scanner and nesting guard.
import * as NodePath from "node:path";

import {
  extractCommandSubstitutions,
  stripHeredocs,
  tokenizeSimpleCommand,
  unwrapCommand,
} from "./shellTokenize.ts";

export const MAX_SHELL_DEPTH = 6;
export const SCOPE_PUSH = "__HG_SCOPE_PUSH__";
export const SCOPE_POP = "__HG_SCOPE_POP__";

export class ShellNestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellNestingError";
  }
}

const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "dash"]);

export interface ShellSegment {
  readonly text: string;
  readonly persistsCwd: boolean;
}

/**
 * Quote-aware split of a shell command into segments with subshell scope markers
 * (`SCOPE_PUSH` / `SCOPE_POP`) and `persistsCwd` flags (false for pipelines/backgrounded commands).
 */
export function splitShellSegments(command: string): ReadonlyArray<ShellSegment> {
  const text = stripHeredocs(command);
  const segs: ShellSegment[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let prevWasPipe = false;
  let parenDepth = 0;

  const flush = (persists: boolean) => {
    const trimmed = buf.trim();
    if (trimmed) {
      segs.push({ text: trimmed, persistsCwd: persists });
    }
    buf = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1] ?? "";
    const prev = i > 0 ? text[i - 1]! : "";

    if (quote) {
      buf += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        buf += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "\\" && i + 1 < text.length) {
      buf += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(prev))) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "$" && next === "(") {
      let depth = 1;
      buf += "$(";
      i += 2;
      while (i < text.length && depth > 0) {
        const c = text[i]!;
        if (c === "\\" && i + 1 < text.length) {
          buf += c + text[i + 1]!;
          i += 2;
          continue;
        }
        if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        buf += c;
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (ch === "(" && buf.trim() === "" && prev !== "<" && prev !== ">") {
      parenDepth += 1;
      segs.push({ text: SCOPE_PUSH, persistsCwd: false });
      prevWasPipe = false;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      flush(!prevWasPipe);
      parenDepth -= 1;
      segs.push({ text: SCOPE_POP, persistsCwd: false });
      prevWasPipe = false;
      continue;
    }

    const isAmpRedir = ch === "&" && next === ">";
    if (
      ch === ";" ||
      ch === "\n" ||
      ((ch === "&" || ch === "|") && !isAmpRedir && prev !== "<" && prev !== ">")
    ) {
      const doubled = (ch === "&" || ch === "|") && next === ch;
      const pipeAmp = ch === "|" && next === "&";
      if (doubled || pipeAmp) i += 1;
      const isPipeOut = (ch === "|" && !doubled) || pipeAmp;
      const isBg = ch === "&" && !doubled;
      const hadText = buf.trim().length > 0;
      flush(!prevWasPipe && !isPipeOut && !isBg);
      if (hadText || ch !== "\n") {
        prevWasPipe = isPipeOut;
      }
      continue;
    }

    buf += ch;
  }

  flush(!prevWasPipe);
  return segs;
}

export function extractNestedShellScripts(words: ReadonlyArray<string>): ReadonlyArray<string> {
  const scripts: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const base = NodePath.basename(words[i]!);
    if (!SHELL_BINARIES.has(base)) continue;
    let j = i + 1;
    let hasC = false;
    while (j < words.length) {
      const opt = words[j]!;
      if (opt === "-" || opt === "--" || (!opt.startsWith("-") && !opt.startsWith("+"))) break;
      if (opt === "-o" || opt === "+o" || opt === "--rcfile" || opt === "--init-file") {
        j += 2;
        continue;
      }
      if (opt.startsWith("-") && !opt.startsWith("--") && opt.slice(1).includes("c")) {
        hasC = true;
      }
      j += 1;
    }
    if (j < words.length && words[j] === "--") j += 1;
    if (hasC && j < words.length) {
      scripts.push(words[j]!);
    }
  }
  return scripts;
}

export function extractEvalScript(words: ReadonlyArray<string>): string | null {
  if (words[0] !== "eval") return null;
  const rest = words[1] === "--" ? words.slice(2) : words.slice(1);
  const joined = rest.join(" ").trim();
  return joined || null;
}

export function applyDirectoryChange(
  words: ReadonlyArray<string>,
  cwd: string,
  prevCwd: string,
  dirStack: string[],
  env: NodeJS.ProcessEnv,
): { readonly cwd: string; readonly prevCwd: string } {
  const cmd = words[0];
  if (cmd === "cd") {
    const target = words.slice(1).find((w) => w === "-" || !w.startsWith("-")) ?? env.HOME ?? cwd;
    const next = target === "-" ? prevCwd : NodePath.resolve(cwd, target);
    return { cwd: next, prevCwd: cwd };
  }
  if (cmd === "pushd") {
    const target = words.slice(1).find((w) => !w.startsWith("-"));
    if (target) {
      dirStack.push(cwd);
      return { cwd: NodePath.resolve(cwd, target), prevCwd: cwd };
    }
  }
  if (cmd === "popd" && dirStack.length > 0) {
    const popped = dirStack.pop()!;
    return { cwd: popped, prevCwd: cwd };
  }
  return { cwd, prevCwd };
}

export function simpleCommands(
  command: string,
  options?: {
    readonly includeNested?: boolean | undefined;
    readonly maxDepth?: number | undefined;
    readonly strictDepth?: boolean | undefined;
    readonly depth?: number | undefined;
  },
): ReadonlyArray<ReadonlyArray<string>> {
  const depth = options?.depth ?? 0;
  const maxDepth = options?.maxDepth ?? MAX_SHELL_DEPTH;
  const includeNested = options?.includeNested !== false;
  const out: Array<ReadonlyArray<string>> = [];

  for (const seg of splitShellSegments(command)) {
    if (seg.text === SCOPE_PUSH || seg.text === SCOPE_POP) continue;
    const words = tokenizeSimpleCommand(seg.text);
    if (words.length > 0) out.push(words);

    if (includeNested) {
      const substs = extractCommandSubstitutions(seg.text);
      const unwrapped = unwrapCommand(words).command;
      const nested = [...substs, ...extractNestedShellScripts(unwrapped)];
      const ev = extractEvalScript(unwrapped);
      if (ev) nested.push(ev);
      if (nested.length > 0) {
        if (depth >= maxDepth) {
          if (options?.strictDepth) {
            throw new ShellNestingError("nests shell scripts deeper than the guard tracks");
          }
          continue;
        }
        for (const script of nested) {
          out.push(
            ...simpleCommands(script, {
              includeNested: true,
              maxDepth,
              strictDepth: options?.strictDepth,
              depth: depth + 1,
            }),
          );
        }
      }
    }
  }
  return out;
}
