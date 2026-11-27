// @effect-diagnostics nodeBuiltinImport:off - Headless playbook gate uses node:* directly without Effect.
/**
 * `playbook check tools`: declared lint, typecheck, deadcode, deps, and format steps (PLAYBOOK §14).
 * Checks unique names, declared config existence, runs each step with PLAYBOOK_BASE, and reports exit codes.
 */
import * as NodeCrypto from "node:crypto";

import { readWorktreeBytes } from "../git.ts";
import { failed, passed, unproven, type CheckResult } from "../result.ts";
import { runStep, tailLines } from "../steps.ts";
import { isRecord } from "../strictJson.ts";

export async function toolsGate(input: {
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly base: string | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<ReadonlyArray<CheckResult>> {
  const rawSteps = input.settings.steps;
  if (!Array.isArray(rawSteps)) {
    return [
      failed("tools", "contracts.tools.steps is not a list of steps", {
        files: ["playbook.json"],
        fix: "declare each lint, typecheck and other step in contracts.tools.steps (PLAYBOOK §14)",
      }),
    ];
  }
  const steps = rawSteps.filter(isRecord);
  if (steps.length === 0) return [passed("tools", "no declared steps")];

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const step of steps) {
    const name = String(step.name ?? "");
    if (seen.has(name)) duplicates.push(`contracts.tools.steps names '${name}' more than once`);
    seen.add(name);
  }
  if (duplicates.length > 0) {
    return [
      failed("tools", duplicates[0]!, {
        errors: duplicates,
        files: ["playbook.json"],
        fix: "give every step in contracts.tools.steps a unique name",
      }),
    ];
  }

  const results: CheckResult[] = [];
  for (const step of steps) {
    const name = `tools ${String(step.name)}`;
    const configFiles = Array.isArray(step.config)
      ? step.config.filter((c): c is string => typeof c === "string")
      : [];
    const missingConfig: string[] = [];
    const hash = NodeCrypto.createHash("sha256");
    for (const rel of configFiles) {
      const bytes = readWorktreeBytes(input.root, rel);
      if (bytes === null) missingConfig.push(rel);
      else hash.update(rel).update("\0").update(bytes);
    }
    if (missingConfig.length > 0) {
      results.push(
        failed(name, `declares config file(s) that do not exist: ${missingConfig.join(", ")}`, {
          files: ["playbook.json"],
          fix: "name the config files the step really reads, or restore them",
        }),
      );
      continue;
    }
    const command = String(step.run);
    const run = await runStep(
      input.root,
      command,
      { PLAYBOOK_BASE: input.base ?? "" },
      undefined,
      input.signal,
    );
    if (run.code === null) {
      results.push(unproven(name, `\`${command}\` did not run: ${run.why}`));
    } else if (run.code === 0) {
      const digest =
        configFiles.length > 0
          ? `; config sha256 ${hash.digest("hex").slice(0, 12)} (${configFiles.join(", ")})`
          : "";
      results.push(passed(name, `\`${command}\` exited 0${digest}`));
    } else {
      const errors = tailLines(run, 15);
      results.push(failed(name, `\`${command}\` exited ${run.code}`, { errors }));
    }
  }
  return results;
}
