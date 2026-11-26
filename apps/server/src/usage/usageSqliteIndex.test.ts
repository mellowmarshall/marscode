// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { afterEach, assert, describe, it } from "@effect/vitest";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat, initialCodexScanState } from "../provider/Drivers/codexUsage.ts";
import type { CachedFile } from "./usageScanCache.ts";
import {
  clearArchiveProbeCache,
  isArchivePathCachedOffline,
  runArchiveFsOp,
} from "./usageArchiveFsGuard.ts";
import { buildLiveDuplicateIndex, isCoveredByLiveBackup } from "./usageArchiveScan.ts";
import {
  boundedRealPath,
  listArchiveTranscriptFiles,
  probeArchiveRoot,
} from "./usageArchiveWalk.ts";
import { USAGE_SQLITE_INDEX_FILE, UsageSqliteIndex } from "./usageSqliteIndex.ts";
import { acquireUsageSqliteIndex } from "./usageSqlitePool.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearArchiveProbeCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>> = new Map<
  UsageProviderKind,
  TranscriptUsageFormat<unknown>
>([
  ["claude", claudeUsageFormat],
  ["codex", codexUsageFormat],
]);

describe("UsageSqliteIndex", () => {
  it("persists incremental upserts, atomic archive state, lazy mtime ranges, prune coverage reset, and Antigravity caches", async () => {
    const stateDir = await makeTempDir("usage-sqlite-index");
    const olderEntry: CachedFile = {
      size: 120,
      mtimeMs: Date.parse("2026-03-10T10:00:00Z"),
      provider: "claude",
      records: [
        {
          provider: "claude",
          timestampMs: Date.parse("2026-03-10T10:00:00Z"),
          model: "claude-opus-5-5",
          sessionId: "s-old",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 500,
            cacheCreationTokens: 50,
            outputTokens: 25,
            reasoningTokens: 0,
          },
          cacheCreation1hTokens: 20,
          reportedCostUsd: 0.12,
          speed: "fast",
          dedupeKey: "msg1:req1",
        },
      ],
      tailRecords: [],
      malformedRecords: [],
      position: { resumeOffset: 120, guardLength: 0, guardHash: 0, state: null },
    };
    const codexState = initialCodexScanState();
    codexState.model = "gpt-6-astra";
    codexState.sessionId = "s-new";
    const newerEntry: CachedFile = {
      size: 240,
      mtimeMs: Date.parse("2026-11-10T10:00:00Z"),
      provider: "codex",
      records: [
        {
          provider: "codex",
          timestampMs: Date.parse("2026-11-10T10:00:00Z"),
          model: "gpt-6-astra",
          sessionId: "s-new",
          totals: {
            uncachedInputTokens: 300,
            cachedInputTokens: 1000,
            cacheCreationTokens: 0,
            outputTokens: 80,
            reasoningTokens: 40,
          },
          reportedCostUsd: null,
          speed: "standard",
          unresolvedServiceTierTurnId: "turn-1",
          dedupeKey: null,
        },
      ],
      tailRecords: [],
      malformedRecords: [Date.parse("2026-11-10T09:59:00Z")],
      position: { resumeOffset: 200, guardLength: 16, guardHash: 42, state: codexState },
    };

    const first = new UsageSqliteIndex(stateDir);
    first.flushTranscriptChanges({
      upserts: new Map([
        ["/archive/old.jsonl", olderEntry],
        ["/live/new.jsonl", newerEntry],
      ]),
      deletes: new Set(),
      archiveDirs: [
        {
          provider: "claude",
          dirPath: "/archive",
          rootDir: "/archive",
          dirMtimeMs: Date.parse("2026-03-10T10:00:00Z"),
          coveredSinceMs: 0,
          childSubdirs: [],
          complete: true,
        },
      ],
      archiveRoots: [
        {
          provider: "claude",
          rootDir: "/archive",
          coveredSinceMs: 0,
          lastScannedMs: Date.parse("2026-11-10T10:00:00Z"),
          complete: true,
        },
      ],
      sources: { "claude\0/archive": { dir: "/archive", volumeId: "1:2" } },
      coveredSince: { "claude\0/archive": 0 },
    });
    first.saveAntigravityChanges({
      upserts: new Map([
        [
          "/ag/conv.db",
          {
            fingerprint: "100:200:300/-",
            data: {
              candidates: [
                {
                  record: {
                    provider: "antigravity",
                    timestampMs: Date.parse("2026-11-10T10:00:00Z"),
                    model: "gemini-4-neon",
                    sessionId: "conv",
                    totals: {
                      uncachedInputTokens: 10,
                      cachedInputTokens: 20,
                      cacheCreationTokens: 0,
                      outputTokens: 30,
                      reasoningTokens: 5,
                    },
                    reportedCostUsd: null,
                    speed: "standard",
                    dedupeKey: "antigravity:11:abc",
                  },
                  modelId: 1537,
                  modelQuality: 4,
                  keys: ["antigravity:11:abc"],
                  timestampQuality: 2,
                },
              ],
              models: new Map([[1537, "gemini-4-neon"]]),
            },
          },
        ],
      ]),
      deletes: new Set(),
      updatedAtMs: Date.parse("2026-11-10T10:00:00Z"),
    });
    first.close();

    assert.isTrue(NodeFS.existsSync(NodePath.join(stateDir, USAGE_SQLITE_INDEX_FILE)));

    const reopened = new UsageSqliteIndex(stateDir);
    try {
      const meta = reopened.loadMeta();
      assert.deepStrictEqual(meta.sources, {
        "claude\0/archive": { dir: "/archive", volumeId: "1:2" },
      });

      const recent = reopened.loadFilesRange(formats, Date.parse("2026-09-01T00:00:00Z"), Infinity);
      assert.deepStrictEqual(
        recent.map((r) => r.path),
        ["/live/new.jsonl"],
      );
      assert.strictEqual(recent[0]?.entry.records[0]?.unresolvedServiceTierTurnId, "turn-1");

      const older = reopened.loadFilesRange(formats, 0, Date.parse("2026-09-01T00:00:00Z"));
      assert.deepStrictEqual(
        older.map((r) => r.path),
        ["/archive/old.jsonl"],
      );
      assert.strictEqual(older[0]?.entry.records[0]?.cacheCreation1hTokens, 20);

      const ag = reopened.loadAntigravityCache();
      assert.strictEqual(ag.get("/ag/conv.db")?.fingerprint, "100:200:300/-");
      assert.strictEqual(ag.get("/ag/conv.db")?.data?.models.get(1537), "gemini-4-neon");

      // Prune deletes older files AND raises archive covered_since_ms so widening retention re-scans.
      const cutoff = Date.parse("2026-06-01T00:00:00Z");
      const pruned = reopened.pruneFilesBefore(cutoff);
      assert.strictEqual(pruned, 1);
      assert.isUndefined(reopened.getFile("/archive/old.jsonl", formats));
      assert.isDefined(reopened.getFile("/live/new.jsonl", formats));
      assert.strictEqual(
        reopened.getArchiveRootState("claude", "/archive")?.coveredSinceMs,
        cutoff,
      );
      assert.strictEqual(
        reopened.loadArchiveDirStates("claude", "/archive").get("/archive")?.coveredSinceMs,
        cutoff,
      );
    } finally {
      reopened.close();
    }
  });

  it("self-heals undecodable archive rows by invalidating their archive directory state and refuses newer schema versions", async () => {
    const stateDir = await makeTempDir("usage-sqlite-corrupt-row");
    const dbPath = NodePath.join(stateDir, USAGE_SQLITE_INDEX_FILE);
    const index = new UsageSqliteIndex(stateDir);
    index.flushTranscriptChanges({
      upserts: new Map(),
      deletes: new Set(),
      archiveDirs: [
        {
          provider: "claude",
          dirPath: "/archive/proj",
          rootDir: "/archive",
          dirMtimeMs: 1000,
          coveredSinceMs: 0,
          childSubdirs: [],
          complete: true,
        },
      ],
      archiveRoots: [
        {
          provider: "claude",
          rootDir: "/archive",
          coveredSinceMs: 0,
          lastScannedMs: 2000,
          complete: true,
        },
      ],
      sources: {},
      coveredSince: {},
    });
    index.close();

    // Inject an undecodable row directly into usage_files.
    const rawDb = new NodeSqlite.DatabaseSync(dbPath);
    rawDb
      .prepare(
        "INSERT INTO usage_files (path, provider, size, mtime_ms, order_idx, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("/archive/proj/bad.jsonl", "claude", 10, 5000, 1, Buffer.from("not-zstd"));
    rawDb.close();

    const reopened = new UsageSqliteIndex(stateDir);
    try {
      let corruptNotified = false;
      const loaded = reopened.loadFilesRange(formats, 0, Infinity, () => {
        corruptNotified = true;
      });
      assert.strictEqual(loaded.length, 0);
      assert.isTrue(corruptNotified);
      assert.strictEqual(reopened.getMaxOrderIdx(), 0);
      assert.strictEqual(
        reopened.loadArchiveDirStates("claude", "/archive").get("/archive/proj")?.complete,
        false,
      );
      assert.strictEqual(reopened.getArchiveRootState("claude", "/archive")?.complete, false);
      assert.deepStrictEqual(reopened.loadMeta().coveredSince, {});
    } finally {
      reopened.close();
    }

    // A future schema version must throw rather than silently downgrading or deleting the DB.
    const futureDb = new NodeSqlite.DatabaseSync(dbPath);
    futureDb.exec("PRAGMA user_version = 99;");
    futureDb.close();
    assert.throws(() => new UsageSqliteIndex(stateDir), /Unsupported usage index schema version/);
    assert.isTrue(NodeFS.existsSync(dbPath));
  });
});

