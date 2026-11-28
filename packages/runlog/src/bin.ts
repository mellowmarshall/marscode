#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - headless `runlog` entry point (node or a `vp pack` bundle).
import { runRunlogCli } from "./cli.ts";

// A reader that closed runlog's stdout ends it as it ended the original: exit 120.
const EXIT_BROKEN_PIPE = 120;
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(EXIT_BROKEN_PIPE);
});

process.exitCode = await runRunlogCli(process.argv.slice(2));
