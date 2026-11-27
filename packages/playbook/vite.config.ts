import { defineConfig } from "vite-plus";

// `vp pack` emits dist/bin.mjs: the standalone headless `playbook` CLI for CI hosts.
export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    platform: "node",
    clean: true,
    sourcemap: false,
    deps: { alwaysBundle: [/^@t3tools\//, /^effect/] },
  },
});
