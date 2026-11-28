// @effect-diagnostics nodeBuiltinImport:off - Reads a captured Renovate log fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parseRenovateLookupLog } from "./depsRenovate.ts";

// Trimmed records from a real `renovate` lookup run over this repository.
const realLog = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../fixtures/renovate-lookup.jsonl"),
  "utf8",
);

describe("Renovate lookup log", () => {
  it("reads every available update, and not Renovate's deliberate skips", () => {
    const result = parseRenovateLookupLog(realLog);
    expect(result.incomplete).toEqual([]);
    expect(
      result.updates.map((u) => `${u.packageFile} ${u.depName} ${u.currentValue}->${u.newValue}`),
    ).toEqual([
      "apps/server/package.json @cursor/sdk 1.4.2->1.5.2",
      "package.json knip 6.34.0->6.49.0",
      "package.json pnpm 12.14.0->12.23.0",
    ]);
  });

  it("never reads a failed or unfinished run as no updates", () => {
    const [packageFiles, finished] = realLog.trim().split("\n");
    expect(() => parseRenovateLookupLog(`${packageFiles}\n`)).toThrow("did not finish");
    expect(() => parseRenovateLookupLog(`${finished}\n`)).toThrow("missing or ambiguous");
    expect(() =>
      parseRenovateLookupLog(
        `${realLog}${JSON.stringify({ level: 50, msg: "Repository has unknown error" })}\n`,
      ),
    ).toThrow("Repository has unknown error");
  });

  it("marks a failed assessment as incomplete, but not a deliberate skip", () => {
    const [packageFiles, finished] = realLog.trim().split("\n");
    const record = JSON.parse(packageFiles!) as {
      config: { npm: Array<{ deps: Array<{ skipReason?: string }> }> };
    };
    // The real record's workspace references (unspecified-version) stay skips.
    expect(parseRenovateLookupLog(realLog).incomplete).toEqual([]);
    record.config.npm[1]!.deps[0]!.skipReason = "invalid-version";
    // A pnpm override that removes a dependency ("-") is a deliberate skip.
    record.config.npm[0]!.deps.push({
      skipReason: "unspecified-version",
      currentValue: "-",
    } as never);
    // An external reference Renovate cannot use gets unspecified-version too: not a skip.
    Object.assign(record.config.npm[1]!.deps[1]!, {
      skipReason: "unspecified-version",
      currentValue: "github:owner/pkg#main",
    });
    const unparsable = JSON.stringify({
      level: 20,
      msg: "Invalid JSON",
      packageFile: "packages/x/package.json",
    });
    const dropped = JSON.stringify({
      level: 20,
      msg: "Error parsing package.json",
      fileName: "packages/y/package.json",
    });
    const workspace = JSON.stringify({
      level: 40,
      msg: "Failed to parse pnpm-workspace.yaml file",
      packageFile: "pnpm-workspace.yaml",
    });
    // Renovate 44.236.5 logs an unreadable .yarnrc.yml once per package file, with no file name.
    const yarnrc = JSON.stringify({ level: 40, msg: "Failed to load yarnrc file", yarnrcYml: "[" });
    // An empty manifest is dropped before parsing, with this debug record.
    const empty = JSON.stringify({
      level: 20,
      msg: "No content found",
      packageFile: "packages/empty/package.json",
    });
    const result = parseRenovateLookupLog(
      `${unparsable}\n${dropped}\n${workspace}\n${yarnrc}\n${yarnrc}\n${empty}\n${JSON.stringify(record)}\n${finished}\n`,
    );
    expect(result.incomplete).toEqual([
      "packages/x/package.json: could not be parsed",
      "packages/y/package.json: could not be parsed",
      "pnpm-workspace.yaml: could not be parsed",
      ".yarnrc.yml: could not be parsed",
      "packages/empty/package.json: could not be parsed",
      "package.json: knip (invalid-version)",
      "package.json: pnpm (unspecified-version)",
    ]);
  });

  it("marks a dependency whose lookup warned as incomplete", () => {
    const [packageFiles, finished] = realLog.trim().split("\n");
    const record = JSON.parse(packageFiles!) as {
      config: { npm: Array<{ deps: Array<{ warnings?: unknown[] }> }> };
    };
    record.config.npm[1]!.deps[0]!.warnings = [{ topic: "knip", message: "lookup failed" }];
    const result = parseRenovateLookupLog(`${JSON.stringify(record)}\n${finished}\n`);
    expect(result.incomplete).toEqual(["package.json: knip"]);
    expect(result.updates.map((u) => u.depName)).toEqual(["@cursor/sdk", "pnpm"]);
  });
});
