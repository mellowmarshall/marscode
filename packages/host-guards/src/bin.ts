#!/usr/bin/env node
import { runHostGuardCli } from "./cli.ts";

const code = await runHostGuardCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
