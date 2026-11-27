#!/usr/bin/env node
import { runPlaybookCli } from "./cli.ts";

const code = await runPlaybookCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = code;
