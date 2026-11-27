import { describe, expect, it } from "vite-plus/test";

import {
  formatAgentAttribution,
  hasAgentAttribution,
  stampAgentProse,
} from "./githubAttribution.ts";

describe("githubAttribution", () => {
  describe("formatAgentAttribution", () => {
    it("formats full attribution block with displayName, sessionId, and threadId", () => {
      expect(
        formatAgentAttribution({
          displayName: "Fix Login Bug",
          sessionId: "sess-123",
          threadId: "thread-456",
        }),
      ).toBe(
        [
          "Co-authored-by: Fix Login Bug <fix-login-bug@agents.local>",
          "Agent Session: sess-123",
          "Agent Thread: thread-456",
        ].join("\n"),
      );
    });

    it("returns empty string when neither sessionId nor threadId is present", () => {
      expect(formatAgentAttribution({})).toBe("");
      expect(formatAgentAttribution({ displayName: "MarsCode Agent" })).toBe("");
      expect(
        formatAgentAttribution({ displayName: "Agent", sessionId: "   ", threadId: "\n\r" }),
      ).toBe("");
    });

    it("omits Agent Session when sessionId is empty and omits Agent Thread when threadId is empty", () => {
      expect(
        formatAgentAttribution({
          displayName: "Codex",
          threadId: "thread-only",
        }),
      ).toBe(
        ["Co-authored-by: Codex <codex@agents.local>", "Agent Thread: thread-only"].join("\n"),
      );

      expect(
        formatAgentAttribution({
          displayName: "Claude Code",
          sessionId: "session-only",
        }),
      ).toBe(
        [
          "Co-authored-by: Claude Code <claude-code@agents.local>",
          "Agent Session: session-only",
        ].join("\n"),
      );
    });

    it("sanitizes CR, LF, control chars, and angle brackets in displayName and ids", () => {
      const stamp = formatAgentAttribution({
        displayName: "Evil\r\n<attacker@example.com>\x00 Name",
        sessionId: "sess-1\r\nInjected: bad",
        threadId: "thr-2\nMore",
      });
      const lines = stamp.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(
        "Co-authored-by: Evil attacker@example.com Name <evil-attacker-example.com-name@agents.local>",
      );
      expect(lines[1]).toBe("Agent Session: sess-1 Injected: bad");
      expect(lines[2]).toBe("Agent Thread: thr-2 More");
      expect(stamp).not.toContain("\r");
    });

    it("falls back to MarsCode Agent and safe email local when displayName is missing or non-ASCII", () => {
      expect(formatAgentAttribution({ threadId: "thr_99" })).toBe(
        [
          "Co-authored-by: MarsCode Agent <marscode-agent@agents.local>",
          "Agent Thread: thr_99",
        ].join("\n"),
      );
      expect(formatAgentAttribution({ displayName: "日本語", threadId: "thr_99" })).toBe(
        ["Co-authored-by: 日本語 <thr_99@agents.local>", "Agent Thread: thr_99"].join("\n"),
      );
      expect(formatAgentAttribution({ displayName: "🚀", threadId: "!!!" })).toBe(
        ["Co-authored-by: 🚀 <agent@agents.local>", "Agent Thread: !!!"].join("\n"),
      );
    });
  });

  describe("hasAgentAttribution", () => {
    it("detects Co-authored-by @agents.local, Agent Session, and Agent Thread trailers", () => {
      expect(
        hasAgentAttribution(
          "Summary\n\nCo-authored-by: MarsCode Agent <marscode-agent@agents.local>",
        ),
      ).toBe(true);
      expect(hasAgentAttribution("Summary\r\n\r\nAgent Session: sess-1\r\n")).toBe(true);
      expect(hasAgentAttribution("Summary\n\nAgent Thread: thread-1")).toBe(true);
    });

    it("does not false-positive on ordinary prose, human co-authors, or mid-body stray trailer lines", () => {
      expect(hasAgentAttribution("Plain PR description.")).toBe(false);
      expect(
        hasAgentAttribution("Note about Agent Session: handling in the middle of a line."),
      ).toBe(false);
      expect(hasAgentAttribution("Co-authored-by: Human Dev <human@example.com>")).toBe(false);
      expect(hasAgentAttribution("Agent Thread: spoof\n\nActual PR description.")).toBe(false);
      expect(hasAgentAttribution("Intro\nAgent Thread: spoof\nClosing sentence.")).toBe(false);
      expect(hasAgentAttribution("Summary\n\nAgent Thread: spoof\nNot a trailer line")).toBe(false);
      expect(hasAgentAttribution("Summary\nAgent Session: spoof")).toBe(false);
    });
  });

  describe("stampAgentProse", () => {
    const identity = {
      displayName: "Fix Bug",
      sessionId: "sess-1",
      threadId: "thread-1",
    } as const;

    it("appends attribution idempotently", () => {
      const once = stampAgentProse("Implemented the fix.", identity);
      expect(once).toBe(
        [
          "Implemented the fix.",
          "",
          "Co-authored-by: Fix Bug <fix-bug@agents.local>",
          "Agent Session: sess-1",
          "Agent Thread: thread-1",
        ].join("\n"),
      );
      expect(stampAgentProse(once, identity)).toBe(once);
      // Mid-body stray trailer line must not bypass stamping
      const spoofed = "Intro\nAgent Thread: fake\nClosing.";
      expect(stampAgentProse(spoofed, identity)).toBe(
        `${spoofed}\n\n${formatAgentAttribution(identity)}`,
      );
    });

    it("returns body unchanged when identity is empty", () => {
      expect(stampAgentProse("Hello", {})).toBe("Hello");
    });

    it("returns stamp cleanly when body is empty or whitespace-only", () => {
      const expected = formatAgentAttribution(identity);
      expect(stampAgentProse("", identity)).toBe(expected);
      expect(stampAgentProse("   \n\n", identity)).toBe(expected);
    });

    it("enforces GitHub 65536-char limit and custom maxLength without losing the stamp", () => {
      const stamp = formatAgentAttribution(identity);
      const huge = "a".repeat(70_000);
      const stampedDefault = stampAgentProse(huge, identity);
      expect(stampedDefault.length).toBeLessThanOrEqual(65_536);
      expect(stampedDefault.endsWith(stamp)).toBe(true);
      expect(hasAgentAttribution(stampedDefault)).toBe(true);

      const customMax = stamp.length + 12;
      const stampedSmall = stampAgentProse("0123456789abcdef", identity, { maxLength: customMax });
      expect(stampedSmall.length).toBeLessThanOrEqual(customMax);
      expect(stampedSmall.endsWith(stamp)).toBe(true);
      expect(stampedSmall).toContain("...");
    });

    it("avoids splitting UTF-16 surrogate pairs during truncation", () => {
      const stamp = formatAgentAttribution(identity);
      const emojiBody = "😀".repeat(20);
      // Choose an odd budget so naive slice would split a surrogate pair
      const maxLength = stamp.length + 2 + 3 + 5;
      const result = stampAgentProse(emojiBody, identity, { maxLength });
      expect(result.length).toBeLessThanOrEqual(maxLength);
      expect(result.endsWith(stamp)).toBe(true);
      // Verify no unpaired high surrogate remains
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    });
  });
});
