#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Headless MarsCode guard CLI (`marscode-guard`) owning check-first bundled overrides, owner-check, and offline signature verify.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { inspectWorktreeBundle } from "./bundleInspect.ts";
import {
  checkGuardGrant,
  identifyGuardThread,
  peekGuardGrant,
  requestGuardGrant,
  useGuardGrant,
} from "./client.ts";
import { PLAN_GUARD, readPlanFile } from "./plan.ts";
import { verifyBundleGrant, type SignedBundleGrantPayload } from "./signing.ts";

function isTempInstalledCli(): boolean {
  try {
    const selfPath = NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url));
    const tmpRoots = ["/tmp", "/var/tmp"].map((p) => {
      try {
        return NodeFS.realpathSync(p);
      } catch {
        return p;
      }
    });
    return tmpRoots.some((root) => selfPath.startsWith(`${root}${NodePath.sep}`));
  } catch {
    return false;
  }
}

function splitDashDash(args: ReadonlyArray<string>): {
  readonly flags: ReadonlyArray<string>;
  readonly command: ReadonlyArray<string>;
} {
  const idx = args.indexOf("--");
  if (idx === -1) return { flags: args, command: [] };
  return { flags: args.slice(0, idx), command: args.slice(idx + 1) };
}

function parseFlagMap(flags: ReadonlyArray<string>): {
  readonly positional: ReadonlyArray<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const valueFlags = new Set([
    "--worktree",
    "--branch",
    "--base",
    "--pr",
    "--reason",
    "--refusal",
    "--cwd",
    "--thread-id",
    "--session",
    "--timeout",
    "--pubkey",
    "--payload",
    "--sig",
    "--plan",
  ]);
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i] ?? "";
    if (valueFlags.has(arg) && i + 1 < flags.length) {
      values.set(arg, flags[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      booleans.add(arg);
      continue;
    }
    positional.push(arg);
  }
  return { positional, values, booleans };
}

function parseTimeoutMs(values: ReadonlyMap<string, string>): number | null | undefined {
  if (!values.has("--timeout")) return undefined;
  const raw = values.get("--timeout")?.trim() ?? "";
  const sec = Number(raw);
  if (!raw || !Number.isFinite(sec) || sec <= 0) {
    return null;
  }
  return sec * 1_000;
}