describe("listArchiveTranscriptFiles & live backup deduplication", () => {
  it("skips unchanged archive directories past the mtime safety margin, re-walks modified dirs, and honors forceWalk", async () => {
    const root = await makeTempDir("usage-archive-walk");
    const day1 = NodePath.join(root, "2026", "02", "16");
    const day2 = NodePath.join(root, "2026", "02", "17");
    await NodeFSP.mkdir(day1, { recursive: true });
    await NodeFSP.mkdir(day2, { recursive: true });
    const f1 = NodePath.join(day1, "rollout-1.jsonl");
    const f2 = NodePath.join(day2, "rollout-2.jsonl");
    await NodeFSP.writeFile(f1, "{}\n");
    await NodeFSP.writeFile(f2, "{}\n");
    const oldTime = new Date("2026-02-16T00:00:00Z");
    for (const dir of [
      root,
      NodePath.join(root, "2026"),
      NodePath.join(root, "2026", "02"),
      day1,
      day2,
    ]) {
      await NodeFSP.utimes(dir, oldTime, oldTime);
    }

    const nowMs = Date.parse("2026-06-01T00:00:00Z");
    const probe = await probeArchiveRoot(root, { nowMs });
    assert.isTrue(probe.accessible);
    const missingProbe = await probeArchiveRoot(NodePath.join(root, "does-not-exist"), { nowMs });
    assert.deepStrictEqual(missingProbe, { accessible: false, reason: "missing" });

    // Dangling symlink root reports offline and caches the broken ancestor for sibling subdirs.
    const brokenLink = NodePath.join(root, "broken-link");
    await NodeFSP.symlink(NodePath.join(root, "unmounted-target"), brokenLink);
    const offlineProbe = await probeArchiveRoot(NodePath.join(brokenLink, "claude"), { nowMs });
    assert.deepStrictEqual(offlineProbe, { accessible: false, reason: "offline" });
    assert.isTrue(isArchivePathCachedOffline(NodePath.join(brokenLink, "codex"), nowMs));
    assert.isUndefined(await boundedRealPath(NodePath.join(brokenLink, "codex"), { nowMs }));
    await NodeFSP.unlink(brokenLink);

    // Healthy symlink root with an absent leaf subdir reports missing (not offline).
    const healthyLink = NodePath.join(root, "healthy-link");
    await NodeFSP.symlink(root, healthyLink);
    const missingLeafProbe = await probeArchiveRoot(NodePath.join(healthyLink, "absent-subdir"), {
      nowMs,
    });
    assert.deepStrictEqual(missingLeafProbe, { accessible: false, reason: "missing" });
    assert.isFalse(isArchivePathCachedOffline(NodePath.join(healthyLink, "absent-subdir"), nowMs));
    await NodeFSP.unlink(healthyLink);
    await NodeFSP.utimes(root, oldTime, oldTime);

    const first = await listArchiveTranscriptFiles({
      provider: "codex",
      root,
      sinceMs: 0,
      knownDirs: new Map(),
      nowMs,
    });
    assert.strictEqual(first.files.length, 2);
    assert.strictEqual(first.skippedDirs, 0);

    const known = new Map(first.updatedDirs.map((dir) => [dir.dirPath, dir]));

    // Second walk skips every unchanged directory past the 5s mtime safety margin.
    const second = await listArchiveTranscriptFiles({
      provider: "codex",
      root,
      sinceMs: 0,
      knownDirs: known,
      nowMs,
    });
    assert.strictEqual(second.files.length, 0);
    assert.strictEqual(second.walkedDirs, 0);
    assert.strictEqual(second.skippedDirs, known.size);

    // Explicit refresh (forceWalk=true) bypasses dir-mtime skipping.
    const forced = await listArchiveTranscriptFiles({
      provider: "codex",
      root,
      sinceMs: 0,
      knownDirs: known,
      nowMs,
      forceWalk: true,
    });
    assert.strictEqual(forced.files.length, 2);
    assert.strictEqual(forced.skippedDirs, 0);

    // Adding a file to day2 bumps day2's mtime: only day2 is re-walked.
    await NodeFSP.writeFile(NodePath.join(day2, "rollout-3.jsonl"), "{}\n");
    const bumped = new Date("2026-05-01T00:00:00Z");
    await NodeFSP.utimes(day2, bumped, bumped);

    const third = await listArchiveTranscriptFiles({
      provider: "codex",
      root,
      sinceMs: 0,
      knownDirs: known,
      nowMs,
    });
    assert.strictEqual(third.walkedDirs, 1);
    assert.strictEqual(third.skippedDirs, known.size - 1);
    assert.deepStrictEqual(third.files.map((file) => NodePath.basename(file.path)).toSorted(), [
      "rollout-2.jsonl",
      "rollout-3.jsonl",
    ]);
  });

  it("skips redundant SMB backup copies already indexed from live directories while reading larger archive files", () => {
    const fileCache = new Map<string, CachedFile>([
      [
        "/live/claude/proj/abc.jsonl",
        {
          size: 1000,
          mtimeMs: 50_000,
          provider: "claude",
          records: [],
          tailRecords: [],
          malformedRecords: [],
          position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
        },
      ],
      [
        "/live/codex/2026/10/01/rollout-1.jsonl",
        {
          size: 2000,
          mtimeMs: 50_000,
          provider: "codex",
          records: [],
          tailRecords: [],
          malformedRecords: [],
          position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
        },
      ],
    ]);
    const liveIndex = buildLiveDuplicateIndex(
      fileCache,
      new Map<UsageProviderKind, readonly string[]>([
        ["claude", ["/live/claude"]],
        ["codex", ["/live/codex"]],
      ]),
    );
    assert.isTrue(
      isCoveredByLiveBackup(
        "claude",
        "/archive/claude",
        { path: "/archive/claude/proj/abc.jsonl", size: 1000, mtimeMs: 50_000 },
        liveIndex,
      ),
    );
    assert.isTrue(
      isCoveredByLiveBackup(
        "claude",
        "/archive/claude",
        { path: "/archive/claude/projects/proj/abc.jsonl", size: 1000, mtimeMs: 50_000 },
        liveIndex,
      ),
    );
    assert.isFalse(
      isCoveredByLiveBackup(
        "claude",
        "/archive/claude",
        { path: "/archive/claude/proj/abc.jsonl", size: 1500, mtimeMs: 50_000 },
        liveIndex,
      ),
    );
    assert.isTrue(
      isCoveredByLiveBackup(
        "codex",
        "/archive/codex",
        { path: "/archive/codex/2026/10/01/rollout-1.jsonl", size: 2000, mtimeMs: 50_000 },
        liveIndex,
      ),
    );
    assert.isFalse(
      isCoveredByLiveBackup(
        "codex",
        "/archive/codex",
        { path: "/archive/codex/2026/02/16/rollout-old.jsonl", size: 500, mtimeMs: 10_000 },
        liveIndex,
      ),
    );
  });

  it("holds archive FS slots until timed-out ops settle and detaches replaced shared SQLite handles without closing active holders", async () => {
    let releaseStuck1!: () => void;
    let releaseStuck2!: () => void;
    let thirdStarted = false;
    const stuck1 = runArchiveFsOp(
      () =>
        new Promise<void>((resolve) => {
          releaseStuck1 = resolve;
        }),
      20,
      "stuck1",
    );
    const stuck2 = runArchiveFsOp(
      () =>
        new Promise<void>((resolve) => {
          releaseStuck2 = resolve;
        }),
      20,
      "stuck2",
    );
    await Promise.allSettled([stuck1, stuck2]);

    // Both slots remain occupied by the stuck OS ops; a 3rd caller times out waiting without starting.
    const third = await runArchiveFsOp(
      async () => {
        thirdStarted = true;
      },
      20,
      "third",
    ).catch((err: unknown) => err);
    assert.isFalse(thirdStarted);
    assert.instanceOf(third, Error);

    // Once the stuck ops actually settle, slots are freed on the microtask queue and subsequent ops run normally.
    releaseStuck1();
    releaseStuck2();
    await Promise.resolve();
    const after = await runArchiveFsOp(async () => 42, 100, "after");
    assert.strictEqual(after, 42);

    // Shared SQLite handle: replacing the DB file detaches the stale entry without closing active holders.
    const stateDir = await makeTempDir("usage-sqlite-shared");
    const first = acquireUsageSqliteIndex(stateDir);
    const second = acquireUsageSqliteIndex(stateDir);
    assert.strictEqual(first.index, second.index);
    for (const suffix of ["", "-wal", "-shm"]) {
      await NodeFSP.rm(NodePath.join(stateDir, `${USAGE_SQLITE_INDEX_FILE}${suffix}`), {
        force: true,
      });
    }
    const replacement = acquireUsageSqliteIndex(stateDir);
    assert.notStrictEqual(replacement.index, first.index);
    // Active holders remain usable until the last release closes the detached index.
    assert.strictEqual(first.index.getMaxOrderIdx(), 0);
    first.release();
    assert.strictEqual(second.index.getMaxOrderIdx(), 0);
    second.release();
    assert.strictEqual(first.index.loadFilesRange(formats, 0, Infinity).length, 0);
    replacement.release();
  });
});
