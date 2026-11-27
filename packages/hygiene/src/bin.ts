#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - headless `hygiene` entry point (node or a `vp pack` bundle).
import { runHygieneCli } from "./cli.ts";

process.exitCode = runHygieneCli(process.argv.slice(2));
