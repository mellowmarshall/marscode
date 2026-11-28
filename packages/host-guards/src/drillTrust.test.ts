// @effect-diagnostics nodeBuiltinImport:off - Direct tests for drillTrust env parsing on values ending in `=`.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { hasVerifiedDrillAncestor } from "./drillTrust.ts";
import { loadHostConfig } from "./hostConfig.ts";
import type { ProcFsReader } from "./procFs.ts";
import type { RepoInfo } from "./repoScope.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const SYSTEM_DIRS = new Set(["/usr/local/bin", "/usr/bin", "/bin"]);

function drillProcFs(top: string, environ: ReadonlyArray<string>): ProcFsReader {
  return {
    hasProc: () => true,
    selfPid: () => 500,
    currentUid: () => 1000,
    readText: (filePath) => {
      if (filePath === "/proc/500/stat" || filePath === "/proc/self/stat") {
        return "500 (node) S 400 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 111";
      }
      if (filePath === "/proc/400/stat") {
        return "400 (bash) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100";
      }
      if (filePath === "/proc/400/cmdline") return "bash\0scripts/drill.sh\0";
      if (filePath === "/proc/400/environ") {
        return environ.length > 0 ? `${environ.join("\0")}\0` : "";
      }
      return null;
    },
    readLink: (linkPath) => {
      if (linkPath === "/proc/400/exe") return "/usr/bin/bash";
      if (linkPath === "/proc/400/cwd") return top;
      return null;
    },
    readDir: () => [],
    stat: (target) => {
      if (target === "/usr/bin/bash")
        return { dev: 1, ino: 10, uid: 0, mode: 0o100755, isFile: true };
      if (SYSTEM_DIRS.has(target))
        return { dev: 1, ino: 20, uid: 0, mode: 0o040755, isFile: false };
      return null;
    },
    lstat: () => null,
    realpath: (p) => p,
    canonicalHome: () => "/home/testuser",
  };
}

function checkDrill(environ: ReadonlyArray<string>): boolean {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-drill-"));
  tempDirs.push(root);
  const top = NodeFS.realpathSync(root);
  NodeFS.mkdirSync(NodePath.join(top, "scripts"));
  NodeFS.writeFileSync(NodePath.join(top, "scripts", "drill.sh"), "#!/bin/bash\nexit 0\n");
  const configPath = NodePath.join(top, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(top, "src"),
      dataRoot: NodePath.join(top, "data"),
      stateDir: NodePath.join(top, "state"),
      realGit: "/usr/bin/git",
      realGh: "/usr/bin/gh",
    }),
  );
  // Not a git repo: no default base ref, so the check skips the committed-blob comparison.
  const repo = { top, inScope: true, bases: () => ["main"] } as unknown as RepoInfo;
  return hasVerifiedDrillAncestor({
    repo,
    allowedPaths: ["scripts/drill.sh"],
    requireCleanMerged: false,
    config: loadHostConfig({ configPath }),
    procFs: drillProcFs(top, environ),
  });
}

describe("drillTrust env values that end in '='", () => {
  it("accepts a clean drill, including benign values with trailing '='", () => {
    expect(checkDrill(["PATH=/usr/bin:/bin"])).toBe(true);
    expect(checkDrill(["PATH=/usr/bin:/bin", "SAMPLE_B64=YWJjZA==", "EMPTY="])).toBe(true);
  });

  it("still rejects unsafe keys whose values end in '='", () => {
    expect(checkDrill(["PATH=/usr/bin:/bin", "LD_PRELOAD=/opt/lib/x.so="])).toBe(false);
    expect(checkDrill(["PATH=/usr/bin:/bin", "BASH_ENV=="])).toBe(false);
    expect(checkDrill(["PATH=/usr/bin:/bin", "BASH_FUNC_ls%%=() { :; }="])).toBe(false);
  });

  it("rejects a PATH whose segments end in '='", () => {
    expect(checkDrill(["PATH=/usr/bin="])).toBe(false);
    expect(checkDrill(["PATH=/usr/bin:/bin:="])).toBe(false);
  });
});
