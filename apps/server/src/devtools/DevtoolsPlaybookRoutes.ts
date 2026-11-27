/**
 * DevTools' playbook routes, in-process on @t3tools/playbook (no shell-out): the declaration
 * view, `check`/`doctor`, the declaration challenge, and review-thread verification for ship-queue.
 */
import { normalizeExceptions, repoBypasses } from "@t3tools/playbook/bypass";
import type { ChallengeOutcome } from "@t3tools/playbook/challenger";
import { ALL_GATE_NAMES, runCheck, type CheckReport } from "@t3tools/playbook/checks";
import { loadDeclaration } from "@t3tools/playbook/declaration";
import { readPlaybookDeclaration } from "@t3tools/playbook/declarationSummary";
import { repoName, repoRoot } from "@t3tools/playbook/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import type { GuardRouteHelpers } from "./DevtoolsGuardRoutes.ts";
import type { GuardGrantBroker } from "./GuardGrantBroker.ts";
import { prepareServerChallenge } from "./PlaybookChallengeService.ts";
import { PlaybookRunFlights } from "./PlaybookRunFlights.ts";
import { verifyReviewThread } from "./ReviewThreadVerification.ts";

const MAX_CONTRACTS = 32;
const CHECK_TIMEOUT_MS = 120_000;
/** Above two candidates at the 900 s challenge_timeout_s cap, so the model limit fires first. */
const CHALLENGE_TIMEOUT_MS = 35 * 60_000;
const checkFlights = new PlaybookRunFlights<CheckReport>(CHECK_TIMEOUT_MS, 4);
const challengeFlights = new PlaybookRunFlights<ChallengeOutcome>(CHALLENGE_TIMEOUT_MS, 2);

function flightRefusal(
  kind: "timeout" | "busy" | "aborted",
  what: string,
  helpers: GuardRouteHelpers,
): HttpServerResponse.HttpServerResponse {
  if (kind === "timeout") return helpers.jsonResponse({ error: `${what} timed out` }, 504);
  if (kind === "busy") return helpers.jsonResponse({ error: `too many ${what} runs at once` }, 429);
  return helpers.jsonResponse({ error: `${what} was cancelled` }, 499);
}
const KNOWN_CONTRACTS: ReadonlySet<string> = new Set(ALL_GATE_NAMES);

export function validatePlaybookRequest(input: {
  readonly mode: unknown;
  readonly contracts: unknown;
}):
  | {
      readonly ok: true;
      readonly mode: "check" | "doctor";
      readonly contracts: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: string } {
  if (input.mode !== "check" && input.mode !== "doctor") {
    return { ok: false, error: "mode must be 'check' or 'doctor'" };
  }
  if (input.contracts === undefined) return { ok: true, mode: input.mode, contracts: [] };
  if (!Array.isArray(input.contracts)) {
    return { ok: false, error: "contracts must be an array of contract names" };
  }
  if (input.contracts.length > MAX_CONTRACTS) {
    return { ok: false, error: `contracts exceeds maximum of ${MAX_CONTRACTS}` };
  }
  if (input.mode === "doctor" && input.contracts.length > 0) {
    return { ok: false, error: "contracts cannot be specified with mode 'doctor'" };
  }
  for (const item of input.contracts) {
    if (typeof item !== "string" || !KNOWN_CONTRACTS.has(item)) {
      return { ok: false, error: `Invalid contract name: ${String(item)}` };
    }
  }
  return { ok: true, mode: input.mode, contracts: input.contracts as ReadonlyArray<string> };
}

/** The registered T3 workspace REPODIR, or the response refusing it. */
const assertWorkspace = Effect.fn("DevtoolsPlaybookRoutes.assertWorkspace")(function* (
  repoDir: string,
  helpers: GuardRouteHelpers,
) {
  const pathSvc = yield* Path.Path;
  if (!repoDir || !pathSvc.isAbsolute(repoDir)) {
    return helpers.jsonResponse({ error: "repoDir must be an absolute path" }, 400);
  }
  const knownWorkspaces = yield* Effect.serviceOption(KnownWorkspaces.KnownWorkspaces);
  if (Option.isNone(knownWorkspaces)) {
    return helpers.jsonResponse({ error: "Workspace validation unavailable" }, 503);
  }
  const allowed = yield* knownWorkspaces.value.assertContains(repoDir).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return allowed
    ? null
    : helpers.jsonResponse({ error: "Repository directory is not a registered T3 workspace" }, 403);
});

