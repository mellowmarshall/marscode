// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Bounded process-group execution and fallback loop for `playbook challenge`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildProviderInvocation,
  CATALOG_TIMEOUT_MS,
  findProviderBinary,
  MAX_CHALLENGE_TIMEOUT_S,
  MIN_CHALLENGE_TIMEOUT_S,
  needsCodexAstraLookup,
  normalizeCodexEffort,
  pickLatestAstraFromCatalog,
  readCachedCodexAstraModel,
  readHostChallengeConfig,
  type BuiltProviderInvocation,
} from "./challengeProviders.ts";
import { decodeChallengeReplyText, type PlaybookChallengeReply } from "./challengeReply.ts";
import type { ChallengeModel } from "./challenger.ts";

const IDLE_LIMIT_S = 180;
const EXIT_GRACE_MS = 15_000;

export function extractTurnDoneExitCode(line: string): number | null {
  if (!line.includes('"turn.') && !line.includes('"result"')) return null;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    if (event.type === "turn.completed") return 0;
    if (event.type === "turn.failed") return 1;
    if (
      event.type === "result" &&
      ("result" in event || "structured_output" in event || "is_error" in event)
    ) {
      return event.is_error === true ? 1 : 0;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractStreamResultText(stream: string): string {
  let best = "";
  for (const rawLine of stream.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.is_error === true || event.is_api_error_message === true) continue;
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        best = item.text.trim();
      }
      continue;
    }
    if (event.type === "result") {
      if (event.structured_output && typeof event.structured_output === "object") {
        return JSON.stringify(event.structured_output);
      }
      if (event.result && typeof event.result === "object") {
        return JSON.stringify(event.result);
      }
      if (typeof event.result === "string" && event.result.trim()) best = event.result.trim();
      continue;
    }
    if ("acceptable" in event && "summary" in event) return JSON.stringify(event);
    const msg = event.message as Record<string, unknown> | undefined;
    if (msg && typeof msg === "object") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        best = msg.content.trim();
      } else if (Array.isArray(msg.content)) {
        const joined = msg.content
          .filter(
            (b): b is { type: string; text?: unknown } =>
              Boolean(b) && typeof b === "object" && (b as Record<string, unknown>).type === "text",
          )
          .map((b) => String(b.text ?? ""))
          .join("\n")
          .trim();
        if (joined) best = joined;
      }
    }
    if (typeof event.text === "string" && event.text.trim()) best = event.text.trim();
  }
  return best || stream;
}

export function computeChallengeTimeouts(promptChars: number, baseTimeoutSec: number) {
  const clampedBase = Math.max(
    MIN_CHALLENGE_TIMEOUT_S,
    Math.min(MAX_CHALLENGE_TIMEOUT_S, Math.round(baseTimeoutSec)),
  );
  const cap = Math.min(MAX_CHALLENGE_TIMEOUT_S, Math.max(clampedBase, clampedBase * 2));
  const extra = Math.max(0, Math.floor((promptChars - 20_000) / 250));
  const totalSec = Math.min(cap, clampedBase + extra);
  const idleSec = Math.min(totalSec, IDLE_LIMIT_S);
  return { totalMs: totalSec * 1_000, idleMs: idleSec * 1_000 };
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

interface SpawnRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stopReason: string | null;
}

async function runCliProcess(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinText: string;
  readonly totalMs: number;
  readonly idleMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<SpawnRunResult> {
  return await new Promise<SpawnRunResult>((resolve, reject) => {
    if (input.signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "", stopReason: "challenge cancelled" });
      return;
    }
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let lineCarry = "";
    let turnDoneCode: number | null = null;
    let stopReason: string | null = null;
    let settled = false;
    let totalTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      totalTimer = null;
      idleTimer = null;
      graceTimer = null;
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      input.signal?.removeEventListener("abort", onAbort);
      killProcessGroup(child.pid);
      resolve({
        exitCode,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        stopReason,
      });
    };

    const stopWith = (reason: string, code: number) => {
      if (settled) return;
      stopReason = reason;
      killProcessGroup(child.pid);
      finish(code);
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (turnDoneCode !== null) return;
      idleTimer = setTimeout(() => {
        stopWith(`no output for ${Math.round(input.idleMs / 1000)}s (idle limit)`, 124);
      }, input.idleMs);
      idleTimer.unref();
    };

    const onAbort = () => stopWith("challenge cancelled", 130);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    totalTimer = setTimeout(() => {
      stopWith(`still running at ${Math.round(input.totalMs / 1000)}s (total limit)`, 124);
    }, input.totalMs);
    totalTimer.unref();
    resetIdle();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      input.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      resetIdle();
      if (turnDoneCode !== null) return;
      const parts = (lineCarry + chunk.toString("utf8")).split("\n");
      lineCarry = parts.pop() ?? "";
      for (const line of parts) {
        const code = extractTurnDoneExitCode(line);
        if (code !== null) {
          turnDoneCode = code;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          graceTimer = setTimeout(() => {
            finish(code);
          }, EXIT_GRACE_MS);
          graceTimer.unref();
          break;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
      resetIdle();
    });

    child.on("close", (code) => {
      const effectiveCode =
        turnDoneCode !== null ? (code && code !== 0 ? code : turnDoneCode) : (code ?? 1);
      finish(effectiveCode);
    });

    child.stdin.on("error", () => {
      // Ignore EPIPE when child closes stdin early.
    });
    if (input.stdinText) child.stdin.write(input.stdinText, "utf8");
    child.stdin.end();
  });
}

