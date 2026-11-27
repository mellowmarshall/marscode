import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { stampAgentProse } from "@t3tools/shared/githubAttribution";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

/**
 * Stamps GitHub/forge prose produced by a MarsCode MCP tool call with the calling
 * agent thread's attribution trailer block. Human UI paths (`ws.ts`) never call this.
 */
export const stampMcpGitHubProse = Effect.fn("McpGitHubAttribution.stamp")(function* (
  body: string,
  knownThread?: Pick<OrchestrationV2ThreadShell, "id" | "title"> | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const engine = yield* Orchestrator.OrchestratorV2;
  let thread = knownThread;
  if (thread === undefined && scope.thread !== undefined) {
    thread =
      (yield* engine
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.orElseSucceed(() => null))) ?? undefined;
  }

  const threadId = thread?.id ?? scope.thread?.threadId ?? scope.client?.senderThread?.threadId;
  const sessionId = scope.thread?.providerSessionId ?? scope.client?.sessionId;
  const displayName =
    thread?.title?.trim() ||
    scope.client?.senderThread?.title?.trim() ||
    scope.client?.label?.trim() ||
    "MarsCode Agent";

  return stampAgentProse(body, {
    displayName,
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
  });
});
