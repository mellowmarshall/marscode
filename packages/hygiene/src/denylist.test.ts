// @effect-diagnostics nodeBuiltinImport:off - Writes temporary denylist files with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { denylistPath, displayPath, loadDenylist, parseDenylist } from "./denylist.ts";
import { scanName, scanText } from "./textScan.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function tempDenylist(text: string, mode = 0o600): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hygiene-deny-"));
  dirs.push(dir);
  const file = NodePath.join(dir, "deny");
  NodeFS.writeFileSync(file, text);
  NodeFS.chmodSync(file, mode);
  return file;
}

describe("denylist path", () => {
  it("prefers the explicit variable, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(denylistPath({ MARSCODE_HYGIENE_DENYLIST: "/x/deny", HOME: "/home/dev" })).toBe(
      "/x/deny",
    );
    expect(denylistPath({ XDG_CONFIG_HOME: "/cfg", HOME: "/home/dev" })).toBe(
      "/cfg/marscode/public-hygiene.denylist",
    );
    expect(denylistPath({ HOME: "/home/dev" })).toBe(
      "/home/dev/.config/marscode/public-hygiene.denylist",
    );
    expect(displayPath("/home/dev/.config/x", { HOME: "/home/dev" })).toBe("~/.config/x");
  });
});

describe("parseDenylist", () => {
  it("reads class headers and case-insensitive patterns", () => {
    const parsed = parseDenylist(
      "# comment\n@class host-names\nwidget-box-\\d+\n\n@class private-repos\nacme/secret-thing\n",
    );
    expect(parsed.kind).toBe("loaded");
    if (parsed.kind !== "loaded") return;
    expect(parsed.rules.map((r) => [r.classId, r.line])).toEqual([
      ["host-names", 3],
      ["private-repos", 6],
    ]);
    expect(parsed.rules[0]?.pattern.test("WIDGET-BOX-7")).toBe(true);
  });

  it("rejects an unknown class, a pattern before any header, and a bad regex", () => {
    expect(parseDenylist("@class not-a-class\nx\n")).toEqual({ kind: "invalid", line: 1 });
    expect(parseDenylist("orphan\n")).toEqual({ kind: "invalid", line: 1 });
    expect(parseDenylist("@class host-names\n(unclosed\n")).toEqual({ kind: "invalid", line: 2 });
  });
});

describe("loadDenylist", () => {
  it("loads an owner-only file", () => {
    const file = tempDenylist("@class host-names\nwidget-box\n");
    const load = loadDenylist({ MARSCODE_HYGIENE_DENYLIST: file });
    expect(load.kind).toBe("loaded");
  });

  it("treats a group- or world-readable file as invalid", () => {
    const file = tempDenylist("@class host-names\nwidget-box\n", 0o644);
    expect(loadDenylist({ MARSCODE_HYGIENE_DENYLIST: file })).toEqual({
      kind: "invalid",
      path: file,
      line: 0,
    });
  });

  it("reports a missing file with its expected path", () => {
    const load = loadDenylist({ MARSCODE_HYGIENE_DENYLIST: "/nonexistent/hygiene-deny" });
    expect(load).toEqual({ kind: "missing", path: "/nonexistent/hygiene-deny" });
  });

  it("reports private hits by class without the matched text", () => {
    const file = tempDenylist("@class host-names\nwidget-box-\\d+\n");
    const load = loadDenylist({ MARSCODE_HYGIENE_DENYLIST: file });
    if (load.kind !== "loaded") throw new Error("expected loaded");
    const findings = scanText("ok\nreach widget-box-12 now\n", {
      source: "notes.md",
      surface: "tree",
      denylist: load.rules,
    });
    expect(findings).toEqual([
      { classId: "host-names", source: "notes.md", line: 2, rule: "private:host-names" },
    ]);
    expect(JSON.stringify(findings)).not.toContain("widget");
  });

  it("hides a path on every finding once any private rule hits it", () => {
    const file = tempDenylist("@class host-names\nwidget-box-\\d+\n");
    const load = loadDenylist({ MARSCODE_HYGIENE_DENYLIST: file });
    if (load.kind !== "loaded") throw new Error("expected loaded");
    const options = { surface: "tree", denylist: load.rules } as const;
    const mixed = scanName("/data/Dev/widget-lab/widget-box-12.txt", "path", options);
    expect(mixed.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^public:/), "private:host-names"]),
    );
    expect(mixed.every((finding) => finding.source.startsWith("path@sha256:"))).toBe(true);
    expect(JSON.stringify(mixed)).not.toContain("widget");
    const publicOnly = scanName("/data/Dev/widget-lab/notes.txt", "path", options);
    expect(publicOnly.length).toBeGreaterThan(0);
    expect(publicOnly.every((finding) => finding.source === "/data/Dev/widget-lab/notes.txt")).toBe(
      true,
    );
  });
});
