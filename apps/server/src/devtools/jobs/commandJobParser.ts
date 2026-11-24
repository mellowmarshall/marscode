// @effect-diagnostics nodeBuiltinImport:off - Pure parsers for surfacing T3 native commands as host/thread jobs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { redactLogLine } from "./logFileGuard.ts";
import { sanitizeJobText } from "./types.ts";

const SHIP_QUEUE_CMD_RE =
  /\bship-queue(?:\.sh)?\s+(?:watch|submit|wait|status|deploy|cancel)\b|\bcerno\s+ship-watch\b|\/\.?ship-queue\/jobs\/\d+/i;

const SHIP_QUEUE_DESC_RE =
  /\bship[- ]queue(?:\.sh)?\s+(?:job|watch|watcher|submit|deploy|status|#?\d+)\b|\bwatch(?:ing)?\s+(?:ship[- ]queue(?:\.sh)?|sq)\b|\bsq\s+(?:watch|job|submit|deploy|#?\d+)\b/i;

const SHIP_JOB_ID_CUE_RE = /\b(?:ship|queue|sq|watch(?:ing|er)?|job)\b/i;
const SHIP_JOB_NUM_RE = /#?(\d{3,8})\b/g;

const IMMEDIATE_WORKLOAD_RE =
  /\b(?:cerno\s+(?:watch|tail)|remote\.sh|blender|torchrun|accelerate\s+launch|deepspeed|train[_\w-]*\.py|eval[_\w-]*\.py|bench(?:mark)?[_\w-]*\.py|cargo\s+(?:test|build|clippy|nextest)|pytest|vitest|playwright|vp\s+(?:test|run\s+.*test)|pnpm\s+(?:test|build)|t3code-patch-nightly|docker\s+build)\b/i;

export function classifyCommandTracking(
  command: string,
  description?: string,
  hasShipJobId?: (id: string) => boolean,
): "skip" | "immediate" | "debounced" {
  const trimmedCmd = command.trim();
  if (trimmedCmd) {
    if (SHIP_QUEUE_CMD_RE.test(trimmedCmd)) return "skip";
    if (IMMEDIATE_WORKLOAD_RE.test(trimmedCmd)) return "immediate";
    return "debounced";
  }
  if (description) {
    if (SHIP_QUEUE_DESC_RE.test(description)) return "skip";
    if (hasShipJobId && SHIP_JOB_ID_CUE_RE.test(description)) {
      for (const m of description.matchAll(SHIP_JOB_NUM_RE)) {
        if (m[1] && hasShipJobId(m[1])) return "skip";
      }
    }
  }
  return "debounced";
}

export function inferCommandJobKind(command: string, description?: string): string {
  const text = `${description ?? ""} ${command}`.toLowerCase();
  if (
    /\b(?:pytest|vitest|playwright|cargo\s+test|go\s+test|vp\s+test|jest|unittest)\b/.test(text)
  ) {
    return "test";
  }
  if (/(?<![a-z])(?:train(?:ing)?|finetune|distill|torchrun|sft|pretrain)(?![a-z])/.test(text)) {
    return "train";
  }
  if (/(?<![a-z_])(?:migrat(?:e|ion)|prisma\s+migrate|alembic|drizzle-kit)(?![a-z_])/.test(text)) {
    return "migrate";
  }
  if (
    /\b(?:cargo\s+build|vite\s+build|tsc|next\s+build|pnpm\s+build|docker\s+build|patch-nightly|repack|compile)\b/.test(
      text,
    )
  ) {
    return "build";
  }
  if (
    /(?<![a-z])(?:blender|render(?:ing|s)?|ffmpeg|cycles|eevee|frames?)(?![a-z])|scene\d*\.py/.test(
      text,
    )
  ) {
    return "render";
  }
  if (
    /(?<![a-z])(?:evaluate|evaluation|benchmark|bench|eval(?![ \t]+["'$`]))(?![a-z])/.test(text)
  ) {
    return "eval";
  }
  return "command";
}

function unquoteShellToken(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractLeadingCdDir(command: string): string | null {
  const m = /(?:^|&&|;)\s*cd\s+((?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+))/.exec(command);
  if (!m?.[1]) return null;
  const dir = unquoteShellToken(m[1]);
  return NodePath.isAbsolute(dir) ? dir : null;
}

const LOG_EXT_RE = /\.(?:log|txt|jsonl|ndjson)$/i;
const SHELL_VAR_ASSIGN_RE =
  /(?:^|[\n;&])\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=((?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+))/g;
const LOG_VAR_NAME_RE = /^(?:LOG|LOG_FILE|LOGFILE|LOG_PATH|OUT_LOG)$/i;

function extractShellPathVars(command: string): ReadonlyMap<string, string> {
  const vars = new Map<string, string>();
  for (const m of command.matchAll(SHELL_VAR_ASSIGN_RE)) {
    const name = m[1];
    const val = m[2] ? unquoteShellToken(m[2]) : "";
    if (!name || !val || val.includes("$") || val.includes("`")) continue;
    vars.set(name, val);
  }
  return vars;
}

function expandShellPathVar(raw: string, vars: ReadonlyMap<string, string>): string {
  const varRef = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(raw.trim());
  if (!varRef) return raw;
  const key = varRef[1] ?? varRef[2];
  return (key ? vars.get(key) : undefined) ?? raw;
}

/**
 * Extracts an explicit log file path from common command wrappers (`cerno watch --log <p>`,
 * `cerno tail ... <p>`, `tee <p>`, `> <p>`, or `LOG="/path/to/run.log"`), expanding literal
 * shell path variables and resolving relative paths against leading `cd <dir>` or workspace.
 */
export function extractCommandLogPath(command: string, fallbackCwd?: string | null): string | null {
  if (!command.trim()) return null;
  const vars = extractShellPathVars(command);
  let rawPath: string | null = null;

  const flagLogMatch = /--log(?:=|\s+)((?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+))/.exec(command);
  if (flagLogMatch?.[1]) {
    rawPath = expandShellPathVar(unquoteShellToken(flagLogMatch[1]), vars);
  }

  if (!rawPath) {
    const cernoTailMatch =
      /\bcerno\s+tail\b[^\n;&|]*?\s((?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+))(?:\s*$|\s*[;&|\n])/.exec(
        command,
      );
    if (cernoTailMatch?.[1]) {
      const candidate = expandShellPathVar(unquoteShellToken(cernoTailMatch[1]), vars);
      if (!candidate.startsWith("-") && LOG_EXT_RE.test(candidate)) {
        rawPath = candidate;
      }
    }
  }

  if (!rawPath) {
    const teeOrRedirMatch =
      /(?:\btee(?:\s+-a)?\s+|(?:1|2|&)?>>?\s*)((?:"[^"\n]+"|'[^'\n]+'|[^\s;&|]+))/.exec(command);
    if (teeOrRedirMatch?.[1]) {
      const candidate = expandShellPathVar(unquoteShellToken(teeOrRedirMatch[1]), vars);
      if (candidate !== "/dev/null" && LOG_EXT_RE.test(candidate)) {
        rawPath = candidate;
      }
    }
  }

  if (!rawPath) {
    for (const [name, val] of vars) {
      if (LOG_VAR_NAME_RE.test(name) && LOG_EXT_RE.test(val)) {
        rawPath = val;
        break;
      }
    }
  }

  if (!rawPath || rawPath.includes("$") || rawPath.includes("`")) return null;
  if (NodePath.isAbsolute(rawPath)) return rawPath;
  const baseDir = extractLeadingCdDir(command) ?? (fallbackCwd || null);
  if (!baseDir || !NodePath.isAbsolute(baseDir)) return null;
  return NodePath.resolve(baseDir, rawPath);
}

const GENERIC_COMMAND_TITLES = new Set([
  "ran command",
  "run command",
  "running command",
  "command",
  "bash",
  "shell",
  "terminal",
  "execute command",
  "run shell command",
  "background command",
]);

const BOILERPLATE_LINE_RE =
  /^(?:[#()]|set\s+-|mkdir\s+-p\b|cd\s+|rm\s+-f\b|export\s+|trap\s+|ulimit\s+|umask\s+|:\s*>|[A-Za-z_][A-Za-z0-9_]*=)/;

function pickReadableScriptLine(command: string): string {
  const lines = command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (BOILERPLATE_LINE_RE.test(line)) continue;
    const echoMatch = /^echo\s+(?:-e\s+)?(?:"([^"]+)"|'([^']+)')/.exec(line);
    if (echoMatch) {
      const banner = (echoMatch[1] ?? echoMatch[2] ?? "")
        .replace(/^[=\-*#:\s]+|[=\-*#:\s]+$/g, "")
        .trim();
      if (banner.length >= 4 && !banner.startsWith("$")) return banner;
      continue;
    }
    return line;
  }
  return lines[0] ?? command.trim();
}

export function deriveCommandTitle(description: string | undefined, command: string): string {
  const cleanDesc = description ? sanitizeJobText(redactLogLine(description), 120) : undefined;
  if (cleanDesc && !GENERIC_COMMAND_TITLES.has(cleanDesc.toLowerCase())) return cleanDesc;
  let stripped = command.includes("\n") ? pickReadableScriptLine(command) : command.trim();
  // Strip leading `cd ... &&` / `rm -f ... &&` setup prefixes for readability.
  while (/^(?:cd|rm\s+-f|mkdir\s+-p)\s+[^&;]+&&\s*/.test(stripped)) {
    stripped = stripped.replace(/^(?:cd|rm\s+-f|mkdir\s+-p)\s+[^&;]+&&\s*/, "");
  }
  const cernoIdx = stripped.indexOf(" -- ");
  if (/^cerno\s+watch\b/.test(stripped) && cernoIdx !== -1) {
    stripped = stripped.slice(cernoIdx + 4).trim();
  }
  return sanitizeJobText(redactLogLine(stripped), 120) || "Background command";
}

export function makeBackgroundJobId(threadId: string, stableKey: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${threadId}\0${stableKey}`)
    .digest("hex")
    .slice(0, 16);
  return `bg:${digest}`;
}

export function resolveCommandTerminalOutcome(input: {
  readonly status: string;
  readonly exitCode?: number | undefined;
  readonly outputIndicatesFailure?: boolean | undefined;
  readonly output?: string | undefined;
  readonly wasCancelling: boolean;
}): {
  readonly state: "done" | "failed" | "cancelled";
  readonly summary?: string | undefined;
} {
  if (input.status === "cancelled" || input.status === "interrupted" || input.wasCancelling) {
    return { state: "cancelled" };
  }
  if (
    input.status === "failed" ||
    input.outputIndicatesFailure === true ||
    (typeof input.exitCode === "number" && input.exitCode !== 0)
  ) {
    if (typeof input.exitCode === "number") {
      return { state: "failed", summary: `Exited with code ${input.exitCode}` };
    }
    const lastLine = (input.output ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    return {
      state: "failed",
      summary: lastLine
        ? sanitizeJobText(redactLogLine(lastLine), 160) || "Command failed"
        : "Command failed",
    };
  }
  return { state: "done" };
}
