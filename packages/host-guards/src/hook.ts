// @effect-diagnostics nodeBuiltinImport:off - PreToolUse non-blocking hook orchestrating all host guards across shell lines.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { checkArgvSecrets } from "./argvGuard.ts";
import { decideCloudCli } from "./cloudCliGuard.ts";
import { decideGit } from "./gitGuard.ts";
import { safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import { decideInstallTokens } from "./installGuard.ts";
import { decideGh, isManualMergeDrill } from "./mergeGuard.ts";
import {
  createOverrideState,
  overrideHint,
  parseOverrideReason,
  peekPreapprovedGrant,
  recordRefusal,
  requestOverrideGrant,
  type OverrideRuntime,
  type OverrideState,
} from "./override.ts";
import { decidePortsCheck } from "./portsGuard.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import { isQueueDaemonInAncestry } from "./t3ServerTrust.ts";
import type { GuardVerdict } from "./pushGuard.ts";
import { decideReleaseGuard } from "./releaseGuard.ts";
import { formatMergeRefusal, inspectRepo } from "./repoScope.ts";
import {
  applyDirectoryChange,
  extractEvalScript,
  extractNestedShellScripts,
  MAX_SHELL_DEPTH,
  SCOPE_POP,
  SCOPE_PUSH,
  ShellNestingError,
  splitShellSegments,
} from "./shellScan.ts";
import {
  extractCommandSubstitutions,
  tokenizeSimpleCommand,
  unwrapCommand,
} from "./shellTokenize.ts";
import { decideTreeGuard } from "./treeGuard.ts";

export const REFUSED_EXIT_CODE = 2;

const HOOK_BASH_TOOLS = new Set(["Bash", "bash", "Shell", "run_terminal_command"]);
const COPIER_PROGS = new Set(["cp", "install", "ln"]);

function isRealGhPath(word: string, cwd: string, config: HostGuardsConfig): boolean {
  if (!word || !word.includes("/")) return false;
  const resolved = safeRealpath(NodePath.resolve(cwd, word));
  return resolved === safeRealpath(config.realGh);
}

async function handleRefusal(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly reason: string;
    readonly allowBlocking: boolean;
    readonly deferToPathShim?: boolean | undefined;
  },
  runtime: OverrideRuntime,
  state: OverrideState,
): Promise<boolean> {
  const env = runtime.env ?? process.env;
  const writeErr = runtime.writeErr ?? ((s: string) => process.stderr.write(`${s}\n`));

  if (input.deferToPathShim) {
    const preapproved = await peekPreapprovedGrant(
      { guard: input.guard, command: input.command, cwd: input.cwd },
      runtime,
    );
    if (preapproved) return true;
    const identity = resolveCallerIdentity({
      env,
      testMode: runtime.testMode,
      procFs: runtime.procFs,
    });
    if (!identity.isAgent && parseOverrideReason(env) !== null) {
      return true;
    }
  }

  const granted = await requestOverrideGrant(
    {
      guard: input.guard,
      command: input.command,
      cwd: input.cwd,
      refusal: input.reason,
      allowBlocking: input.allowBlocking,
    },
    runtime,
    state,
  );
  if (granted) return true;

  recordRefusal(
    {
      guard: input.guard,
      command: input.command,
      cwd: input.cwd,
      refusal: input.reason,
    },
    runtime,
    state,
  );
  writeErr(`${input.reason}\n${overrideHint(input.cwd, runtime, state)}`);
  return false;
}

export async function enforceDirectGuard(
  tool: "git" | "gh",
  args: ReadonlyArray<string>,
  cwd: string,
  runtime: OverrideRuntime,
  options?: {
    readonly fromHook?: boolean | undefined;
    readonly bypassesPathShim?: boolean | undefined;
  },
): Promise<number> {
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const fromHook = options?.fromHook === true;

  if (
    tool === "git" &&
    !fromHook &&
    isQueueDaemonInAncestry(runtime.config.queueRoot, undefined, procFs)
  ) {
    return 0;
  }

  const verdict: GuardVerdict =
    tool === "git"
      ? decideGit(args, env, cwd, runtime.config, { procFs })
      : decideGh(args, cwd, runtime.config, { procFs });
  if (verdict.verdict === "allow") return 0;

  const state = createOverrideState();
  const ok = await handleRefusal(
    {
      guard: tool,
      command: [tool, ...args],
      cwd,
      reason: verdict.reason,
      allowBlocking: !fromHook,
      deferToPathShim: fromHook && !options?.bypassesPathShim,
    },
    runtime,
    state,
  );
  return ok ? 0 : REFUSED_EXIT_CODE;
}

