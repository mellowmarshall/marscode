import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { defineConfig } from "vite-plus";

const bundledPlaybookMd = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "PLAYBOOK.md"),
  "utf8",
);

// `vp pack` emits dist/bin.mjs: the standalone headless `playbook` CLI for CI hosts.
export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
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
