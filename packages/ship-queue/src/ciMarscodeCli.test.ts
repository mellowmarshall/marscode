// @effect-diagnostics nodeBuiltinImport:off - Runs the real CI host CLI installer script against real MarsCode CLIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const INSTALLER = NodePath.join(REPO, "infra/ci-host/ci-marscode-cli.sh");
const MARKER = "# Installed by MarsCode; reinstalls replace this file.";

let tmp: string;
let home: string;
let payload: string;

beforeEach(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ci-marscode-cli-")));
  home = NodePath.join(tmp, "home");
  payload = NodePath.join(tmp, "payload");
  NodeFS.mkdirSync(NodePath.join(home, ".local", "bin"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(payload, "infra", "ci-host"), { recursive: true });
  // The payload as hosts sync unpacks it: the installer beside the CLIs' bundles.
  NodeFS.copyFileSync(INSTALLER, NodePath.join(payload, "infra", "ci-host", "ci-marscode-cli.sh"));
});

afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

/** The payload's bundle for NAME runs the real MarsCode CLI at ENTRY (node runs its TypeScript source). */
function bundle(name: string, entry: string): void {
  const file = NodePath.join(payload, "packages", name, "dist", "bin.mjs");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const href = NodeURL.pathToFileURL(NodePath.join(REPO, entry)).href;
  NodeFS.writeFileSync(file, `import ${JSON.stringify(href)};\n`);
}

function installer(name: string) {
  return NodeChildProcess.spawnSync(
    "bash",
    [NodePath.join(payload, "infra", "ci-host", "ci-marscode-cli.sh"), name],
    {
      cwd: tmp,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${NodePath.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    },
  );
}

/** The original's install layout: the bin is a link into its own lib directory. */
function originalLink(name: string): { link: string; script: string } {
  const lib = NodePath.join(home, ".local", "lib", name);
  NodeFS.mkdirSync(lib, { recursive: true });
  const script = NodePath.join(lib, name);
  NodeFS.writeFileSync(script, "#!/bin/sh\necho original\n", { mode: 0o755 });
  const link = NodePath.join(home, ".local", "bin", name);
  NodeFS.symlinkSync(script, link);
  return { link, script };
}

const binOf = (name: string) => NodePath.join(home, ".local", "bin", name);
const runBin = (name: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(binOf(name), [...args], { cwd: tmp, encoding: "utf8" });

describe("ci-marscode-cli.sh flag-parity guard", () => {
  it("replaces another install's runlog link with a runlog that passes --ci-suite parity", () => {
    const { link, script } = originalLink("runlog");
    bundle("runlog", "packages/runlog/src/bin.ts");
    const r = installer("runlog");
    expect(r.status, r.stderr).toBe(0);
    expect(NodeFS.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(NodeFS.readFileSync(link, "utf8")).toContain(`${MARKER}\n`);
    expect(NodeFS.readFileSync(script, "utf8")).toBe("#!/bin/sh\necho original\n");
    const suite = runBin("runlog", ["--ci-suite", "host", "--", "true"]);
    expect(suite.status).toBe(0);
    expect(suite.stdout).toMatch(
      /^ci-suite: begin host pid=\d+ by=runlog\nci-suite: end host pass/,
    );
  });

  it("refuses a runlog without --ci-suite over another install's, and leaves it in place", () => {
    const { link, script } = originalLink("runlog");
    // A real MarsCode CLI with no --ci-suite where runlog's bundle belongs, as a stale build would be.
    bundle("runlog", "packages/fleet/src/bin.ts");
    const r = installer("runlog");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `refusing to replace ${link} (a link to ${script}, not installed by MarsCode)`,
    );
    expect(r.stderr).toMatch(/it exited [1-9]/);
    expect(r.stderr).toContain("runlog --ci-suite x -- true");
    expect(r.stderr).toContain("remove it yourself to let MarsCode install its runlog");
    expect(NodeFS.readlinkSync(link)).toBe(script);
    expect(runBin("runlog", []).stdout).toBe("original\n");
    const lib = NodePath.join(home, ".local", "lib", "marscode-tools");
    expect(NodeFS.existsSync(NodePath.join(lib, "runlog"))).toBe(false);
    expect(NodeFS.readdirSync(NodePath.join(lib, ".releases"))).toEqual([]);
  });

  it("never replaces another install's playbook", () => {
    const { link, script } = originalLink("playbook");
    bundle("playbook", "packages/playbook/src/bin.ts");
    const r = installer("playbook");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the MarsCode playbook has no flag-parity check");
    expect(NodeFS.readlinkSync(link)).toBe(script);
  });

  it("refuses over a plain file another install wrote", () => {
    const own = binOf("runlog");
    NodeFS.writeFileSync(own, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    bundle("runlog", "packages/fleet/src/bin.ts");
    const r = installer("runlog");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("(a file another install wrote, not installed by MarsCode)");
    expect(NodeFS.readFileSync(own, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("reinstalls over MarsCode's own wrappers, older ones without the marker too, with no parity check", () => {
    const bundlePath = NodePath.join(
      home,
      ".local",
      "lib",
      "marscode-tools",
      "playbook",
      "dist",
      "bin.mjs",
    );
    NodeFS.writeFileSync(binOf("playbook"), `#!/usr/bin/env bash\nexec node ${bundlePath} "$@"\n`, {
      mode: 0o755,
    });
    bundle("playbook", "packages/playbook/src/bin.ts");
    let r = installer("playbook");
    expect(r.status, r.stderr).toBe(0);
    expect(NodeFS.readFileSync(binOf("playbook"), "utf8")).toContain(MARKER);
    r = installer("playbook");
    expect(r.status, r.stderr).toBe(0);
    expect(runBin("playbook", ["version"]).status).toBe(0);
  });

  it("installs where nothing is installed yet", () => {
    bundle("runlog", "packages/runlog/src/bin.ts");
    expect(installer("runlog").status).toBe(0);
    expect(runBin("runlog", ["--ci-suite", "x", "--", "false"]).status).toBe(1);
  });
});
