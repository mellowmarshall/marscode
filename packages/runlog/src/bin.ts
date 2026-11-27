#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - headless `runlog` entry point (node or a `vp pack` bundle).
import { runRunlogCli } from "./cli.ts";

process.exitCode = await runRunlogCli(process.argv.slice(2));
