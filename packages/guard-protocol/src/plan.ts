// @effect-diagnostics nodeBuiltinImport:off - Batch override plans: one owner approval for a declared list of exact commands.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { argvSha256 } from "./digests.ts";
import { MAX_GUARD_ARGS, sanitizeText } from "./protocol.ts";

export const PLAN_GUARD = "plan";
export const MAX_PLAN_COMMANDS = 32;
/** Each approved plan command is usable once within this window, in the same thread and cwd. */
export const PLAN_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_PLAN_FILE_BYTES = 64 * 1024;

export interface GuardPlan {
  readonly reason: string;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
}

export function parsePlanCommands(
  raw: unknown,
):
  | { readonly ok: true; readonly commands: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAN_COMMANDS) {
    return { ok: false, error: `plan needs 1..${MAX_PLAN_COMMANDS} commands` };
  }
  const commands: string[][] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length === 0 || entry.length > MAX_GUARD_ARGS) {
      return { ok: false, error: "each plan command must be a non-empty argv array" };
    }
    const argv: string[] = [];
    for (const word of entry) {
      if (typeof word !== "string" || word.includes("\0")) {
        return { ok: false, error: "plan command arguments must be strings without NUL bytes" };
      }
      argv.push(word);
    }
    const digest = argvSha256(argv);
    if (seen.has(digest)) continue;
    seen.add(digest);
    commands.push(argv);
  }
  return { ok: true, commands };
}

export function parsePlan(
  raw: unknown,
): ({ readonly ok: true } & GuardPlan) | { readonly ok: false; readonly error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "plan must be a JSON object with reason and commands" };
  }
  const obj = raw as Record<string, unknown>;
  const reason = sanitizeText(obj.reason, 400);
  if (reason.split(/\s+/).filter(Boolean).length < 3) {
    return { ok: false, error: "plan reason must say why, in words" };
  }
  const commands = parsePlanCommands(obj.commands);
  if (!commands.ok) return commands;
  return { ok: true, reason, commands: commands.commands };
}

/** Reads a plan file (`{"reason": "...", "commands": [["gh", "repo", "edit", ...], ...]}`). */
export function readPlanFile(
  filePath: string,
  cwd: string,
): ({ readonly ok: true } & GuardPlan) | { readonly ok: false; readonly error: string } {
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
  commands: ReadonlyArray<ReadonlyArray<string>>,
  command: ReadonlyArray<string>,
): boolean {
  const digest = argvSha256(command);
  return commands.some((c) => argvSha256(c) === digest);
}
