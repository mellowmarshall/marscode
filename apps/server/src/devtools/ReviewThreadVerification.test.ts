import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { judgeThreadMessages, verifyReviewThread } from "./ReviewThreadVerification.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const at = "2026-11-27T12:00:00.000Z";
const REVIEW_PROMPT = "Act as the review sub-agent for this task.";

const insertSubagent = (row: {
  readonly id: string;
  readonly parent: string;
  readonly child: string;
  readonly status: string;
  readonly prompt: string;
  readonly result: string;
  readonly completedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
        completed_at, updated_at, payload_json
      ) VALUES (
        ${row.id}, ${row.parent}, 'node-1', 'claudeAgent', ${row.child}, 'delegated', ${row.status},
        ${row.completedAt ?? at}, ${row.completedAt ?? at},
        ${JSON.stringify({ prompt: row.prompt, result: row.result })}
      )
    `;
  });

const insertThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (${threadId}, 'project-1', 'Review', 'codex', 'full-access', 'default', ${at}, ${at}, '{}')
    `;
  });

const insertMessage = (threadId: string, id: string, role: string, text: string, streaming = 0) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${role}, ${streaming}, ${at}, ${at}, ${JSON.stringify({ text })})
    `;
  });

layer("ReviewThreadVerification", (it) => {
  it.effect("verifies a completed delegated review subagent by its child thread", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertSubagent({
        id: "sub-1",
        parent: "thread-submitter",
        child: "thread-review-1",
        status: "completed",
        prompt: REVIEW_PROMPT,
        result: "Verdict: approve\n- [low] nit",
      });
      const ok = yield* verifyReviewThread({
        reviewThreadId: "thread-review-1",
        submitterThreadId: "thread-submitter",
      });
      assert.deepStrictEqual(ok, {
        ok: true,
        threadId: "thread-review-1",
        status: "completed",
        delegatedReview: true,
        source: "subagent",
        reviewText: "Verdict: approve\n- [low] nit\n",
      });
      const own = yield* verifyReviewThread({
        reviewThreadId: "thread-submitter",
        submitterThreadId: "thread-submitter",
      });
      assert.isFalse(own.ok);
    }),
  );

  it.effect("refuses a running review, an implementation subagent and an empty result", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertSubagent({
        id: "sub-run",
        parent: "thread-p",
        child: "thread-running",
        status: "running",
        prompt: REVIEW_PROMPT,
        result: "",
      });
      yield* insertSubagent({
        id: "sub-impl",
        parent: "thread-p",
        child: "thread-impl",
        status: "completed",
        prompt: "Act as the implementation sub-agent for this task.",
        result: "done",
      });
      const running = yield* verifyReviewThread({ reviewThreadId: "thread-running" });
      assert.deepStrictEqual(
        running.ok ? null : running.error,
        "review thread `thread-running` has status `running` (must be completed)",
      );
      const impl = yield* verifyReviewThread({ reviewThreadId: "thread-impl" });
      assert.deepStrictEqual(
        impl.ok ? null : impl.error,
        "review thread `thread-impl` is not a review subagent",
      );
      const bad = yield* verifyReviewThread({ reviewThreadId: "x" });
      assert.deepStrictEqual(bad.ok ? null : bad.error, "invalid thread id `x`");
    }),
  );

  it.effect("finds a submitter's latest completed delegated review", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertSubagent({
        id: "sub-old",
        parent: "thread-sub",
        child: "thread-old",
        status: "completed",
        prompt: REVIEW_PROMPT,
        result: "old review",
        completedAt: "2026-11-26T00:00:00.000Z",
      });
      yield* insertSubagent({
        id: "sub-new",
        parent: "thread-sub",
        child: "thread-new",
        status: "completed",
        prompt: REVIEW_PROMPT,
        result: "new review",
      });
      const latest = yield* verifyReviewThread({ submitterThreadId: "thread-sub" });
      assert.deepStrictEqual(latest.ok ? latest.threadId : latest.error, "thread-new");
      const none = yield* verifyReviewThread({ submitterThreadId: "thread-nobody" });
      assert.isFalse(none.ok);
    }),
  );

  it.effect("falls back to a plain thread's last assistant message", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertThread("thread-plain");
      yield* insertMessage("thread-plain", "m1", "user", "please review");
      yield* insertMessage("thread-plain", "m2", "assistant", "Findings: 1 high");
      const plain = yield* verifyReviewThread({ reviewThreadId: "thread-plain" });
      assert.deepStrictEqual(plain.ok ? [plain.source, plain.reviewText] : plain.error, [
        "thread",
        "Findings: 1 high\n",
      ]);
      const missing = yield* verifyReviewThread({ reviewThreadId: "thread-missing" });
      assert.deepStrictEqual(
        missing.ok ? null : missing.error,
        "review thread `thread-missing` was not found",
      );
    }),
  );

  it("refuses a thread whose latest run is active or whose answer still streams", () => {
    const active = judgeThreadMessages("thread-a", "running", []);
    assert.isFalse(active.ok);
    const streaming = judgeThreadMessages("thread-a", "completed", [
      { role: "assistant", streaming: 1, payload_json: JSON.stringify({ text: "partial" }) },
    ]);
    assert.deepStrictEqual(
      streaming.ok ? null : streaming.error,
      "review thread `thread-a` is still streaming (must be completed)",
    );
  });
});