function decodeCandidateAnswer(
  invocation: BuiltProviderInvocation,
  run: SpawnRunResult,
): PlaybookChallengeReply | null {
  if (invocation.answerFile && NodeFS.existsSync(invocation.answerFile)) {
    const fileText = NodeFS.readFileSync(invocation.answerFile, "utf8").trim();
    if (fileText) {
      const fromFile = decodeChallengeReplyText(fileText);
      if (fromFile) return fromFile;
    }
  }
  const streamText = extractStreamResultText(run.stdout);
  return decodeChallengeReplyText(streamText) ?? decodeChallengeReplyText(run.stdout);
}

async function resolveCodexAstraModelAsync(input: {
  readonly codexBin: string;
  readonly effort: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly remainingMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const cached = readCachedCodexAstraModel(input.effort, input.env);
  if (cached) return cached;
  const timeoutMs = Math.min(CATALOG_TIMEOUT_MS, input.remainingMs);
  const res = await runCliProcess({
    command: input.codexBin,
    args: ["debug", "models"],
    cwd: input.cwd,
    env: input.env,
    stdinText: "",
    totalMs: timeoutMs,
    idleMs: timeoutMs,
    signal: input.signal,
  });
  if (res.stopReason) throw new Error(`Codex model catalog lookup: ${res.stopReason}`);
  if (res.exitCode !== 0) {
    throw new Error(`Codex model catalog lookup exited with code ${res.exitCode}`);
  }
  return pickLatestAstraFromCatalog(res.stdout, input.effort);
}

/** Build a live CLI ChallengeModel from host-config.json, or null when explicitly disabled. */
export function createCliChallengeModel(env: NodeJS.ProcessEnv): ChallengeModel | null {
  const config = readHostChallengeConfig(env);
  if (config.candidates.length === 0) return null;

  return async ({ cwd, prompt, signal }) => {
    const failures: string[] = [];
    const { totalMs, idleMs: baseIdleMs } = computeChallengeTimeouts(
      prompt.length,
      config.timeoutSec,
    );
    const overallDeadlineMs = Date.now() + totalMs;

    for (let idx = 0; idx < config.candidates.length; idx += 1) {
      const candidate = config.candidates[idx]!;
      if (signal?.aborted) throw new Error("the challenge was cancelled");
      const remainingMs = overallDeadlineMs - Date.now();
      if (remainingMs < 5_000) {
        failures.push(`${candidate.provider}: overall challenge time budget exhausted`);
        break;
      }
      const binary = findProviderBinary(candidate.provider, env);
      if (!binary) {
        failures.push(`${candidate.provider}: executable not found`);
        continue;
      }
      const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-challenge-"));
      try {
        let resolvedCodexModel: string | undefined;
        if (needsCodexAstraLookup(candidate)) {
          resolvedCodexModel = await resolveCodexAstraModelAsync({
            codexBin: binary,
            effort: normalizeCodexEffort(candidate.effort),
            cwd: workDir,
            env,
            remainingMs,
            signal,
          });
        }
        const runRemainingMs = overallDeadlineMs - Date.now();
        if (runRemainingMs < 1_000) {
          failures.push(`${candidate.provider}: overall challenge time budget exhausted`);
          break;
        }
        const invocation = buildProviderInvocation({
          candidate,
          binary,
          cwd,
          prompt,
          workDir,
          env,
          resolvedCodexModel,
        });
        const run = await runCliProcess({
          command: invocation.command,
          args: invocation.args,
          cwd,
          env,
          stdinText: invocation.stdinText,
          totalMs: runRemainingMs,
          idleMs: Math.min(baseIdleMs, runRemainingMs),
          signal,
        });
        if (run.stopReason) {
          failures.push(`${candidate.provider}/${invocation.resolvedModel}: ${run.stopReason}`);
          continue;
        }
        const reply = run.exitCode === 0 ? decodeCandidateAnswer(invocation, run) : null;
        if (reply) {
          return {
            reply,
            reviewer: {
              model: invocation.resolvedModel,
              provider: candidate.provider,
              effort: invocation.resolvedEffort,
            },
            fallbackUsed: idx > 0,
          };
        }
        const errSnippet = (run.stderr || run.stdout).trim().split("\n").slice(-3).join(" ").trim();
        failures.push(
          `${candidate.provider}/${invocation.resolvedModel}: exit ${run.exitCode}${
            errSnippet ? ` (${errSnippet.slice(0, 200)})` : " (invalid challenge reply)"
          }`,
        );
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        failures.push(`${candidate.provider}/${candidate.model || "default"}: ${msg}`);
      } finally {
        NodeFS.rmSync(workDir, { recursive: true, force: true });
      }
    }

    throw new Error(
      failures.length > 0 ? failures.join("; ") : "no playbook_challenge candidate is available",
    );
  };
}
