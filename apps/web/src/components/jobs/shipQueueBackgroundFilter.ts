import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";

import { parseShellSegments, stripLeadingEnvPrefix, unwrapCernoTokens } from "./cernoCommand";
import { mergeRunningCernoTurnTasks } from "./cernoRunPresentation";

const SHIP_QUEUE_BINARIES = new Set(["ship-queue", "ship-queue.sh"]);
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_CONTROL_PREFIXES = new Set([
  "!",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "exec",
  "nohup",
  "time",
  "command",
  "builtin",
]);
const LOG_VIEWER_BINARIES = new Set(["tail", "cat", "head", "less", "more", "watch", "sed", "awk"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "-s", "--kill-after", "--signal"]);
const STDBUF_VALUE_FLAGS = new Set(["-i", "-o", "-e", "--input", "--output", "--error"]);

const SHIP_JOB_LOG_PATH_RE = /\/\.?ship-queue\/jobs\/\d+(?:\/|$)/iu;
const ASSIGN_SHIP_SUBSHELL_RE =
  /^[A-Za-z_][A-Za-z0-9_]*=\$\(\s*(?:[^\s/]*\/)*ship-queue(?:\.sh)?(?:\s|$|\))/iu;

const SHIP_QUEUE_DESC_START_RE = /^ship[- ]queue(?:\.sh)?\b/iu;
const SHIP_QUEUE_DESC_PHRASE_RE =
  /\bship[- ]queue(?:\.sh)?\s+(?:job|watch|watcher|monitor|submit|deploy|status|cancel|wait|logs?|#?\d+)\b|\b(?:watch(?:ing)?|monitor(?:ing)?|follow(?:ing)?|wait(?:ing)?\s+for)\s+(?:the\s+)?(?:ship[- ]queue(?:\.sh)?|sq)\b|\bsq\s+(?:watch|job|submit|deploy|wait|cancel|#?\d+)\b/iu;
const SHIP_JOB_ID_CUE_RE = /\b(?:ship|queue|sq|watch(?:ing|er)?|monitor(?:ing)?|job)\b/iu;
const SHIP_JOB_NUM_RE = /#?(\d{3,8})\b/gu;

function tokenBasename(token: string): string {
  const trimmed = token.replace(/\/+$/u, "");
  return (trimmed.split("/").pop() ?? "").toLowerCase();
}

function skipPrefixedFlags(
  tokens: ReadonlyArray<string>,
  startIndex: number,
  valueFlags: ReadonlySet<string>,
): number {
  let idx = startIndex;
  while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
    const flag = tokens[idx]!;
    if (flag === "--") {
      idx += 1;
      break;
    }
    idx += !flag.includes("=") && valueFlags.has(flag) ? 2 : 1;
  }
  return idx;
}

function stripShellWrappers(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  let rest = tokens;
  while (rest.length > 0) {
    const afterEnv = stripLeadingEnvPrefix(rest);
    if (afterEnv.length === 0) return afterEnv;
    const head = tokenBasename(afterEnv[0]!);
    if (SHELL_CONTROL_PREFIXES.has(head)) {
      rest = afterEnv.slice(1);
      continue;
    }
    if (head === "timeout") {
      let idx = skipPrefixedFlags(afterEnv, 1, TIMEOUT_VALUE_FLAGS);
      if (idx < afterEnv.length) idx += 1;
      rest = afterEnv.slice(idx);
      continue;
    }
    if (head === "stdbuf") {
      const idx = skipPrefixedFlags(afterEnv, 1, STDBUF_VALUE_FLAGS);
      rest = afterEnv.slice(idx);
      continue;
    }
    rest = afterEnv;
    break;
  }
  return rest;
}

