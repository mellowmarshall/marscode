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

  it("lets a structured effort win and keeps the name whole when one exists", () => {
    expect(classifyModel("model-a", "provider-a", "High")).toMatchObject({
      model: "model-a",
      effort: "high",
    });
    expect(classifyModel("model-a-xhigh", "provider-a", "high")).toMatchObject({
      model: "model-a-xhigh",
      effort: "high",
    });
    expect(classifyModel("model-a (xhigh)", "provider-a", "high")).toMatchObject({
      model: "model-a",
      effort: "high",
    });
    expect(classifyModel("model-a-xhigh", "provider-a")).toMatchObject({
      model: "model-a",
      effort: "xhigh",
    });
    expect(classifyModel("", "", "high")).toMatchObject({ model: "unknown", effort: "" });
  });

  it("keeps -max where it is part of the model id", () => {
    expect(id("gpt-5.1-codex-max")).toBe("gpt-5.1-codex-max|");
    expect(id("gpt-5-codex-max")).toBe("gpt-5-codex-max|");
    expect(id("gpt-5-codex-max-high")).toBe("gpt-5-codex-max|high");
    expect(normalizeModelIdentity("gpt-5.1-codex-max", "xhigh")).toMatchObject({
      model: "gpt-5.1-codex-max",
      effort: "xhigh",
    });
    expect(id("model-a-max")).toBe("model-a|max");
  });

  it("ignores default and context notes and accepts tagged ids", () => {
    expect(id("model-a (default)")).toBe("model-a|");
    expect(id("model-a (1M context)")).toBe("model-a|");
    expect(id("model-a (200k context window) (high)")).toBe("model-a|high");
    expect(id("Claude Opus 5.5 (1M context)")).toBe("claude-opus-5-5|");
    expect(id("qwen3-coder:480b")).toBe("qwen3-coder:480b|");
    expect(id("anthropic.claude-opus-4-1-20250805-v1:0")).toBe(
      "anthropic.claude-opus-4-1-20250805-v1:0|",
    );
    expect(id("model-a the configured review model for host-a")).toBe("unknown|");
  });
});

describe("review stats model grouping", () => {
  it("keeps clean Reviewer lines and turns prose ones into unknown", () => {
    const prose = parseStructuredReviewText(
      "Reviewer: model-a (high), the configured `ship_queue_review` model, reading the diff.\nVerdict: no blocker\n- [low] nit",
    );
    expect(prose.reviewer.model).toBe("unknown");
    expect(prose.submitter.model).toBe("unknown");
    expect(prose.verdict).toBe("pass");

    const clean = parseStructuredReviewText(
      "## Review\n\nReviewer:       claude-opus-5-5 (medium)\n- Submitter: `Model A (xhigh)`\nVerdict: approve\n",
    );
    expect(clean.reviewer).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    expect(clean.submitter).toMatchObject({ model: "model-a", effort: "xhigh" });
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
