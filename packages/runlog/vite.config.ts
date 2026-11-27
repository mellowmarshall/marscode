import { defineConfig } from "vite-plus";

// `vp pack` emits dist/bin.mjs: the standalone headless `runlog` CLI.
export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    platform: "node",
    clean: true,
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^@t3tools\//] },
  },
});
