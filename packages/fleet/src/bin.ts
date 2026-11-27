#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - headless `fleet` entry point (node or a `vp pack` bundle).
import { runFleetCli } from "./cli.ts";

try {
  process.exitCode = runFleetCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`fleet: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
