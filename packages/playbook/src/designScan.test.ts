// @effect-diagnostics nodeBuiltinImport:off - Runs the vendored design scan with node over a real temp git repository.
/**
 * The original playbook's design scan, vendored in vendor/design-scan and bundled to
 * dist/pb_design_scan.mjs for <prefix>/lib/playbook/: run as repos run it (node, the
 * declaration read from the current directory, or a payload on stdin).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { cleanupTempDirs, makeTempDir } from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const SCAN = NodeURL.fileURLToPath(
  new URL("../vendor/design-scan/pb_design_scan.mjs", import.meta.url),
);

function fixture(): string {
  const root = NodePath.join(makeTempDir("pb-design-scan-"), "repo");
  const write = (rel: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, rel)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, rel), text);
  };
  write(
    "playbook.json",
    JSON.stringify({
      contracts: {
        design: {
          tokens: "src/tokens",
          ui: "src/ui",
          client: ["src/"],
          interactive: ["Button"],
          style_properties: ["color", "padding"],
        },
      },
    }),
  );
  write("src/tokens/colors.ts", 'export const red = "#ff0000";\n');
  write("src/ui/Button.tsx", "export function Button() { return null; }\n");
  write(
    "src/app/Page.tsx",
    'import { Button } from "../ui/Button";\nexport function Page() {\n  return <div style={{ color: "#ff0000", padding: 7 }}><button onClick={() => 1}>x</button></div>;\n}\n',
  );
  NodeChildProcess.spawnSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  return root;
}

function scan(cwd: string, input = "") {
  return NodeChildProcess.spawnSync(process.execPath, [SCAN], { cwd, input, encoding: "utf8" });
}

describe("design scan (pb_design_scan.mjs)", () => {
  it("reads playbook.json from the current directory and names each raw value and raw control", () => {
    const root = fixture();
    const run = scan(root);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as {
      findings: Array<{ rule: string; message: string }>;
      files: number;
    };
    expect(out.files).toBe(3);
    expect(out.findings.map((f) => [f.rule, f.message])).toEqual([
      ["design/raw-interactive", "<button> is a raw interactive element; use the UI package"],
      ["design/color-literal", 'color literal "#ff0000"; use a color token from src/tokens'],
      ["design/style-literal", 'color: literal "#ff0000"; use a token from src/tokens'],
      ["design/style-literal", "padding: literal 7; use a token from src/tokens"],
    ]);
  });

  it("takes the playbook's payload on stdin, and skips generated files", () => {
    const root = fixture();
    const settings = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "playbook.json"), "utf8"))
      .contracts.design;
    const payload = (generated: string[]) => JSON.stringify({ root, settings, generated });
    const all = scan(makeTempDir("pb-design-cwd-"), payload([]));
    expect(all.status, all.stderr).toBe(0);
    expect((JSON.parse(all.stdout) as { findings: unknown[] }).findings).toHaveLength(4);
    const skipped = scan(makeTempDir("pb-design-cwd-"), payload(["src/app/Page.tsx"]));
    expect(JSON.parse(skipped.stdout)).toEqual({ findings: [], files: 2 });
  });
});
