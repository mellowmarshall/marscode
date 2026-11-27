import { defineConfig } from "vite-plus";

// `vp pack` emits dist/bin.mjs: the standalone headless `ship-queue` CLI.
export default defineConfig({
  pack: {
    entry: { bin: "src/cli.ts" },
    outDir: "dist",
    platform: "node",
    clean: true,
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^@t3tools\//, /^effect/, /^@effect\//] },
  },
});
