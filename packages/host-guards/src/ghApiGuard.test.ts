// @effect-diagnostics nodeBuiltinImport:off - Direct tests for ghApiGuard {branch} placeholder refusals.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideGhApiCall } from "./ghApiGuard.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function makeConfig(): { readonly config: HostGuardsConfig; readonly cwd: string } {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-ghapi-"));
  tempDirs.push(root);
  const cwd = NodePath.join(root, "work");
  NodeFS.mkdirSync(cwd);
  const configPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(root, "src"),
      dataRoot: NodePath.join(root, "data"),
      stateDir: NodePath.join(root, "state"),
      realGit: "/usr/bin/git",
      realGh: "/usr/bin/gh",
    }),
    "utf8",
  );
  return { config: loadHostConfig({ configPath }), cwd };
}

function verdict(args: ReadonlyArray<string>): string {
  const { config, cwd } = makeConfig();
  return decideGhApiCall(["api", ...args], cwd, config, false, {}).verdict;
}

describe("ghApiGuard {branch} placeholders", () => {
  it("blocks {branch} in branches/{branch}/protection", () => {
    expect(verdict(["-X", "PUT", "repos/example-org/demo-app/branches/{branch}/protection"])).toBe(
      "deny",
    );
    expect(
      verdict([
        "-X",
        "DELETE",
        "repos/example-org/demo-app/branches/{branch}/protection/required_status_checks",
      ]),
    ).toBe("deny");
    expect(verdict(["-X", "PUT", "repos/example-org/demo-app/branches/feat-x/protection"])).toBe(
      "allow",
    );
  });

  it("blocks a {branch} placeholder in the contents/ branch field", () => {
    const put = ["-X", "PUT", "repos/example-org/demo-app/contents/README.md"];
    expect(verdict([...put, "-f", "branch={branch}", "-f", "message=m"])).toBe("deny");
    expect(verdict([...put, "-F", "branch={branch}"])).toBe("deny");
    expect(
      verdict([
        "-X",
        "DELETE",
        "repos/example-org/demo-app/contents/README.md",
        "-f",
        "branch={branch}",
      ]),
    ).toBe("deny");
    expect(verdict([...put, "-f", "branch=feat/x", "-f", "message=m"])).toBe("allow");
  });
});