async function checkLineRecursive(
  command: string,
  initialCwd: string,
  initialPrevCwd: string,
  dirStack: string[],
  knownEnv: Record<string, string | undefined>,
  runtime: OverrideRuntime,
  state: OverrideState,
  depth: number,
): Promise<{ readonly exitCode: number; readonly cwd: string; readonly prevCwd: string }> {
  let cwd = initialCwd;
  let prevCwd = initialPrevCwd;
  const procFs: ProcFsReader = runtime.procFs ?? defaultProcFs;
  const scopeStack: Array<{
    readonly cwd: string;
    readonly prevCwd: string;
    readonly dirStackLen: number;
    readonly envSnap: Record<string, string | undefined>;
  }> = [];

  for (const seg of splitShellSegments(command)) {
    if (seg.text === SCOPE_PUSH) {
      scopeStack.push({ cwd, prevCwd, dirStackLen: dirStack.length, envSnap: { ...knownEnv } });
      continue;
    }
    if (seg.text === SCOPE_POP) {
      const snap = scopeStack.pop();
      if (snap) {
        cwd = snap.cwd;
        prevCwd = snap.prevCwd;
        dirStack.length = snap.dirStackLen;
        for (const k of Object.keys(knownEnv)) delete knownEnv[k];
        Object.assign(knownEnv, snap.envSnap);
      }
      continue;
    }

    // Scan command substitutions $(...) / `...` first.
    const substs = extractCommandSubstitutions(seg.text);
    for (const inner of substs) {
      if (depth >= MAX_SHELL_DEPTH) {
        throw new ShellNestingError("command substitution exceeds max nesting depth");
      }
      const subRes = await checkLineRecursive(
        inner,
        cwd,
        prevCwd,
        [...dirStack],
        { ...knownEnv },
        runtime,
        state,
        depth + 1,
      );
      if (subRes.exitCode !== 0) return { exitCode: subRes.exitCode, cwd, prevCwd };
    }

    const rawWords = tokenizeSimpleCommand(seg.text);
    if (rawWords.length === 0) continue;

    if (rawWords[0] === "export") {
      for (const w of rawWords.slice(1)) {
        const eq = w.indexOf("=");
        if (eq > 0) knownEnv[w.slice(0, eq)] = w.slice(eq + 1);
      }
      continue;
    }
    if (rawWords[0] === "unset") {
      for (const w of rawWords.slice(1)) {
        if (!w.startsWith("-")) delete knownEnv[w];
      }
      continue;
    }

    const { command: words, assigned } = unwrapCommand(rawWords);
    const segEnv: NodeJS.ProcessEnv = { ...knownEnv, ...assigned };
    if (words.length === 0) {
      Object.assign(knownEnv, assigned);
      continue;
    }

    if (words[0] === "cd" || words[0] === "pushd" || words[0] === "popd") {
      if (seg.persistsCwd) {
        const next = applyDirectoryChange(words, cwd, prevCwd, dirStack, segEnv);
        cwd = next.cwd;
        prevCwd = next.prevCwd;
      }
      continue;
    }

    // Recurse into `bash -c` / `sh -c` / `eval`.
    const nestedScripts = [...extractNestedShellScripts(words)];
    const evalBody = extractEvalScript(words);
    if (evalBody) nestedScripts.push(evalBody);
    for (const script of nestedScripts) {
      if (depth >= MAX_SHELL_DEPTH) {
        throw new ShellNestingError("nested shell script exceeds max nesting depth");
      }
      const subRes = await checkLineRecursive(
        script,
        cwd,
        prevCwd,
        [...dirStack],
        { ...segEnv },
        runtime,
        state,
        depth + 1,
      );
      if (subRes.exitCode !== 0) return { exitCode: subRes.exitCode, cwd, prevCwd };
    }

    const segRuntime: OverrideRuntime = { ...runtime, env: segEnv };
    const program = NodePath.basename(words[0]!);

    // 1. Command-line secrets (curl/wget/httpie/fly ssh)
    const argvCheck = checkArgvSecrets(words);
    if (argvCheck.verdict === "deny") {
      const ok = await handleRefusal(
        {
          guard: "argv",
          command: words,
          cwd,
          reason: argvCheck.reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }

    // 2. Direct invocation or copy of real gh bypassing shim
    const copiesRealGh =
      COPIER_PROGS.has(program) && words.slice(1).some((w) => isRealGhPath(w, cwd, runtime.config));
    if (copiesRealGh || isRealGhPath(words[0]!, cwd, runtime.config)) {
      const what = copiesRealGh ? "a copy of the real gh" : "the real gh by its path";
      const reason = `host guard: refusing \`${words.join(" ").slice(0, 80)}\`: ${what} skips the gh shim. Call \`gh\`.`;
      const ok = await handleRefusal(
        { guard: "gh", command: words, cwd, reason, allowBlocking: false },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
      continue;
    }

    // 3. Git / gh guards
    if (program === "git" || program === "gh") {
      const bypasses = words[0]!.includes("/");
      const rc = await enforceDirectGuard(program, words.slice(1), cwd, segRuntime, {
        fromHook: true,
        bypassesPathShim: bypasses,
      });
      if (rc !== 0) return { exitCode: rc, cwd, prevCwd };
    }

    // 4. Storage hygiene install / worktree add guard
    const installVerdict = decideInstallTokens(words, cwd, runtime.config);
    if (installVerdict.verdict === "deny") {
      const ok = await handleRefusal(
        {
          guard: "home-dev-install",
          command: words,
          cwd,
          reason: installVerdict.reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }

    // 5. Tree guard (gates & test runners)
    const treeVerdict = decideTreeGuard(
      { kind: "auto", args: words, cwd },
      runtime.config,
      segEnv,
      procFs,
    );
    if (treeVerdict.verdict === "deny") {
      const ok = await handleRefusal(
        {
          guard: "tree-guard",
          command: words,
          cwd,
          reason: treeVerdict.reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }

    // 6. Ports guard (docker / explicit port binds)
    const portsVerdict = decidePortsCheck(words, cwd, assigned);
    if (portsVerdict.verdict === "deny") {
      const ok = await handleRefusal(
        {
          guard: "ports-guard",
          command: words,
          cwd,
          reason: portsVerdict.reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }

    // 7. EAS release guard
    if (program === "eas") {
      const relVerdict = decideReleaseGuard(words.slice(1), cwd, runtime.config, procFs);
      if (relVerdict.verdict === "deny") {
        const ok = await handleRefusal(
          {
            guard: "release-guard",
            command: words,
            cwd,
            reason: relVerdict.reason,
            allowBlocking: false,
          },
          segRuntime,
          state,
        );
        if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
      }
    }

    // 8. Cloud CLI guard (fly/flyctl/doppler)
    const cloudVerdict = decideCloudCli(words, cwd, runtime.config, procFs);
    if (cloudVerdict.verdict === "deny") {
      const ok = await handleRefusal(
        {
          guard: "cloud-cli",
          command: words,
          cwd,
          reason: cloudVerdict.reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }

    // 9. Manual execution of declared merge drills
    if (isManualMergeDrill(words, cwd, runtime.config)) {
      const reason = formatMergeRefusal(
        `the repo's merge drill (${words.join(" ")}) run by hand`,
        inspectRepo(cwd, runtime.config, segEnv),
        runtime.config,
      );
      const ok = await handleRefusal(
        {
          guard: "merge-drill",
          command: words,
          cwd,
          reason,
          allowBlocking: false,
        },
        segRuntime,
        state,
      );
      if (!ok) return { exitCode: REFUSED_EXIT_CODE, cwd, prevCwd };
    }
  }

  return { exitCode: 0, cwd, prevCwd };
}

export async function checkHookCommandLine(
  command: string,
  cwd: string,
  runtime: OverrideRuntime,
): Promise<number> {
  const env = runtime.env ?? process.env;
  const writeErr = runtime.writeErr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const state = createOverrideState();
  try {
    const res = await checkLineRecursive(
      command,
      cwd,
      env.OLDPWD || cwd,
      [],
      { ...env },
      runtime,
      state,
      0,
    );
    return res.exitCode;
  } catch (err) {
    if (err instanceof ShellNestingError) {
      writeErr(`host guard: refusing command: ${err.message}.`);
      return REFUSED_EXIT_CODE;
    }
    throw err;
  }
}

export async function runPreToolUseHook(
  stdinText: string,
  fallbackCwd: string,
  runtime: OverrideRuntime,
): Promise<number> {
  if (!stdinText.trim()) return 0;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdinText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    payload = parsed as Record<string, unknown>;
  } catch {
    return 0;
  }

  const toolName = String(payload.tool_name ?? payload.toolName ?? "");
  if (!HOOK_BASH_TOOLS.has(toolName)) return 0;

  const toolInput = (payload.tool_input ?? payload.toolInput ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : fallbackCwd;

  if (!command.trim() || !NodeFS.existsSync(cwd)) return 0;
  return checkHookCommandLine(command, cwd, runtime);
}