async function runPlanOverride(
  parsed: ReturnType<typeof parseFlagMap>,
  allowTestOverride: boolean,
  timeoutMs: number | undefined,
): Promise<number> {
  const cwd = parsed.values.get("--cwd") || process.cwd();
  const plan = readPlanFile(parsed.values.get("--plan") ?? "", cwd);
  if (!plan.ok) {
    process.stderr.write(`marscode-guard: ${plan.error}\n`);
    return 64;
  }
  const requested = await requestGuardGrant({
    guard: PLAN_GUARD,
    command: plan.commands[0]!,
    plan: plan.entries,
    cwd,
    refusal: `Batch approval requested for ${plan.entries.length} owner-only commands`,
    proposedReason: plan.reason,
    timeoutMs,
    threadId: parsed.values.get("--thread-id"),
    session: parsed.values.get("--session"),
    allowTestOverride,
  });
  if (parsed.booleans.has("--json")) process.stdout.write(`${JSON.stringify(requested)}\n`);
  if (requested.ok) {
    process.stderr.write(
      `marscode-guard: plan approved; run each listed command once from ${cwd} within 30 minutes.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `marscode-guard (plan): ${requested.error || "owner approval was not granted"}\n`,
  );
  return 1;
}

async function runOverride(
  rest: ReadonlyArray<string>,
  allowTestOverride: boolean,
): Promise<number> {
  const { flags, command } = splitDashDash(rest);
  const parsed = parseFlagMap(flags);
  if (parsed.values.has("--plan")) {
    const planTimeout = parseTimeoutMs(parsed.values);
    if (planTimeout === null) {
      process.stderr.write("marscode-guard: --timeout must be a positive number of seconds\n");
      return 64;
    }
    return runPlanOverride(parsed, allowTestOverride, planTimeout);
  }
  const guard = parsed.positional[0] ?? "";
  const refusal = parsed.values.get("--refusal") ?? parsed.positional[1] ?? "";
  const cmd = command.length > 0 ? command : parsed.positional.slice(2);
  if (!guard || cmd.length === 0) {
    process.stderr.write(
      "usage: marscode-guard override <guard> <refusal> [--worktree WT] [--branch BR] -- <cmd...>\n" +
        "       marscode-guard override --plan <plan.json> [--cwd DIR]\n",
    );
    return 64;
  }

  const timeoutMs = parseTimeoutMs(parsed.values);
  if (timeoutMs === null) {
    process.stderr.write("marscode-guard: --timeout must be a positive number of seconds\n");
    return 64;
  }

  const cwd = parsed.values.get("--cwd") || process.cwd();
  const reason = parsed.values.get("--reason") || process.env.HOST_GUARD_OVERRIDE?.trim() || "";
  const bundle = inspectWorktreeBundle({
    guard,
    command: cmd,
    cwd,
    worktree: parsed.values.get("--worktree"),
    branch: parsed.values.get("--branch"),
    baseRef: parsed.values.get("--base"),
    prOrIssue: parsed.values.get("--pr"),
    summary: reason || undefined,
  });

  const existing = await checkGuardGrant({
    guard,
    command: cmd,
    cwd,
    bundle,
    threadId: parsed.values.get("--thread-id"),
    session: parsed.values.get("--session"),
    allowTestOverride,
  });
  if (existing.ok) {
    if (parsed.booleans.has("--json")) {
      process.stdout.write(`${JSON.stringify(existing)}\n`);
    }
    return 0;
  }
  if (existing.errCode === "unreachable" || existing.errCode === "timeout") {
    process.stderr.write(`marscode-guard: broker ${existing.errCode}\n`);
    return 1;
  }

  const requested = await requestGuardGrant({
    guard,
    command: cmd,
    cwd,
    refusal: refusal || `Host-guard override requested for ${guard}`,
    proposedReason: reason,
    bundle,
    storeGrant: true,
    timeoutMs,
    threadId: parsed.values.get("--thread-id"),
    session: parsed.values.get("--session"),
    allowTestOverride,
  });
  if (parsed.booleans.has("--json")) {
    process.stdout.write(`${JSON.stringify(requested)}\n`);
  }
  if (requested.ok) return 0;
  process.stderr.write(
    `marscode-guard (${guard}): ${requested.error || "owner approval was not granted"}\n`,
  );
  return 1;
}

async function runOwnerCheck(
  rest: ReadonlyArray<string>,
  allowTestOverride: boolean,
): Promise<number> {
  const { flags, command } = splitDashDash(rest);
  const parsed = parseFlagMap(flags);
  const action = parsed.positional[0] ?? "";
  const cmd = command.length > 0 ? command : parsed.positional.slice(1);
  const cwd = parsed.values.get("--cwd") || process.cwd();
  if (!action) {
    process.stderr.write("usage: marscode-guard owner-check <action> [-- <cmd...>]\n");
    return 64;
  }

  const timeoutMs = parseTimeoutMs(parsed.values);
  if (timeoutMs === null) {
    process.stderr.write("marscode-guard: --timeout must be a positive number of seconds\n");
    return 64;
  }

  const effectiveCmd = cmd.length > 0 ? cmd : [action];
  const refusal = `human-only action: ${action}`;
  // owner-check is the gate of the action it names, so it consumes the grant.
  const existing = await useGuardGrant({
    guard: "owner-check",
    command: effectiveCmd,
    cwd,
    threadId: parsed.values.get("--thread-id"),
    session: parsed.values.get("--session"),
    allowTestOverride,
  });
  if (existing.ok) {
    if (parsed.booleans.has("--json")) process.stdout.write(`${JSON.stringify(existing)}\n`);
    return 0;
  }

  const requested = await requestGuardGrant({
    guard: "owner-check",
    command: effectiveCmd,
    cwd,
    refusal,
    proposedReason: `Owner approval requested for ${action}`,
    timeoutMs,
    threadId: parsed.values.get("--thread-id"),
    session: parsed.values.get("--session"),
    allowTestOverride,
  });
  if (parsed.booleans.has("--json")) process.stdout.write(`${JSON.stringify(requested)}\n`);
  if (requested.ok) return 0;
  process.stderr.write(
    `marscode-guard: refusing ${action}: ${requested.error || "owner approval not granted"}\n`,
  );
  return 1;
}

function runInspectBundle(rest: ReadonlyArray<string>): number {
  const { flags, command } = splitDashDash(rest);
  const parsed = parseFlagMap(flags);
  const guard = parsed.positional[0] ?? "ship-queue";
  const cwd = parsed.values.get("--cwd") || process.cwd();
  const bundle = inspectWorktreeBundle({
    guard,
    command: command.length > 0 ? command : parsed.positional.slice(1),
    cwd,
    worktree: parsed.values.get("--worktree"),
    branch: parsed.values.get("--branch"),
    baseRef: parsed.values.get("--base"),
    prOrIssue: parsed.values.get("--pr"),
    summary: parsed.values.get("--reason"),
  });
  process.stdout.write(`${JSON.stringify(bundle ?? null)}\n`);
  return 0;
}

function runVerify(rest: ReadonlyArray<string>): number {
  const parsed = parseFlagMap(rest);
  const pubPath = parsed.values.get("--pubkey") ?? "";
  const payloadRaw = parsed.values.get("--payload") ?? "";
  const sig = parsed.values.get("--sig") ?? "";
  if (!pubPath || !payloadRaw || !sig) {
    process.stderr.write(
      "usage: marscode-guard verify --pubkey <file> --payload <json|@file> --sig <base64>\n",
    );
    return 64;
  }
  const pubPem = NodeFS.readFileSync(NodePath.resolve(pubPath), "utf8");
  const jsonText = payloadRaw.startsWith("@")
    ? NodeFS.readFileSync(NodePath.resolve(payloadRaw.slice(1)), "utf8")
    : payloadRaw;
  const payload = JSON.parse(jsonText) as SignedBundleGrantPayload;
  const valid = verifyBundleGrant(payload, sig, pubPem);
  process.stdout.write(`${JSON.stringify({ ok: valid })}\n`);
  return valid ? 0 : 1;
}

export async function runGuardCli(
  argv: ReadonlyArray<string>,
  options?: { readonly allowTestOverride?: boolean },
): Promise<number> {
  const allowTestOverride = options?.allowTestOverride ?? isTempInstalledCli();
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(
      "marscode-guard <override|owner-check|inspect-bundle|peek|check|identify|verify> [...]\n",
    );
    return 0;
  }
  if (sub === "override") return runOverride(rest, allowTestOverride);
  if (sub === "owner-check") return runOwnerCheck(rest, allowTestOverride);
  if (sub === "inspect-bundle") return runInspectBundle(rest);
  if (sub === "verify") return runVerify(rest);
  if (sub === "identify") {
    const res = await identifyGuardThread({ allowTestOverride });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }
  if (sub === "peek" || sub === "check") {
    const { flags, command } = splitDashDash(rest);
    const parsed = parseFlagMap(flags);
    const guard = parsed.positional[0] ?? "";
    const cmd = command.length > 0 ? command : parsed.positional.slice(1);
    const cwd = parsed.values.get("--cwd") || process.cwd();
    const bundle = inspectWorktreeBundle({
      guard,
      command: cmd,
      cwd,
      worktree: parsed.values.get("--worktree"),
      branch: parsed.values.get("--branch"),
      baseRef: parsed.values.get("--base"),
      prOrIssue: parsed.values.get("--pr"),
    });
    const threadId = parsed.values.get("--thread-id");
    const session = parsed.values.get("--session");
    if (sub === "peek") {
      const ok = await peekGuardGrant({
        guard,
        command: cmd,
        cwd,
        bundle,
        threadId,
        session,
        allowTestOverride,
      });
      process.stdout.write(`${JSON.stringify({ ok })}\n`);
      return ok ? 0 : 1;
    }
    const res = await checkGuardGrant({
      guard,
      command: cmd,
      cwd,
      bundle,
      threadId,
      session,
      allowTestOverride,
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }
  process.stderr.write(`marscode-guard: unknown subcommand '${sub}'\n`);
  return 64;
}

function isInvokedAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      NodeFS.realpathSync(process.argv[1]) ===
      NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
    );
  } catch {
    return (
      NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))
    );
  }
}

if (isInvokedAsMain()) {
  runGuardCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`marscode-guard: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
