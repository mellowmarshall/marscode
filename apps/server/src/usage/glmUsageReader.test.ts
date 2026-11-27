// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  glmRateModel,
  makeGlmUsageCache,
  normalizeGlmModel,
  readGlmUsage,
} from "./glmUsageReader.ts";
import { parseRateTable, priceUsage } from "./usagePricing.ts";
import { UsageSqliteIndex } from "./usageSqliteIndex.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-glm-usage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function createStateV2Schema(db: NodeSqlite.DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT,
      provider_instance_id TEXT, model TEXT, updated_at TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER,
      provider TEXT, provider_instance_id TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
      provider TEXT, provider_thread_id TEXT, provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, provider_thread_id TEXT,
      ordinal INTEGER, run_attempt_id TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT
    );
  `);
}

describe("glmUsageReader", () => {
  it("normalizes GLM model names and maps first-party zai rate models", () => {
    expect(normalizeGlmModel("GLM-5.3")).toBe("glm-5.3");
    expect(normalizeGlmModel("builtin:zai-coding-plan/GLM-5.3-Flash")).toBe("glm-5.3-flash");
    expect(normalizeGlmModel("zai/GLM-5.2")).toBe("glm-5.2");
    expect(glmRateModel("GLM-5.3")).toBe("zai/glm-5.3");
    expect(glmRateModel("glm-5.3-flash")).toBe("zai/glm-5.3-flash");
    expect(glmRateModel("unknown")).toBe("unknown");

    const rates = parseRateTable({
      "zai/glm-5.3": {
        input_cost_per_token: 1.4e-6,
        output_cost_per_token: 4.4e-6,
        cache_read_input_token_cost: 2.6e-7,
      },
      "reseller/glm-5.3": {
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 9.0e-6,
      },
    });
    const priced = priceUsage(rates, {
      model: "glm-5.3",
      rateModel: glmRateModel("GLM-5.3"),
      totals: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
    });
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(1.4 + 0.26 + 4.4, 6);
  });

  it("reads ZCode db.sqlite messages and model_usage without double-counting or non-GLM spillover", () => {
    const root = makeTempDir();
    const zcodeDbPath = NodePath.join(root, ".zcode", "cli", "db", "db.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(zcodeDbPath), { recursive: true });

    const db = new NodeSqlite.DatabaseSync(zcodeDbPath);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY, assistant_message_id TEXT, session_id TEXT, provider_id TEXT,
        model_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
        provider_total_tokens INTEGER, computed_total_tokens INTEGER
      );
    `);

    const ts1 = Date.parse("2026-09-01T12:00:00Z");
    const ts2 = Date.parse("2026-10-27T12:00:00Z");
    const ts3 = Date.parse("2026-10-27T13:00:00Z");

    const insertMsg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    insertMsg.run(
      "msg-1",
      "sess-1",
      ts1,
      JSON.stringify({
        role: "assistant",
        providerID: "builtin:zai-coding-plan",
        modelID: "GLM-5.3-Flash",
        cost: 0,
        tokens: {
          total: 14_482,
          input: 14_293,
          output: 189,
          reasoning: 0,
          cache: { read: 11_712, write: 0 },
        },
      }),
    );
    insertMsg.run(
      "msg-2",
      "sess-2",
      ts2,
      JSON.stringify({
        role: "assistant",
        providerID: "zai",
        modelID: "GLM-5.3",
        cost: 0,
        tokens: {
          total: 50_500,
          input: 50_000,
          output: 500,
          reasoning: 100,
          cache: { read: 40_000, write: 0 },
        },
      }),
    );
    // Non-GLM model/provider in ZCode must be ignored.
    insertMsg.run(
      "msg-claude",
      "sess-2",
      ts2,
      JSON.stringify({
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-opus-5-5",
        cost: 0,
        tokens: { total: 5_000, input: 4_000, output: 1_000, cache: { read: 0, write: 0 } },
      }),
    );

    // Duplicate of msg-2 in model_usage is skipped; orphan mu-2 uses zcode:msg:<assistant_message_id>.
    const insertMu = db.prepare(
      "INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertMu.run(
      "mu-1",
      "msg-2",
      "sess-2",
      "zai",
      "GLM-5.3",
      "completed",
      ts2,
      ts2,
      50_000,
      500,
      100,
      0,
      40_000,
      50_500,
      50_500,
    );
    insertMu.run(
      "mu-2",
      "msg-orphan",
      "sess-2",
      "zai",
      "GLM-5.3",
      "completed",
      ts3,
      ts3,
      10_000,
      200,
      0,
      0,
      8_000,
      10_200,
      10_200,
    );
    insertMu.run(
      "mu-err",
      "msg-err",
      "sess-2",
      "zai",
      "GLM-5.3",
      "error",
      ts3,
      ts3,
      1_000,
      0,
      0,
      0,
      0,
      1_000,
      1_000,
    );
    db.close();

    const cache = makeGlmUsageCache();
    const scans = readGlmUsage({
      homeDir: root,
      stateDir: NodePath.join(root, "state"),
      environment: {},
      windowStartMs: 0,
      cache,
    });

    expect(scans).toHaveLength(1);
    const records = scans[0]!.files![0]!.records;
    expect(records).toHaveLength(3);

    expect(records[0]).toMatchObject({
      provider: "glm",
      model: "glm-5.3-flash",
      rateModel: "zai/glm-5.3-flash",
      sessionId: "sess-1",
      reportedCostUsd: null,
      dedupeKey: "zcode:msg:msg-1",
      totals: {
        uncachedInputTokens: 14_293 - 11_712,
        cachedInputTokens: 11_712,
        cacheCreationTokens: 0,
        outputTokens: 189,
        reasoningTokens: 0,
      },
    });
    expect(records[1]).toMatchObject({
      model: "glm-5.3",
      dedupeKey: "zcode:msg:msg-2",
    });
    expect(records[2]).toMatchObject({
      model: "glm-5.3",
      dedupeKey: "zcode:msg:msg-orphan",
      totals: {
        uncachedInputTokens: 2_000,
        cachedInputTokens: 8_000,
        cacheCreationTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
      },
    });

    // Window filter uses cache without losing older entries for later wider queries.
    const narrow = readGlmUsage({
      homeDir: root,
      stateDir: NodePath.join(root, "state"),
      environment: {},
      windowStartMs: Date.parse("2026-10-01T00:00:00Z"),
      cache,
    });
    expect(narrow[0]!.files![0]!.records).toHaveLength(2);
  });

  it("joins via run_attempts, handles retried attempts, and excludes non-GLM turns even when ordinals overlap", () => {
    const root = makeTempDir();
    const stateDir = NodePath.join(root, "state");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const stateDbPath = NodePath.join(stateDir, "statev2.sqlite");

    const db = new NodeSqlite.DatabaseSync(stateDbPath);
    createStateV2Schema(db);

    const insertSession = db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertSession.run(
      "ps-glm",
      "thread-mixed",
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      "glm-5.3-flash",
      "2026-11-14T10:02:00Z",
    );
    insertSession.run(
      "ps-agy",
      "thread-mixed",
      "antigravity",
      "antigravity",
      "gemini-4-neon",
      "2026-11-14T12:00:00Z",
    );
    // Claude Code instance named "claude-glm" routed to a GLM model must NOT be counted as GLM.
    insertSession.run(
      "ps-claude-glm",
      "thread-mixed",
      "claudeAgent",
      "claude-glm",
      "glm-5.3",
      "2026-11-14T13:00:00Z",
    );
    insertSession.run(
      "ps-claude-glm-solo",
      "thread-claude-glm-only",
      "claudeAgent",
      "claude-glm",
      "glm-5.3",
      "2026-11-14T14:00:00Z",
    );

    const insertRun = db.prepare(
      "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?)",
    );
    // GLM runs have ordinals 1..2; retried attempt (attempt-glm-1a) is NOT activeAttemptId.
    insertRun.run(
      "run-glm-1",
      "thread-mixed",
      1,
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      JSON.stringify({
        activeAttemptId: "attempt-glm-1b",
        providerInstanceId: "acpRegistry_glm_agent",
        modelSelection: { model: "glm-5.3-flash" },
      }),
    );
    // Antigravity run has ordinal 9, while its provider turn has ordinal 1 (colliding with run-glm-1!).
    insertRun.run(
      "run-agy-9",
      "thread-mixed",
      9,
      "antigravity",
      "antigravity",
      JSON.stringify({
        activeAttemptId: "attempt-agy-9",
        providerInstanceId: "antigravity",
        modelSelection: { model: "gemini-4-neon" },
      }),
    );
    // Claude Code instance named "claude-glm" routed to a GLM model must NOT be counted as GLM.
    insertRun.run(
      "run-claude-10",
      "thread-mixed",
      10,
      "claudeAgent",
      "claude-glm",
      JSON.stringify({
        activeAttemptId: "attempt-claude-10",
        providerInstanceId: "claude-glm",
        modelSelection: { model: "glm-5.3" },
      }),
    );

    const insertAttempt = db.prepare(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertAttempt.run(
      "attempt-glm-1a",
      "thread-mixed",
      "run-glm-1",
      "acpRegistry_glm_agent",
      "pt-glm",
      "acpRegistry_glm_agent",
    );
    insertAttempt.run(
      "attempt-glm-1b",
      "thread-mixed",
      "run-glm-1",
      "acpRegistry_glm_agent",
      "pt-glm",
      "acpRegistry_glm_agent",
    );
    insertAttempt.run(
      "attempt-agy-9",
      "thread-mixed",
      "run-agy-9",
      "antigravity",
      "pt-agy",
      "antigravity",
    );
    insertAttempt.run(
      "attempt-claude-10",
      "thread-mixed",
      "run-claude-10",
      "claudeAgent",
      "pt-claude",
      "claude-glm",
    );

    const insertTurn = db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Retried attempt turn (attempt-glm-1a) must still be counted!
    insertTurn.run(
      "turn-glm-retry",
      "thread-mixed",
      "pt-glm",
      1,
      "attempt-glm-1a",
      "2026-11-14T10:00:00.000Z",
      "2026-11-14T10:01:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 168_206,
          cachedInputTokens: 136_512,
          outputTokens: 6_677,
          reasoningTokens: 5_052,
        },
      }),
    );
    // Antigravity turn with ordinal=1 (collides with GLM run ordinal=1) and missing attempt must NOT match GLM!
    insertTurn.run(
      "turn-agy-1",
      "thread-mixed",
      "pt-agy",
      1,
      "attempt-agy-missing",
      "2026-11-14T11:00:00.000Z",
      "2026-11-14T11:02:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 999_999,
          cachedInputTokens: 900_000,
          outputTokens: 12_345,
        },
      }),
    );
    // Antigravity turn with matching attempt-agy-9 must NOT match GLM.
    insertTurn.run(
      "turn-agy-2",
      "thread-mixed",
      "pt-agy",
      2,
      "attempt-agy-9",
      "2026-11-14T11:05:00.000Z",
      "2026-11-14T11:06:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 500_000,
          cachedInputTokens: 400_000,
          outputTokens: 2_000,
        },
      }),
    );
    // Claude run using model "glm-5.3" must NOT match GLM.
    insertTurn.run(
      "turn-claude-glm-model",
      "thread-mixed",
      "pt-claude",
      1,
      "attempt-claude-10",
      "2026-11-14T12:00:00.000Z",
      "2026-11-14T12:01:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 777_777,
          cachedInputTokens: 700_000,
          outputTokens: 3_000,
        },
      }),
    );
    // Partial/incomplete turn must be skipped.
    insertTurn.run(
      "turn-glm-partial",
      "thread-mixed",
      "pt-glm",
      2,
      "attempt-glm-1b",
      "2026-11-14T10:02:00.000Z",
      "2026-11-14T10:03:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "partial",
          inputTokens: 10_000,
          outputTokens: 100,
        },
      }),
    );
    // Local command turn must NOT be counted as model usage.
    insertTurn.run(
      "turn-glm-local-cmd",
      "thread-mixed",
      "pt-glm",
      3,
      "attempt-glm-1b",
      "2026-11-14T10:04:00.000Z",
      "2026-11-14T10:04:05.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          localCommand: true,
          inputTokens: 50_000,
          outputTokens: 500,
        },
      }),
    );
    db.close();

    const cache = makeGlmUsageCache();
    const scans = readGlmUsage({
      homeDir: root,
      stateDir,
      environment: {},
      windowStartMs: 0,
      cache,
    });

    expect(scans).toHaveLength(1);
    const records = scans[0]!.files![0]!.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "glm",
      model: "glm-5.3-flash",
      rateModel: "zai/glm-5.3-flash",
      sessionId: "thread-mixed",
      dedupeKey: "t3:glm:turn:turn-glm-retry",
      totals: {
        uncachedInputTokens: 168_206 - 136_512,
        cachedInputTokens: 136_512,
        cacheCreationTokens: 0,
        outputTokens: 6_677,
        reasoningTokens: 5_052,
      },
    });
  });

  it("keeps cached records on transient read error and leaves missing model unpriced", () => {
    const root = makeTempDir();
    const stateDir = NodePath.join(root, "state");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const stateDbPath = NodePath.join(stateDir, "statev2.sqlite");

    const db = new NodeSqlite.DatabaseSync(stateDbPath);
    createStateV2Schema(db);
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "ps-1",
      "thread-1",
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      "",
      "2026-11-15T00:00:00Z",
    );
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-1",
      "thread-1",
      1,
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      JSON.stringify({ providerInstanceId: "acpRegistry_glm_agent" }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "attempt-1",
      "thread-1",
      "run-1",
      "acpRegistry_glm_agent",
      "pt-1",
      "acpRegistry_glm_agent",
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "turn-1",
      "thread-1",
      "pt-1",
      1,
      "attempt-1",
      "2026-11-15T00:00:00.000Z",
      "2026-11-15T00:01:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 10_000,
          outputTokens: 500,
        },
      }),
    );
    db.close();

    const cache = makeGlmUsageCache();
    const first = readGlmUsage({
      homeDir: root,
      stateDir,
      environment: {},
      windowStartMs: 0,
      cache,
    });
    expect(first[0]!.files![0]!.records[0]).toMatchObject({
      model: "unknown",
    });
    expect(first[0]!.files![0]!.records[0]!.rateModel).toBeUndefined();

    // Corrupt DB bytes to simulate unreadable DB after caching: should retain prior records as partial.
    NodeFS.writeFileSync(stateDbPath, "not-a-sqlite-file-at-all");
    const second = readGlmUsage({
      homeDir: root,
      stateDir,
      environment: {},
      windowStartMs: 0,
      cache,
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.status).toBe("partial");
    expect(second[0]!.files![0]!.records).toHaveLength(1);
  });

  it("persists ACP GLM turns durably in UsageSqliteIndex so deleted threads keep history across restarts", () => {
    const root = makeTempDir();
    const stateDir = NodePath.join(root, "state");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const stateDbPath = NodePath.join(stateDir, "statev2.sqlite");

    const db = new NodeSqlite.DatabaseSync(stateDbPath);
    createStateV2Schema(db);
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "ps-del",
      "thread-deleted",
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      "glm-5.3",
      "2026-11-17T10:00:00Z",
    );
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-del",
      "thread-deleted",
      1,
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      JSON.stringify({
        providerInstanceId: "acpRegistry_glm_agent",
        modelSelection: { model: "glm-5.3" },
      }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "attempt-del",
      "thread-deleted",
      "run-del",
      "acpRegistry_glm_agent",
      "pt-del",
      "acpRegistry_glm_agent",
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "turn-del-1",
      "thread-deleted",
      "pt-del",
      1,
      "attempt-del",
      "2026-11-17T10:00:00.000Z",
      "2026-11-17T10:05:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1_200_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 5_000,
          reasoningTokens: 1_500,
        },
      }),
    );
    db.close();

    const index = new UsageSqliteIndex(stateDir);
    try {
      const initial = readGlmUsage({
        homeDir: root,
        stateDir,
        environment: {},
        windowStartMs: 0,
        retentionCutoffMs: 0,
        nowMs: Date.parse("2026-11-17T12:00:00Z"),
        sqliteIndex: index,
        cache: makeGlmUsageCache(),
      });
      expect(initial).toHaveLength(1);
      expect(initial[0]!.files![0]!.records).toHaveLength(1);

      // Delete the thread from statev2.sqlite and simulate a server restart with a fresh cache.
      const dbDel = new NodeSqlite.DatabaseSync(stateDbPath);
      dbDel.exec(`
        DELETE FROM orchestration_v2_projection_provider_turns;
        DELETE FROM orchestration_v2_projection_run_attempts;
        DELETE FROM orchestration_v2_projection_runs;
        DELETE FROM orchestration_v2_projection_provider_sessions;
      `);
      dbDel.close();

      const afterDelete = readGlmUsage({
        homeDir: root,
        stateDir,
        environment: {},
        windowStartMs: 0,
        retentionCutoffMs: 0,
        nowMs: Date.parse("2026-11-18T12:00:00Z"),
        sqliteIndex: index,
        cache: makeGlmUsageCache(),
      });
      expect(afterDelete).toHaveLength(1);
      expect(afterDelete[0]!.status).toBe("ok");
      expect(afterDelete[0]!.files![0]!.records).toHaveLength(1);
      expect(afterDelete[0]!.files![0]!.records[0]).toMatchObject({
        provider: "glm",
        model: "glm-5.3",
        rateModel: "zai/glm-5.3",
        sessionId: "thread-deleted",
        dedupeKey: "t3:glm:turn:turn-del-1",
        totals: {
          uncachedInputTokens: 200_000,
          cachedInputTokens: 1_000_000,
          cacheCreationTokens: 0,
          outputTokens: 5_000,
          reasoningTokens: 1_500,
        },
      });

      // Unlimited retention (0) keeps durable turns; finite cutoff prunes older durable turns.
      expect(index.pruneFilesBefore(0)).toBe(0);
      expect(index.loadAcpTurns("glm", 0)).toHaveLength(1);
      expect(index.pruneFilesBefore(Date.parse("2026-11-20T00:00:00Z"))).toBe(1);
      expect(index.loadAcpTurns("glm", 0)).toHaveLength(0);
    } finally {
      index.close();
    }
  });

  it("re-persists older turns when retention widens from finite to unlimited or when the SQLite index handle changes", () => {
    const root = makeTempDir();
    const stateDir = NodePath.join(root, "state");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const stateDbPath = NodePath.join(stateDir, "statev2.sqlite");

    const db = new NodeSqlite.DatabaseSync(stateDbPath);
    createStateV2Schema(db);
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "ps-old",
      "thread-old",
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      "glm-5.3",
      "2026-06-01T10:00:00Z",
    );
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-old",
      "thread-old",
      1,
      "acpRegistry_glm_agent",
      "acpRegistry_glm_agent",
      JSON.stringify({
        providerInstanceId: "acpRegistry_glm_agent",
        modelSelection: { model: "glm-5.3" },
      }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "attempt-old",
      "thread-old",
      "run-old",
      "acpRegistry_glm_agent",
      "pt-old",
      "acpRegistry_glm_agent",
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "turn-old-1",
      "thread-old",
      "pt-old",
      1,
      "attempt-old",
      "2026-06-01T10:00:00.000Z",
      "2026-06-01T10:01:00.000Z",
      JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 25_000,
          cachedInputTokens: 20_000,
          outputTokens: 1_000,
        },
      }),
    );
    db.close();

    const cache = makeGlmUsageCache();
    const index1 = new UsageSqliteIndex(stateDir);
    try {
      // First scan with 92-day cutoff skips persisting the older June turn.
      readGlmUsage({
        homeDir: root,
        stateDir,
        environment: {},
        windowStartMs: 0,
        retentionCutoffMs: Date.parse("2026-08-25T00:00:00Z"),
        nowMs: Date.parse("2026-11-25T00:00:00Z"),
        sqliteIndex: index1,
        cache,
      });
      expect(index1.loadAcpTurns("glm", 0)).toHaveLength(0);

      // Widening retention to unlimited on the same cache MUST persist the older June turn!
      readGlmUsage({
        homeDir: root,
        stateDir,
        environment: {},
        windowStartMs: 0,
        retentionCutoffMs: 0,
        nowMs: Date.parse("2026-11-25T00:01:00Z"),
        sqliteIndex: index1,
        cache,
      });
      expect(index1.loadAcpTurns("glm", 0)).toHaveLength(1);
    } finally {
      index1.close();
    }

    // Reopening a fresh SQLite DB (e.g. after corruption reset) on the same cache MUST re-persist!
    for (const suffix of ["", "-wal", "-shm"]) {
      NodeFS.rmSync(NodePath.join(stateDir, `usage-index-v1.sqlite${suffix}`), { force: true });
    }
    const index2 = new UsageSqliteIndex(stateDir);
    try {
      readGlmUsage({
        homeDir: root,
        stateDir,
        environment: {},
        windowStartMs: 0,
        retentionCutoffMs: 0,
        nowMs: Date.parse("2026-11-25T00:02:00Z"),
        sqliteIndex: index2,
        cache,
      });
      expect(index2.loadAcpTurns("glm", 0)).toHaveLength(1);
    } finally {
      index2.close();
    }
  });

  it("returns empty array when neither ZCode DB nor GLM state exists", () => {
    const root = makeTempDir();
    const scans = readGlmUsage({
      homeDir: root,
      stateDir: NodePath.join(root, "state"),
      environment: {},
      windowStartMs: 0,
      cache: makeGlmUsageCache(),
    });
    expect(scans).toEqual([]);
  });
});