export const handlePlaybookRoute = Effect.fn("DevtoolsPlaybookRoutes.handle")(function* (
  method: "GET" | "POST",
  subPath: string,
  url: URL,
  broker: GuardGrantBroker,
  helpers: GuardRouteHelpers,
): Effect.fn.Return<
  HttpServerResponse.HttpServerResponse | null,
  never,
  HttpServerRequest.HttpServerRequest | Path.Path
> {
  const { jsonResponse } = helpers;
  if (method === "GET" && subPath === "/playbook/declaration") {
    const repoDir = (url.searchParams.get("repoDir") ?? "").trim();
    const refused = yield* assertWorkspace(repoDir, helpers);
    if (refused) return refused;
    return jsonResponse(
      readPlaybookDeclaration(repoDir, normalizeExceptions(broker.readExceptions())),
    );
  }

  if (method === "POST" && (subPath === "/playbook/run" || subPath === "/playbook/challenge")) {
    const parsed = yield* helpers.readJsonBody;
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const repoDir = typeof body.repoDir === "string" ? body.repoDir.trim() : "";
    const validated =
      subPath === "/playbook/run"
        ? validatePlaybookRequest({ mode: body.mode, contracts: body.contracts })
        : null;
    if (validated && !validated.ok) return jsonResponse({ error: validated.error }, 400);
    const refused = yield* assertWorkspace(repoDir, helpers);
    if (refused) return refused;
    const root = repoRoot(repoDir);
    const exceptions = broker.readExceptions().entries;
    if (validated?.ok && validated.mode === "doctor") {
      const decl = loadDeclaration(root);
      const ok = decl.errors.length === 0;
      return jsonResponse({ ok, exitCode: ok ? 0 : 1, data: decl, error: decl.errors[0] ?? null });
    }
    if (validated?.ok) {
      const today = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      const prBody = typeof body.prBody === "string" ? body.prBody : null;
      const key = [root, validated.contracts.join(","), prBody ?? ""].join("\0");
      const flight = yield* Effect.promise((signal) =>
        checkFlights.run(
          key,
          (runSignal) =>
            runCheck({
              root,
              repo: repoName(root),
              contracts: validated.contracts,
              body: prBody,
              bypasses: repoBypasses(exceptions, repoName(root)),
              today,
              signal: runSignal,
            }),
          signal,
        ),
      );
      if (flight.kind !== "done") return flightRefusal(flight.kind, "playbook check", helpers);
      const report = flight.value;
      return jsonResponse({ ok: report.exitCode === 0, exitCode: report.exitCode, data: report });
    }
    const textGeneration = yield* Effect.serviceOption(TextGeneration.TextGeneration);
    if (Option.isNone(textGeneration)) {
      return jsonResponse({ error: "Text generation unavailable" }, 503);
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const request = {
      repoDir: root,
      exceptions,
      base: str(body.base),
      tip: str(body.tip),
      advisory: body.advisory === true,
      threadId: str(body.threadId),
    };
    const prepared = yield* prepareServerChallenge(request).pipe(
      Effect.provideService(TextGeneration.TextGeneration, textGeneration.value),
    );
    const key = [root, request.base ?? "", request.tip ?? "", String(request.advisory)].join("\0");
    const flight = yield* Effect.promise((signal) =>
      challengeFlights.run(key, prepared.run, signal),
    );
    if (flight.kind !== "done") return flightRefusal(flight.kind, "playbook challenge", helpers);
    return jsonResponse({ outcome: flight.value, plan: prepared.plan });
  }

  if (method === "GET" && subPath === "/review-threads/verify") {
    const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOpt)) return jsonResponse({ error: "Thread store unavailable" }, 503);
    const verdict = yield* verifyReviewThread({
      reviewThreadId: url.searchParams.get("threadId") ?? undefined,
      submitterThreadId: url.searchParams.get("submitterThreadId") ?? undefined,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false as const,
          threadId: null,
          error: `thread store read failed: ${String(cause)}`,
        }),
      ),
    );
    return jsonResponse(verdict, verdict.ok ? 200 : 404);
  }

  return null;
});
