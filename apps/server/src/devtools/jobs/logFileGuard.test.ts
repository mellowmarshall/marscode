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

  const b64 = `${fill("dXNlcjpwYXNz", 2)}==`;
  // [scheme, header value, what it reads as once redacted]: the scheme name stays, nothing after it.
  const SCHEMES: ReadonlyArray<readonly [string, string, string]> = [
    ["Basic", `Basic ${b64}`, "Basic [REDACTED]"],
    ["Bearer", `Bearer ${fill("opaque", 4)}`, "Bearer [REDACTED]"],
    ["Token", `Token ${fill("tk9", 6)}`, "Token [REDACTED]"],
    [
      "Digest",
      `Digest username="ops", realm="queue", nonce="${fill("n0", 8)}", response="${fill("r1", 16)}"`,
      "Digest [REDACTED]",
    ],
    [
      "another scheme",
      `AWS4-HMAC-SHA256 Credential=${fill("C2", 8)}, Signature=${fill("s3", 16)}`,
      "AWS4-HMAC-SHA256 [REDACTED]",
    ],
    ["no scheme", fill("rawcredential", 2), "[REDACTED]"],
  ];
  // The credential parts of a value: everything long enough to matter, except the scheme name.
  const secretParts = (value: string, shown: string) =>
    value.split(/[\s,="]+/).filter((part) => part.length >= 8 && !shown.includes(part));

  it.each(SCHEMES)(
    "redacts every %s credential of a quoted curl header",
    (_scheme, value, shown) => {
      const redacted = redactLogLine(
        `curl -sS -H 'Authorization: ${value}' https://example.test/x`,
      );
      expect(redacted).toBe(`curl -sS -H 'Authorization: ${shown}' https://example.test/x`);
      const escaped = value.replaceAll('"', '\\"');
      expect(redactLogLine(`curl -H "Authorization: ${escaped}" https://example.test/x`)).toBe(
        `curl -H "Authorization: ${shown}" https://example.test/x`,
      );
    },
  );

  it.each(SCHEMES)("redacts every %s credential of a bare header line", (_scheme, value, shown) => {
    const redacted = redactLogLine(`  Proxy-Authorization: ${value}`);
    for (const part of secretParts(value, shown)) expect(redacted).not.toContain(part);
    expect(redacted).toContain(`Proxy-Authorization: ${shown}`);
  });

  it.each(SCHEMES)("redacts every %s credential of a JSON header", (_scheme, value, shown) => {
    const json = JSON.stringify({ authorization: value, accept: "text/plain" });
    const redacted = redactLogLine(json);
    for (const part of secretParts(value, shown)) expect(redacted).not.toContain(part);
    expect(redacted).toContain(`"authorization":"${shown}"`);
    expect(redacted).toContain('"accept":"text/plain"');
  });
});
