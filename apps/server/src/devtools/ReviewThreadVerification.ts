/**
 * Adversarial review thread verification for ship-queue: whether a thread (or
 * the latest delegated review of a submitter thread) is a completed review
 * with output, read from the server's own projection through its SqlClient,
 * so ship-queue asks the server instead of opening statev2.sqlite.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { isDelegatedReviewSubagent } from "./ReviewStatsThreads.ts";

const SAFE_THREAD_ID_RE = /^[A-Za-z0-9%:_.-]{4,256}$/;
const ACTIVE_RUN_STATUSES = new Set(["running", "starting", "queued", "preparing", "waiting"]);

export type ReviewThreadVerification =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly status: "completed";
      readonly delegatedReview: boolean;
      readonly source: "subagent" | "thread";
      readonly reviewText: string;
    }
  | { readonly ok: false; readonly threadId: string | null; readonly error: string };

export interface SubagentRow {
  readonly child_thread_id: string | null;
  readonly status: string | null;
  readonly payload_json: string | null;
}

export interface MessageRow {
  readonly role: string | null;
  readonly streaming: number | boolean | null;
  readonly payload_json: string | null;
}

function parseJson(text: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(text ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const fail = (threadId: string | null, error: string): ReviewThreadVerification => ({
  ok: false,
  threadId,
  error,
});

/** The verdict on a subagent projection row found for THREADID. */
function judgeSubagentRow(threadId: string, row: SubagentRow): ReviewThreadVerification {
  const cid = row.child_thread_id || threadId;
  if (row.status !== "completed") {
    return fail(
      cid,
      `review thread \`${cid}\` has status \`${row.status || "unknown"}\` (must be completed)`,
    );
  }
  const payload = parseJson(row.payload_json);
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trimStart() : "";
  if (prompt.startsWith("Act as the ") && !isDelegatedReviewSubagent(prompt)) {
    return fail(cid, `review thread \`${cid}\` is not a review subagent`);
  }
  const result = typeof payload.result === "string" ? payload.result.trim() : "";
  if (!result) return fail(cid, `review thread \`${cid}\` has no review output`);
  return {
    ok: true,
    threadId: cid,
    status: "completed",
    delegatedReview: isDelegatedReviewSubagent(prompt),
    source: "subagent",
    reviewText: `${result}\n`,
  };
}

/** The verdict on a plain thread from its latest run status and messages (newest first). */
export function judgeThreadMessages(
  threadId: string,
  latestRunStatus: string | null,
  messages: ReadonlyArray<MessageRow>,
): ReviewThreadVerification {
  if (latestRunStatus && ACTIVE_RUN_STATUSES.has(latestRunStatus.toLowerCase())) {
    return fail(
      threadId,
      `review thread \`${threadId}\` has status \`${latestRunStatus}\` (must be completed)`,
    );
  }
  for (const message of messages) {
    const payload = parseJson(message.payload_json);
    const role = String(message.role ?? payload.role ?? payload.createdBy ?? "").toLowerCase();
    if (role !== "assistant" && role !== "agent") continue;
    if (Boolean(message.streaming) || payload.streaming === true) {
      return fail(threadId, `review thread \`${threadId}\` is still streaming (must be completed)`);
    }
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text) {
      return {
        ok: true,
        threadId,
        status: "completed",
        delegatedReview: false,
        source: "thread",
        reviewText: `${text}\n`,
      };
    }
  }
  return fail(threadId, `review thread \`${threadId}\` has no assistant review output`);
}

/** Verify REVIEWTHREADID, or find SUBMITTERTHREADID's latest completed delegated review. */
export const verifyReviewThread = Effect.fn("ReviewThreadVerification.verify")(function* (input: {
  readonly reviewThreadId?: string | undefined;
  readonly submitterThreadId?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const reviewId = input.reviewThreadId?.trim() ?? "";
  const submitterId = input.submitterThreadId?.trim() ?? "";
  for (const id of [reviewId, submitterId]) {
    if (id && !SAFE_THREAD_ID_RE.test(id)) return fail(null, `invalid thread id \`${id}\``);
  }
  if (!reviewId) {
    if (!submitterId) return fail(null, "pass a review thread id or a submitter thread id");
    const rows = yield* sql<{ readonly child_thread_id: string; readonly payload_json: string }>`
      SELECT child_thread_id, payload_json FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${submitterId} AND status = 'completed' AND child_thread_id IS NOT NULL
        AND child_thread_id != ${submitterId}
        AND json_extract(payload_json, '$.prompt') LIKE 'Act as the review sub-agent%'
      ORDER BY completed_at DESC, updated_at DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return fail(null, `thread \`${submitterId}\` has no completed delegated review`);
    return judgeSubagentRow(row.child_thread_id, { ...row, status: "completed" });
  }
  if (submitterId && reviewId === submitterId) {
    return fail(
      reviewId,
      `review thread \`${reviewId}\` is the submitter's own thread; pass an independent review thread`,
    );
  }
  const subagents = yield* sql<SubagentRow>`
    SELECT child_thread_id, status, payload_json FROM orchestration_v2_projection_subagents
    WHERE child_thread_id = ${reviewId} OR subagent_id = ${reviewId}
    ORDER BY updated_at DESC LIMIT 1
  `;
  if (subagents[0]) return judgeSubagentRow(reviewId, subagents[0]);
  const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE thread_id = ${reviewId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!threads[0]) return fail(reviewId, `review thread \`${reviewId}\` was not found`);
  const runs = yield* sql<{ readonly status: string }>`
    SELECT status FROM orchestration_v2_projection_runs
    WHERE thread_id = ${reviewId} ORDER BY ordinal DESC LIMIT 1
  `;
  const messages = yield* sql<MessageRow>`
    SELECT role, streaming, payload_json FROM orchestration_v2_projection_messages
    WHERE thread_id = ${reviewId} ORDER BY created_at DESC, message_id DESC LIMIT 10
  `;
  return judgeThreadMessages(reviewId, runs[0]?.status ?? null, messages);
});
