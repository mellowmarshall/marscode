import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { defineConfig } from "vite-plus";

const bundledPlaybookMd = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "PLAYBOOK.md"),
  "utf8",
);

// `vp pack` emits dist/bin.mjs, the standalone headless `playbook` CLI for CI hosts, and
// dist/pb_design_scan.mjs, the original playbook's design scan in one file, which the
// installers place where repos' design evidence runs it (<prefix>/lib/playbook/).
export default defineConfig({
  pack: {
    entry: { bin: "src/bin.ts", pb_design_scan: "vendor/design-scan/pb_design_scan.mjs" },
    outDir: "dist",
    platform: "node",
    clean: true,
    sourcemap: false,
    deps: { alwaysBundle: [/^@t3tools\//, /^effect/] },
    define: {
      __BUNDLED_PLAYBOOK_MD__: JSON.stringify(bundledPlaybookMd),
    },
  },
});
