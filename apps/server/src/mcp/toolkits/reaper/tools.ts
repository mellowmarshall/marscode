import {
  OrchestratorMcpFailure,
  ReaperProposeRulesInput,
  ReaperProposeRulesResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ReaperProposals from "../../../devtools/reaper/ReaperProposals.ts";
import { REAPER_PROPOSE_TOOL } from "../../../devtools/reaper/ReaperReviewPrompt.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ReaperToolkit = Toolkit.make(
  Tool.make(REAPER_PROPOSE_TOOL, {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      ReaperProposals.ReaperProposals,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
    description:
      "Propose cleanup rules for this machine's Reaper, at the end of a storage cleanup review. Nothing is deleted: each rule waits until the user accepts it in the Reaper tab. Propose only regenerable directories (build caches, temp, merged worktree leftovers), never a repo root, history, live database, or user data. The result lists rules refused by the path checks, with reasons.",
    parameters: ReaperProposeRulesInput,
    success: ReaperProposeRulesResult,
  }).annotate(Tool.Destructive, false),
);
