import { describe, expect, it } from "@effect/vitest";

import {
  parseReaperPolicyToml,
  parseReaperPolicyTomlStrict,
  serializeReaperPolicyToml,
} from "./ReaperPolicyToml.ts";

const rule = (...extra: ReadonlyArray<string>) =>
  ["[[approved]]", 'path = "/data/cache"', "enabled = true", ...extra, ""].join("\n");

describe("reaper policy parser", () => {
  it("refuses a malformed header inside a rule instead of dropping the keys after it", () => {
    const text = rule("[broken", "max_age_days = 365");

    const strict = parseReaperPolicyTomlStrict(text);

    expect(strict.ok).toBe(false);
    expect(strict.ok ? "" : strict.error).toContain("line 4");
    // The sweep's lenient read drops the rule rather than run it with the 14-day default.
    expect(parseReaperPolicyToml(text)).toEqual([]);
  });

  it.each([
    "[broken",
    "[dockr]",
    "[[docker]]",
    "[[approved]",
    "[approved]]",
    "[ docker ]",
    "[Docker]",
    "[docker.sub]",
  ])("refuses the header %s", (header) => {
    expect(parseReaperPolicyTomlStrict(`${header}\n${rule()}`).ok).toBe(false);
  });

  it("refuses an unknown line inside a rule", () => {
    for (const line of ["max_age_days365", "keepLatest = 2", '"stray"']) {
      expect(parseReaperPolicyTomlStrict(rule(line)).ok).toBe(false);
      expect(parseReaperPolicyToml(rule(line))).toEqual([]);
    }
  });

  it("reads known tables, comments and multi-line arrays, and round-trips the rules", () => {
    const text = [
      "# host policy",
      "[docker] # labels kept",
      "keep_labels = [",
      '  "keep-me",',
      "]",
      "",
      "[retention]",
      "default_days = 14",
      "",
      rule("max_age_days = 365", "keep_latest = 3"),
      "[cargo]",
      'roots = ["/data/cargo"]',
      "",
    ].join("\n");

    const strict = parseReaperPolicyTomlStrict(text);

    const expected = [{ path: "/data/cache", maxAgeDays: 365, keepLatest: 3, enabled: true }];
    expect(strict).toEqual({ ok: true, rules: expected });
    const saved = serializeReaperPolicyToml(expected, text);
    expect(saved).toContain("[docker] # labels kept");
    expect(saved).toContain('roots = ["/data/cargo"]');
    expect(parseReaperPolicyTomlStrict(saved)).toEqual({ ok: true, rules: expected });
  });
});
