// @effect-diagnostics nodeBuiltinImport:off - Batch override plans: one owner approval for a declared list of exact, guard-bound commands.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { redactGuardCommand } from "./commandRedact.ts";
import { argvSha256 } from "./digests.ts";
import { GUARD_NAME_RE, MAX_GUARD_ARGS, sanitizeText, type GuardPlanEntry } from "./protocol.ts";

export const PLAN_GUARD = "plan";
export const MAX_PLAN_COMMANDS = 32;
/** Each approved plan command is usable once within this window, in the same thread and cwd. */
export const PLAN_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_PLAN_FILE_BYTES = 64 * 1024;
/** Guards whose approvals bind to a protected diff (a bundle); a plan never stands in for them. */
const PLAN_FORBIDDEN_GUARDS: ReadonlySet<string> = new Set([PLAN_GUARD, "ship-queue", "playbook"]);
const DEFAULT_GUARD_BY_PROGRAM: Readonly<Record<string, string>> = { git: "git", gh: "gh" };

export interface GuardPlan {
  readonly reason: string;
  readonly entries: ReadonlyArray<GuardPlanEntry>;
}

type Parsed<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

function parseArgv(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GUARD_ARGS) return null;
  const argv: string[] = [];
  for (const word of raw) {
    if (typeof word !== "string" || word.includes("\0")) return null;
    argv.push(word);
  }
  return argv;
}

/**
 * Entries are `[argv...]` (git and gh only, by program name) or `{ guard, command }`. Commands
 * are redacted exactly as host guards redact what they send, so the digests match.
 */
export function parsePlanEntries(
  raw: unknown,
): Parsed<{ readonly entries: ReadonlyArray<GuardPlanEntry> }> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAN_COMMANDS) {
    return { ok: false, error: `plan needs 1..${MAX_PLAN_COMMANDS} commands` };
  }
  const entries: GuardPlanEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const obj =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    const argv = parseArgv(obj ? obj.command : item);
    if (!argv) return { ok: false, error: "each plan command must be a non-empty argv array" };
    const guard = obj
      ? typeof obj.guard === "string"
        ? obj.guard
        : ""
      : (DEFAULT_GUARD_BY_PROGRAM[NodePath.basename(argv[0] ?? "")] ?? "");
    if (!GUARD_NAME_RE.test(guard)) {
      return { ok: false, error: `plan entry needs a guard: ${argv.slice(0, 3).join(" ")}` };
    }
    if (PLAN_FORBIDDEN_GUARDS.has(guard)) {
      return { ok: false, error: `a plan cannot approve ${guard}; it needs its own approval` };
    }
    // Commands that differ only in redacted secrets share a digest; accepted as visibility-only,
    // since the owner approved the shape shown and the secret never reaches the broker.
    const command = redactGuardCommand(argv);
    const key = `${guard}\0${argvSha256(command)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ guard, command });
  }
  return { ok: true, entries };
}

export function parsePlan(raw: unknown): Parsed<GuardPlan> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "plan must be a JSON object with reason and commands" };
  }
  const obj = raw as Record<string, unknown>;
  const reason = sanitizeText(obj.reason, 400);
  if (reason.split(/\s+/).filter(Boolean).length < 3) {
    return { ok: false, error: "plan reason must say why, in words" };
  }
  const parsed = parsePlanEntries(obj.commands);
  if (!parsed.ok) return parsed;
  return { ok: true, reason, entries: parsed.entries };
}

/** Reads a plan file (`{"reason": "...", "commands": [["gh", "repo", "edit", ...], ...]}`). */
export function readPlanFile(filePath: string, cwd: string): Parsed<GuardPlan> {
  const abs = NodePath.resolve(cwd, filePath);
  try {
    const st = NodeFS.statSync(abs);
    if (!st.isFile() || st.size > MAX_PLAN_FILE_BYTES) {
      return { ok: false, error: `plan file is not a regular file under 64 KiB: ${abs}` };
    }
    return parsePlan(JSON.parse(NodeFS.readFileSync(abs, "utf8")) as unknown);
  } catch (err) {
    return {
      ok: false,
      error: `cannot read plan file ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function planContains(
  entries: ReadonlyArray<GuardPlanEntry>,
  guard: string,
  command: ReadonlyArray<string>,
): boolean {
  const digest = argvSha256(command);
  return entries.some((e) => e.guard === guard && argvSha256(e.command) === digest);
}
