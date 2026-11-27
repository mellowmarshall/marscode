#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - headless `surface` entry point (node or a `vp pack` bundle).
import { runSurfaceCli } from "./cli.ts";

try {
  process.exitCode = runSurfaceCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`surface: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
