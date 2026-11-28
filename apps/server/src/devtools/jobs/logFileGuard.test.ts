import { describe, expect, it } from "@effect/vitest";

import { redactLogLine } from "./logFileGuard.ts";

// Built at run time so the source holds no string shaped like a live credential.
const fill = (char: string, length: number) => char.repeat(length);
const KNOWN_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["GitHub classic personal token", `ghp_${fill("a1", 18)}`],
  ["GitHub OAuth token", `gho_${fill("b2", 18)}`],
  ["GitHub user-to-server token", `ghu_${fill("c3", 18)}`],
  ["GitHub server-to-server token", `ghs_${fill("d4", 18)}`],
  ["GitHub refresh token", `ghr_${fill("e5", 18)}`],
  ["GitHub fine-grained token", `github_pat_${fill("F6", 11)}_${fill("g7", 30)}`],
  ["Doppler service token", `dp.st.${fill("prd", 4)}.${fill("H8", 20)}`],
  ["Doppler personal token", `dp.pt.${fill("i9", 22)}`],
  ["AWS access key id", `AKIA${fill("J0", 8)}`],
  ["JWT", `eyJ${fill("hb", 10)}.eyJ${fill("zd", 12)}.${fill("s-g_", 8)}`],
  ["npm token", `npm_${fill("k1", 18)}`],
  ["GitLab personal token", `glpat-${fill("L2", 10)}`],
  ["Slack bot token", `xoxb-${fill("3", 12)}-${fill("m4", 12)}`],
  ["Slack user token", `xoxp-${fill("5", 12)}-${fill("n6", 12)}`],
];

describe("redactLogLine known token shapes", () => {
  it.each(KNOWN_SHAPES)("redacts a bare %s", (_label, token) => {
    const redacted = redactLogLine(`clone with ${token} done`);
    expect(redacted).not.toContain(token);
    expect(redacted).toBe("clone with [REDACTED] done");
  });

  it("leaves look-alike words that are not tokens", () => {
    for (const text of ["AKIA is a prefix", "eyJ alone", "npm_config ok", "dp.st.short"]) {
      expect(redactLogLine(text)).toBe(text);
    }
  });
});