function segmentRunsShipQueue(segment: ReadonlyArray<string>, depth: number): boolean {
  if (depth > 3) return false;
  for (const tok of segment) {
    if (tok === "export" || tok === "local" || tok === "readonly") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tok)) {
      if (ASSIGN_SHIP_SUBSHELL_RE.test(tok)) return true;
      continue;
    }
    break;
  }

  const rest = stripShellWrappers(segment);
  if (rest.length === 0) return false;
  const head = tokenBasename(rest[0]!);

  if (SHIP_QUEUE_BINARIES.has(head)) {
    return true;
  }

  if (head === "cerno") {
    const sub = rest[1]?.toLowerCase();
    if (sub === "ship-watch") return true;
    if (sub === "tail" && rest.slice(2).some((tok) => SHIP_JOB_LOG_PATH_RE.test(tok))) {
      return true;
    }
    const unwrapped = unwrapCernoTokens(rest);
    if (unwrapped !== rest && unwrapped.length > 0 && segmentRunsShipQueue(unwrapped, depth + 1)) {
      return true;
    }
    return false;
  }

  if (SHELL_WRAPPERS.has(head)) {
    for (let i = 1; i < rest.length; i += 1) {
      const tok = rest[i]!;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/u.test(tok)) {
        return i + 1 < rest.length && isShipQueueCommandInternal(rest[i + 1]!, depth + 1);
      }
      if (tok === "-o" || tok === "+o") {
        i += 1;
        continue;
      }
      if (tok.startsWith("-") || tok.startsWith("+")) {
        continue;
      }
      return SHIP_QUEUE_BINARIES.has(tokenBasename(tok));
    }
    return false;
  }

  if (LOG_VIEWER_BINARIES.has(head)) {
    return rest.slice(1).some((tok) => SHIP_JOB_LOG_PATH_RE.test(tok));
  }

  return false;
}

function isShipQueueCommandInternal(rawCommand: string, depth: number): boolean {
  if (depth > 3 || !rawCommand.trim()) return false;
  for (const segment of parseShellSegments(rawCommand)) {
    if (segmentRunsShipQueue(segment, depth)) {
      return true;
    }
  }
  return false;
}

export function isShipQueueCommand(rawCommand: string | null | undefined): boolean {
  if (!rawCommand) return false;
  return isShipQueueCommandInternal(rawCommand, 0);
}

function isShipQueueDescription(
  description: string | null | undefined,
  knownShipJobIds?: ReadonlySet<string>,
): boolean {
  const trimmed = description?.trim();
  if (!trimmed) return false;
  if (SHIP_QUEUE_DESC_START_RE.test(trimmed) || SHIP_QUEUE_DESC_PHRASE_RE.test(trimmed)) {
    return true;
  }
  if (knownShipJobIds && knownShipJobIds.size > 0 && SHIP_JOB_ID_CUE_RE.test(trimmed)) {
    for (const match of trimmed.matchAll(SHIP_JOB_NUM_RE)) {
      if (match[1] && knownShipJobIds.has(match[1])) {
        return true;
      }
    }
  }
  return false;
}

function findTaskTurnItem(
  task: OrchestrationV2PendingBackgroundTask,
  turnItems: ThreadStructure["turnItems"],
) {
  return turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
}

export function isShipQueueBackgroundTask(
  task: OrchestrationV2PendingBackgroundTask,
  turnItems?: ThreadStructure["turnItems"],
  knownShipJobIds?: ReadonlySet<string>,
): boolean {
  if (task.kind === "subagent") return false;
  const item = turnItems ? findTaskTurnItem(task, turnItems) : undefined;
  const command =
    task.command?.trim() || (item?.type === "command_execution" ? item.input.trim() : "");
  if (command) {
    return isShipQueueCommand(command);
  }
  const description =
    task.description?.trim() ||
    (item?.type === "command_execution" ? (item.title?.trim() ?? "") : "");
  return isShipQueueDescription(description, knownShipJobIds);
}

export function selectVisibleBackgroundWorkTasks(input: {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly excludeShipQueue?: boolean | undefined;
  readonly knownShipJobIds?: ReadonlySet<string> | undefined;
}): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  const merged = mergeRunningCernoTurnTasks(input.tasks, input.turnItems);
  if (!input.excludeShipQueue) return merged;
  return merged.filter(
    (task) => !isShipQueueBackgroundTask(task, input.turnItems, input.knownShipJobIds),
  );
}
