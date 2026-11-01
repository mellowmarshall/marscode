import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  rewriteAntigravityStepPayloadRunningStatus,
  sanitizeAntigravityConversationDb,
} from "./AntigravitySessionFiles.ts";

describe("rewriteAntigravityStepPayloadRunningStatus", () => {
  it("rewrites top-level field 4 non-terminal statuses (1, 2, 8, 9, 11) to 6 while preserving other fields", () => {
    for (const nonTerminal of [1, 2, 8, 9, 11]) {
      const input = Uint8Array.from([
        0x08,
        0x63,
        0x20,
        nonTerminal,
        0x2a,
        0x05,
        0x61,
        0x62,
        0x63,
        0x20,
        nonTerminal,
      ]);
      const rewritten = rewriteAntigravityStepPayloadRunningStatus(input);
      expect(rewritten.changed).toBe(true);
      expect(Array.from(rewritten.payload)).toEqual([
        0x08,
        0x63,
        0x20,
        0x06,
        0x2a,
        0x05,
        0x61,
        0x62,
        0x63,
        0x20,
        nonTerminal,
      ]);
    }
  });

  it("leaves terminal steps untouched", () => {
    for (const terminal of [3, 6, 7, 12]) {
      const step = Uint8Array.from([0x08, 0x01, 0x20, terminal]);
      const rewritten = rewriteAntigravityStepPayloadRunningStatus(step);
      expect(rewritten.changed).toBe(false);
      expect(rewritten.payload).toBe(step);
    }
  });
});

it.layer(NodeServices.layer)("sanitizeAntigravityConversationDb", (it) => {
  it.effect("cancels orphaned non-terminal steps in a conversation sqlite db before resume", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-antigravity-sanitize-",
      });
      const sessionId = "b237e36f-fea1-4fa2-9245-a4d790b3d94f";
      const conversationsDir = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversationsDir, { recursive: true });
      const dbPath = path.join(conversationsDir, `${sessionId}.db`);

      const runningPayload = Uint8Array.from([0x08, 0x07, 0x20, 0x02]);
      const generatingPayload = Uint8Array.from([0x08, 0x0f, 0x20, 0x08]);
      const completedPayload = Uint8Array.from([0x08, 0x08, 0x20, 0x03]);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          "CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)",
        );
        yield* sql.unsafe(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, has_subtrajectory NUMERIC NOT NULL DEFAULT false, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0)",
        );
        yield* sql.unsafe(
          "INSERT INTO steps (idx, step_type, status, step_payload, step_format) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
          [7, 14, 2, runningPayload, 0, 8, 15, 3, completedPayload, 0, 9, 15, 8, generatingPayload, 0],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);

      yield* sanitizeAntigravityConversationDb({ profileDirectory, sessionId });

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{
          readonly idx: number;
          readonly status: number;
          readonly step_payload: Uint8Array;
        }>("SELECT idx, status, step_payload FROM steps ORDER BY idx ASC");
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
        Effect.scoped,
      );

      expect(rows).toHaveLength(3);
      expect(rows[0]?.status).toBe(6);
      expect(Array.from(rows[0]?.step_payload ?? [])).toEqual([0x08, 0x07, 0x20, 0x06]);
      expect(rows[1]?.status).toBe(3);
      expect(Array.from(rows[1]?.step_payload ?? [])).toEqual([0x08, 0x08, 0x20, 0x03]);
      expect(rows[2]?.status).toBe(6);
      expect(Array.from(rows[2]?.step_payload ?? [])).toEqual([0x08, 0x0f, 0x20, 0x06]);
    }),
  );
});
