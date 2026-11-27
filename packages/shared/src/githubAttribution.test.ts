import { describe, expect, it } from "vite-plus/test";

import {
  formatAgentAttribution,
  hasAgentAttribution,
  stampAgentProse,
  type AgentAttributionIdentity,
} from "./githubAttribution.ts";

const PRIVATE = { audience: "private" } as const;
const PUBLIC = { audience: "public" } as const;
const formatPrivate = (identity: AgentAttributionIdentity) =>
  formatAgentAttribution(identity, "private");

describe("githubAttribution", () => {
  describe("formatAgentAttribution", () => {
    it("formats full attribution block with displayName, sessionId, and threadId", () => {
      expect(
        formatPrivate({
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
      expect(formatPrivate({})).toBe("");
      expect(formatPrivate({ displayName: "MarsCode Agent" })).toBe("");
      expect(formatPrivate({ displayName: "Agent", sessionId: "   ", threadId: "\n\r" })).toBe("");
    });

    it("omits Agent Session when sessionId is empty and omits Agent Thread when threadId is empty", () => {
      expect(
        formatPrivate({
          displayName: "Codex",
          threadId: "thread-only",
        }),
      ).toBe(
        ["Co-authored-by: Codex <codex@agents.local>", "Agent Thread: thread-only"].join("\n"),
      );

      expect(
        formatPrivate({
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
      const stamp = formatPrivate({
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
      expect(formatPrivate({ threadId: "thr_99" })).toBe(
        [
          "Co-authored-by: MarsCode Agent <marscode-agent@agents.local>",
          "Agent Thread: thr_99",
        ].join("\n"),
      );
      expect(formatPrivate({ displayName: "日本語", threadId: "thr_99" })).toBe(
        ["Co-authored-by: 日本語 <thr_99@agents.local>", "Agent Thread: thr_99"].join("\n"),
      );
      expect(formatPrivate({ displayName: "🚀", threadId: "!!!" })).toBe(
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
      const once = stampAgentProse("Implemented the fix.", identity, PRIVATE);
      expect(once).toBe(
        [
          "Implemented the fix.",
          "",
          "Co-authored-by: Fix Bug <fix-bug@agents.local>",
          "Agent Session: sess-1",
          "Agent Thread: thread-1",
        ].join("\n"),
      );
      expect(stampAgentProse(once, identity, PRIVATE)).toBe(once);
      // Mid-body stray trailer line must not bypass stamping
      const spoofed = "Intro\nAgent Thread: fake\nClosing.";
      expect(stampAgentProse(spoofed, identity, PRIVATE)).toBe(
        `${spoofed}\n\n${formatPrivate(identity)}`,
      );
    });

    it("returns body unchanged when identity is empty", () => {
      expect(stampAgentProse("Hello", {}, PRIVATE)).toBe("Hello");
    });

    it("returns stamp cleanly when body is empty or whitespace-only", () => {
      const expected = formatPrivate(identity);
      expect(stampAgentProse("", identity, PRIVATE)).toBe(expected);
      expect(stampAgentProse("   \n\n", identity, PRIVATE)).toBe(expected);
    });

    it("enforces GitHub 65536-char limit and custom maxLength without losing the stamp", () => {
      const stamp = formatPrivate(identity);
      const huge = "a".repeat(70_000);
      const stampedDefault = stampAgentProse(huge, identity, PRIVATE);
      expect(stampedDefault.length).toBeLessThanOrEqual(65_536);
      expect(stampedDefault.endsWith(stamp)).toBe(true);
      expect(hasAgentAttribution(stampedDefault)).toBe(true);

      const customMax = stamp.length + 12;
      const stampedSmall = stampAgentProse("0123456789abcdef", identity, {
        ...PRIVATE,
        maxLength: customMax,
      });
      expect(stampedSmall.length).toBeLessThanOrEqual(customMax);
      expect(stampedSmall.endsWith(stamp)).toBe(true);
      expect(stampedSmall).toContain("...");
    });

    it("avoids splitting UTF-16 surrogate pairs during truncation", () => {
      const stamp = formatPrivate(identity);
      const emojiBody = "😀".repeat(20);
      // Choose an odd budget so naive slice would split a surrogate pair
      const maxLength = stamp.length + 2 + 3 + 5;
      const result = stampAgentProse(emojiBody, identity, { ...PRIVATE, maxLength });
      expect(result.length).toBeLessThanOrEqual(maxLength);
      expect(result.endsWith(stamp)).toBe(true);
      // Verify no unpaired high surrogate remains
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
    });
  });

  describe("public audience", () => {
    const THREAD = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
    const SESSION = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";

    it("stamps only the neutral name and UUID ids, never the thread title", () => {
      const stamp = formatAgentAttribution(
        { displayName: "Fix Login Bug", sessionId: SESSION, threadId: THREAD },
        "public",
      );
      expect(stamp).toBe(
        [
          `Co-authored-by: MarsCode Agent <${THREAD}@agents.local>`,
          `Agent Session: ${SESSION}`,
          `Agent Thread: ${THREAD}`,
        ].join("\n"),
      );
      expect(stamp).not.toContain("Fix Login Bug");
    });

    it("drops ids that are not UUIDs and stamps nothing when none remain", () => {
      expect(
        formatAgentAttribution(
          { displayName: "T", sessionId: "sess-1", threadId: THREAD },
          "public",
        ),
      ).toBe(
        [`Co-authored-by: MarsCode Agent <${THREAD}@agents.local>`, `Agent Thread: ${THREAD}`].join(
          "\n",
        ),
      );
      expect(formatAgentAttribution({ sessionId: SESSION, threadId: "thr_99" }, "public")).toBe(
        [
          `Co-authored-by: MarsCode Agent <${SESSION}@agents.local>`,
          `Agent Session: ${SESSION}`,
        ].join("\n"),
      );
      expect(formatAgentAttribution({ sessionId: "agent", threadId: "thr_99" }, "public")).toBe("");
      expect(stampAgentProse("Body", { sessionId: "agent" }, PUBLIC)).toBe("Body");
    });

    it("never re-stamps a neutral stamp, whichever audience reads it next", () => {
      const identity = { displayName: "Title", sessionId: SESSION, threadId: THREAD };
      const once = stampAgentProse("Body", identity, PUBLIC);
      expect(once).toBe(`Body\n\n${formatAgentAttribution(identity, "public")}`);
      expect(stampAgentProse(once, identity, PUBLIC)).toBe(once);
      expect(stampAgentProse(once, identity, PRIVATE)).toBe(once);
    });
  });
});
