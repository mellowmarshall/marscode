/**
 * Structured review extraction for `t3 thread show --json`.
 * Composes directly with `ReviewStatsThreads.ts` (`isDelegatedReviewSubagent`)
 * and `ReviewThreadVerification.ts` (`judgeThreadMessages`) with zero duplication.
 */
import type { OrchestratorMcpThreadDetail } from "@t3tools/contracts";

import { isDelegatedReviewSubagent } from "../devtools/ReviewStatsThreads.ts";
import {
  judgeThreadMessages,
  type MessageRow,
  type ReviewThreadVerification,
} from "../devtools/ReviewThreadVerification.ts";

export interface ThreadShowMessage {
  readonly role: "assistant" | "system" | "user";
  readonly runId: string | null;
  readonly text: string;
}

export interface ThreadShowJsonPayload {
  readonly thread: OrchestratorMcpThreadDetail;
  readonly status: OrchestratorMcpThreadDetail["status"];
  readonly isDelegatedReviewSubagent: boolean;
  readonly finalReviewText: string | null;
  readonly reviewVerification: ReviewThreadVerification;
  readonly messages: ReadonlyArray<ThreadShowMessage>;
  readonly error: string | null;
}

/** Build the structured JSON payload for `t3 thread show --json`. */
export function buildThreadShowJsonPayload(input: {
  readonly thread: OrchestratorMcpThreadDetail;
  readonly messages: ReadonlyArray<ThreadShowMessage>;
  readonly initialPromptText: string | null;
  readonly error: string | null;
}): ThreadShowJsonPayload {
  const promptText =
    input.initialPromptText ??
    input.messages.find((message) => message.role === "user")?.text ??
    "";
  const delegatedReview =
    input.thread.relationshipToParent === "subagent" && isDelegatedReviewSubagent(promptText);
  const status = input.thread.status;
  let reviewVerification: ReviewThreadVerification;
  if (status !== "completed") {
    reviewVerification = {
      ok: false,
      threadId: input.thread.threadId,
      error: `review thread \`${input.thread.threadId}\` has status \`${status}\` (must be completed)`,
    };
  } else {
    const newestFirstRows: ReadonlyArray<MessageRow> = [...input.messages]
      .reverse()
      .map((message) => ({
        role: message.role,
        streaming: false,
        payload_json: JSON.stringify({ text: message.text }),
      }));
    const baseVerdict = judgeThreadMessages(input.thread.threadId, status, newestFirstRows);
    reviewVerification = baseVerdict.ok
      ? {
          ...baseVerdict,
          delegatedReview,
          source: input.thread.relationshipToParent === "subagent" ? "subagent" : "thread",
        }
      : baseVerdict;
  }
  return {
    thread: input.thread,
    status: input.thread.status,
    isDelegatedReviewSubagent: delegatedReview,
    finalReviewText: reviewVerification.ok ? reviewVerification.reviewText : null,
    reviewVerification,
    messages: input.messages,
    error: input.error,
  };
}
