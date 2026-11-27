// @effect-diagnostics nodeBuiltinImport:off - Node child-process runner for the headless CLI's process port.
import * as NodeChildProcess from "node:child_process";

import type { ProcessRunner } from "./types.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const nodeProcessRunner: ProcessRunner = (input) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin ?? "");
  });
