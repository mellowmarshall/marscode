// @effect-diagnostics nodeBuiltinImport:off - Review-stats store tests over temp state directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { classifyModel } from "./modelClassify.ts";
import { aggregateReviewStats, sortRecordsNewestFirst } from "./statsAggregate.ts";
import {
  challengeRecordFromJson,
  parseAdversarialReviewCounts,
  parseStructuredReviewText,
} from "./statsParse.ts";
import {
  appendReviewStatRecord,
  collectReviewRecords,
  reviewStatsWriteGeneration,
} from "./statsStore.ts";
import type { ReviewStatRecord } from "./statsTypes.ts";
import { cleanupTempDirs, makeTempDir } from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const record = (over: Partial<ReviewStatRecord>): ReviewStatRecord => ({
  id: "x",
  source: "ship_queue_review",
  timestamp: "2026-11-20T00:00:00.000Z",
  repo: "sample-repo",
  branch: "feat/a",
  commit: "",
  worktree: "",
  threadId: "",
  reviewThreadId: "",
  verdict: "pass",
  reviewer: classifyModel("claude-opus-5-5", "claudeAgent"),
  submitter: classifyModel("gpt-6-astra (high)"),
  counts: { breaking: 0, critical: 0, high: 1, medium: 0, low: 2, info: 0, total: 3 },
  bypassDetected: false,
  playbookFriction: false,
  rejectedRisesCount: 0,
  fallbackUsed: false,
  durationS: null,
  ...over,
});

describe("review text parsing", () => {
  it("counts findings from prose, fenced code excluded, explicit summary lines winning", () => {
    expect(
      parseAdversarialReviewCounts(
        "- [high] a\n- medium: b\n```\n- [high] not counted\n```\nH1: c\n",
      ).total,
    ).toBe(3);
    expect(parseAdversarialReviewCounts("Findings: 2 high, 1 low\n- [high] ignored").total).toBe(3);
  });

  it("reads verdicts from JSON or markdown, actors from JSON only", () => {
    const md = parseStructuredReviewText(
      "Reviewer: claude-opus-5-5\nVerdict: REQUEST CHANGES\n- [high] x",
    );
    expect(md).toMatchObject({ verdict: "fail", reviewer: { model: "unknown" } });
    const json = parseStructuredReviewText(
      JSON.stringify({
        reviewer: { model: "gpt-6-astra", effort: "medium" },
        verdict: "approve",
        findings: [],
      }),
    );
    expect(json).toMatchObject({
      verdict: "pass",
      reviewer: { family: "Astra", effort: "medium" },
    });
  });

  it("maps a challenge record's verdict from acceptance and rejected rises", () => {
    const base = { timestamp: "2026-11-01T00:00:00Z", reviewer: "gpt-6-astra (medium)" };
    expect(challengeRecordFromJson({ ...base, acceptable: true }, "r", "f")?.verdict).toBe("pass");
    expect(
      challengeRecordFromJson(
        { ...base, acceptable: false, rejected_rises: [{ subject: "x" }] },
        "r",
        "f",
      )?.verdict,
    ).toBe("rejected_budget");
    expect(challengeRecordFromJson({ ...base, reviewer: "owner-bypass" }, "r", "f")?.verdict).toBe(
      "bypassed",
    );
    expect(challengeRecordFromJson({ acceptable: true }, "r", "f")).toBeNull();
  });
});

describe("review stats store", () => {
  it("appends a record once, bumps the write generation and reads it back", () => {
    const dir = makeTempDir("pb-stats-");
    const jsonlPath = NodePath.join(dir, "devtools", "review-stats.jsonl");
    const before = reviewStatsWriteGeneration();
    expect(appendReviewStatRecord(record({ id: "ship:1" }), jsonlPath)).toBe(true);
    expect(appendReviewStatRecord(record({ id: "ship:1" }), jsonlPath)).toBe(false);
    expect(reviewStatsWriteGeneration()).toBe(before + 1);
    const paths = {
      playbookStateDir: NodePath.join(dir, "pb"),
      shipJobsDir: NodePath.join(dir, "jobs"),
      jsonlPath,
    };
    expect(collectReviewRecords(paths).map((r) => r.id)).toEqual(["ship:1"]);
  });

  it("merges a delegated review thread into the ship job that names it", () => {
    const dir = makeTempDir("pb-stats-");
    const job = NodePath.join(dir, "jobs", "42");
    NodeFS.mkdirSync(job, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(job, "adversarial-review.md"),
      "Verdict: approve\n- [low] nit\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(job, "job.json"),
      JSON.stringify({
        repo: "sample-repo",
        submitted_at: "2026-11-02T00:00:00Z",
        review_thread_id: "thread-r1",
      }),
    );
    const live = record({ id: "t3-review:thread-r1", reviewThreadId: "thread-r1", durationS: 12 });
    const records = collectReviewRecords(
      {
        playbookStateDir: NodePath.join(dir, "pb"),
        shipJobsDir: NodePath.join(dir, "jobs"),
        jsonlPath: NodePath.join(dir, "x.jsonl"),
      },
      [live],
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "ship:42",
      durationS: 12,
      reviewer: { family: "Opus" },
    });
  });
});

describe("review stats aggregation", () => {
  const records = sortRecordsNewestFirst([
    record({ id: "a", timestamp: "2026-11-20T00:00:00.000Z" }),
    record({ id: "b", timestamp: "2026-10-01T00:00:00.000Z", verdict: "fail" }),
    record({ id: "c", timestamp: "2026-11-21T00:00:00.000Z", verdict: "bypassed" }),
  ]);

  it("sorts newest first and drops bypasses unless asked", () => {
    expect(records.map((r) => r.id)).toEqual(["c", "a", "b"]);
    const stats = aggregateReviewStats(records, { localHostName: "hosta.lan" });
    expect(stats.totals).toMatchObject({ reviews: 2, passed: 1, flagged: 1, total: 6 });
    expect(stats.facets.hosts).toEqual(["hosta"]);
    expect(aggregateReviewStats(records, { includeBypasses: true }).totals.reviews).toBe(3);
  });

  it("counts `days` back from the caller's clock only", () => {
    const nowMs = Date.parse("2026-11-27T00:00:00.000Z");
    expect(aggregateReviewStats(records, { days: 30, nowMs }).totals.reviews).toBe(1);
    expect(aggregateReviewStats(records, { days: 30 }).totals.reviews).toBe(2);
  });

  it("groups by submitter and pairs", () => {
    const bySubmitter = aggregateReviewStats(records, { side: "submitter", by: "family" });
    expect(bySubmitter.groups.map((g) => g.key)).toEqual(["Astra"]);
    const pairs = aggregateReviewStats(records, { side: "pair" });
    expect(pairs.groups[0]?.key).toBe("gpt-6-astra (high) → claude-opus-5-5");
  });
});
