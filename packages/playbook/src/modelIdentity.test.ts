import { describe, expect, it } from "vite-plus/test";

import { classifyModel } from "./modelClassify.ts";
import { normalizeEffort, normalizeModelIdentity } from "./modelIdentity.ts";
import { parseJsonlRecords, parseStructuredReviewText } from "./statsParse.ts";
import { aggregateReviewStats } from "./statsAggregate.ts";

const id = (raw: string) => {
  const { model, effort } = normalizeModelIdentity(raw);
  return `${model}|${effort}`;
};

describe("model identity normalization", () => {
  it("groups spelling, case, separator and effort-suffix variants as one model", () => {
    for (const raw of [
      "model-a-xhigh",
      "model-a (xhigh)",
      "Model A (xhigh)",
      "model a xhigh",
      "model a\nxhigh",
      "MODEL_A_XHIGH",
      "model-a (`xhigh`)",
      "`model-a` (x-high)",
      "vendor/model-a-xhigh",
    ]) {
      expect(id(raw), raw).toBe("model-a|xhigh");
    }
    expect(id("gemini 4 neon")).toBe("gemini-4-neon|");
    expect(id("gemini-4-neon-xhigh")).toBe("gemini-4-neon|xhigh");
    expect(id("gemini-3.8-flash-low")).toBe("gemini-3.8-flash|low");
  });

  it("keeps version dots, drops context tags and leading provider words", () => {
    expect(id("gpt-6.2-astra (medium)")).toBe("gpt-6.2-astra|medium");
    expect(id("model-a[1m]")).toBe("model-a|");
    expect(normalizeModelIdentity("codex model-a")).toEqual({
      model: "model-a",
      effort: "",
      providerHint: "codex",
    });
    expect(id("codex")).toBe("codex|");
  });

  it("spells Anthropic display names as their ids", () => {
    for (const raw of [
      "claude-opus-5-5",
      "Claude Opus 5.5",
      "Opus 5.5",
      "opus-5-5",
      "claude-opus-5-5[1m]",
    ]) {
      expect(id(raw), raw).toBe("claude-opus-5-5|");
    }
    expect(id("Claude Opus 5.5 (high)")).toBe("claude-opus-5-5|high");
    expect(id("claude-opus-5-5-high")).toBe("claude-opus-5-5|high");
  });

  it("rejects review prose instead of using it as a model name", () => {
    for (const raw of [
      "model-a (high), the configured `ship_queue_review` model, reading the diff and neighbouring code with no access to the author's conclusions. Verdict: no blocker",
      "`Model A (high)` on `host-a` (`host-a WSL`)",
      "Model A (`high`) on host-a (`t3-thread://v2/0000/mcp:launch:aaaa`)",
      "model-a (preview)",
      "",
    ]) {
      expect(id(raw), raw).toBe("unknown|");
    }
  });

  it("accepts only known effort levels", () => {
    expect(normalizeEffort("XHigh")).toBe("xhigh");
    expect(normalizeEffort("extra high")).toBe("xhigh");
    expect(normalizeEffort("default")).toBe("");
    expect(normalizeEffort(undefined)).toBe("");
  });

  it("uses a structured effort only when the model text has none, never for unknown", () => {
    expect(classifyModel("model-a", "provider-a", "High")).toMatchObject({
      model: "model-a",
      effort: "high",
    });
    expect(classifyModel("model-a-xhigh", "provider-a", "high").effort).toBe("xhigh");
    expect(classifyModel("", "", "high")).toMatchObject({ model: "unknown", effort: "" });
  });
});

describe("review stats model grouping", () => {
  it("never reads actors from review prose", () => {
    const review = parseStructuredReviewText(
      "Reviewer: model-a (high), the configured `ship_queue_review` model, reading the diff.\nVerdict: no blocker\n- [low] nit",
    );
    expect(review.reviewer.model).toBe("unknown");
    expect(review.submitter.model).toBe("unknown");
    expect(review.verdict).toBe("pass");
  });

  it("groups stored variants of one model into one model with efforts apart", () => {
    const line = (n: number, model: string, effort: string) =>
      JSON.stringify({
        id: `r${n}`,
        source: "ship_queue_review",
        timestamp: "2026-11-20T00:00:00.000Z",
        reviewer: { model, effort, provider: "provider-a" },
        counts: { high: 1 },
      });
    const records = parseJsonlRecords(
      [
        line(1, "model-a", "xhigh"),
        line(2, "model-a-xhigh", ""),
        line(3, "Model A", "XHIGH"),
        line(4, "model a", "high"),
        line(5, "vendor/model-a", "high"),
      ].join("\n"),
    );
    const groups = aggregateReviewStats(records).groups;
    expect(groups.map((g) => [g.model, g.effort, g.reviews])).toEqual([
      ["model-a", "xhigh", 3],
      ["model-a", "high", 2],
    ]);
  });
});
