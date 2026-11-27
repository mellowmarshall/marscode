import { defineConfig } from "vite-plus";

// `vp pack` emits dist/bin.mjs: the standalone headless `marscode-host-guard` CLI.
export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    platform: "node",
    clean: true,
    sourcemap: false,
    deps: { alwaysBundle: [/^@t3tools\//] },
  },
});
