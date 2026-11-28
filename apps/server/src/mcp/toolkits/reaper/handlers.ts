import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ReaperProposals from "../../../devtools/reaper/ReaperProposals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ReaperToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ReaperToolkit, {
  t3_reaper_propose_rules: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const proposals = yield* ReaperProposals.ReaperProposals;
      return yield* proposals
        .propose({
          rules: input.rules,
          ...(scope.thread === undefined ? {} : { threadId: scope.thread.threadId }),
        })
        .pipe(
          Effect.catchTags({
            ReaperProposalStoreError: (error) =>
              Effect.fail(
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
              ),
          }),
        );
    }),
  ),
});
