// @effect-diagnostics nodeBuiltinImport:off - Standalone `marscode-host-guard` CLI entry point dispatching all host guards.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { resolveGuardSocketPath } from "@t3tools/guard-protocol/client";

import { checkArgvSecrets } from "./argvGuard.ts";
import { decideCloudCli } from "./cloudCliGuard.ts";
import { runGhSubcommand } from "./ghRun.ts";
import { enforceDirectGuard, REFUSED_EXIT_CODE, runPreToolUseHook } from "./hook.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import { decideInstallTokens, extractPackageScript } from "./installGuard.ts";
import {
  createOverrideState,
  overrideHint,
  ownerAllowed,
  recordRefusal,
  requestOverrideGrant,
  type OverrideRuntime,
} from "./override.ts";
import { decidePortsCheck, runPortsSessionHook } from "./portsGuard.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import { resolveT3ServerPid, resolveT3ThreadId } from "./t3ServerTrust.ts";
import { decideReleaseGuard } from "./releaseGuard.ts";
import { checkShimDepth } from "./shimDepth.ts";
import { decideTreeGuard, type TreeGuardKind } from "./treeGuard.ts";

const HOST_GUARDS_VERSION = "1.0.0";
/** Probed by the hygiene receipt (`text-guard` layer, PLAYBOOK §16.8). */
const CAPABILITIES = ["git-guard", "gh-guard", "gh-attribution", "text-guard"] as const;

export interface CliIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string | undefined;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly procFs?: ProcFsReader | undefined;
  /** Programmatic DI for tests only; production `bin.ts` never sets these. */
  readonly configPath?: string | undefined;
  readonly socketPath?: string | undefined;
  readonly allowTestOverride?: boolean | undefined;
  readonly allowEnvThreadId?: boolean | undefined;
  readonly testMode?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

function readStdinSync(): string {
  try {
    return NodeFS.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function splitCwdAndRest(
  args: ReadonlyArray<string>,
  fallbackCwd: string,
): {
  readonly cwd: string;
  readonly rest: ReadonlyArray<string>;
} {
  let cwd = fallbackCwd;
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1]!;
      i += 1;
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }
    out.push(a);
  }
  return { cwd, rest: out };
}

async function enforceVerdict(
  guard: string,
  command: ReadonlyArray<string>,
  cwd: string,
  reason: string,
  runtime: OverrideRuntime,
): Promise<number> {
  const state = createOverrideState();
  const ok = await requestOverrideGrant(
    { guard, command, cwd, refusal: reason, allowBlocking: true },
    runtime,
    state,
  );
  if (ok) return 0;
  recordRefusal({ guard, command, cwd, refusal: reason }, runtime, state);
  runtime.writeErr?.(`${reason}\n${overrideHint(cwd, runtime, state)}`);
  return REFUSED_EXIT_CODE;
}

function runSelfCheck(config: HostGuardsConfig, io: CliIo, jsonMode: boolean): number {
  const procFs = io.procFs ?? defaultProcFs;
  const socketPath =
    io.socketPath !== undefined
      ? io.socketPath || null
      : resolveGuardSocketPath(io.env, { allowTestOverride: io.allowTestOverride === true });
  const serverPid = resolveT3ServerPid({
    procFs,
    socketPath: socketPath ?? undefined,
  });
  const threadId = resolveT3ThreadId(io.env, {
    procFs,
    socketPath: socketPath ?? undefined,
    allowEnvThreadId: io.allowEnvThreadId,
  });
  const identity = resolveCallerIdentity({
    env: io.env,
    testMode: io.testMode,
    procFs,
    t3ServerPid: serverPid,
  });
  const gitOk = NodeFS.existsSync(config.realGit);
  const ghOk = NodeFS.existsSync(config.realGh);
  const depthProbe = checkShimDepth("self-check", config.realGit, io.env);

  const report = {
    ok: gitOk && depthProbe.ok,
    version: HOST_GUARDS_VERSION,
    runtime: "node",
    pythonRequired: false,
    configPath: config.configPath,
    configExists: NodeFS.existsSync(config.configPath),
    orgs: config.orgs,
    sourceRoot: config.sourceRoot,
    dataRoot: config.dataRoot,
    stateDir: config.stateDir,
    realGit: { path: config.realGit, exists: gitOk },
    realGh: { path: config.realGh, exists: ghOk },
    guardSocket: socketPath,
    serverPid,
    threadId: threadId || null,
    caller: identity,
    shimDepthOk: depthProbe.ok,
  };

  if (jsonMode) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(
      [
        `marscode-host-guard ${HOST_GUARDS_VERSION} (native TypeScript, zero Python runtime)`,
        `  config: ${config.configPath} (${report.configExists ? "loaded" : "defaults"})`,
        `  orgs: ${config.orgs.join(", ") || "(none configured)"}`,
        `  sourceRoot: ${config.sourceRoot}`,
        `  dataRoot: ${config.dataRoot}`,
        `  realGit: ${config.realGit} (${gitOk ? "ok" : "MISSING"})`,
        `  realGh: ${config.realGh} (${ghOk ? "ok" : "missing"})`,
        `  guardSocket: ${socketPath ?? "not active"}`,
        `  serverPid: ${serverPid ?? "none"}`,
      ].join("\n"),
    );
  }
  return report.ok ? 0 : 1;
}

function parseTreeCheckArgs(
  args: ReadonlyArray<string>,
  fallbackCwd: string,
): {
  readonly kind?: TreeGuardKind | undefined;
  readonly script?: string | undefined;
  readonly cwd: string;
  readonly commandArgs: ReadonlyArray<string>;
} {
  let kind: TreeGuardKind | undefined;
  let script: string | undefined;
  let cwd = fallbackCwd;
  let commandArgs: ReadonlyArray<string> = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      commandArgs = args.slice(i + 1);
      break;
    }
    if (a === "--kind" && i + 1 < args.length) {
      const val = args[i + 1]!;
      if (val === "test" || val === "gate" || val === "auto" || val === "push") {
        kind = val;
      }
      i += 1;
      continue;
    }
    if (a === "--script" && i + 1 < args.length) {
      script = args[i + 1]!;
      i += 1;
      continue;
    }
    if (a === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1]!;
      i += 1;
      continue;
    }
    if (a === "--skip-caller") continue;
    commandArgs = args.slice(i);
    break;
  }
  return { kind, script, cwd, commandArgs };
}

function usageText(): string {
  return [
    "usage: marscode-host-guard <command> [args...]",
    "commands:",
    "  git-check [--cwd DIR] [--] <git-args...>",
    "  gh-check [--cwd DIR] [--] <gh-args...>",
    "  gh-run [--cwd DIR] [--real-gh PATH] [--] <gh-args...>",
    "  install-check [--cwd DIR] [--with-tree] [--] <cmd...>",
    "  tree-check [--kind test|gate|auto|push] [--script NAME] [--cwd DIR] [--] <args...>",
    "  ports-check [--cwd DIR] [--] <cmd...>",
    "  ports-session <claude|grok|codex>",
    "  release-check [--cwd DIR] [--] <eas-args...>",
    "  cloud-check [--cwd DIR] [--] <cmd...>",
    "  argv-check [--cwd DIR] [--] <cmd...>",
    "  hook",
    "  override <guard> <refusal> [--cwd DIR] [--] <cmd...>",
    "  owner-check <action> [--cwd DIR] [--] [cmd...]",
    "  hint [--cwd DIR]",
    "  self-check [--json]",
    "  capabilities",
    "  version",
  ].join("\n");
}

export async function runHostGuardCli(argv: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const [sub, ...args] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    io.out(usageText());
    return 0;
  }
  if (sub === "version" || sub === "--version" || sub === "-v") {
    io.out(HOST_GUARDS_VERSION);
    return 0;
  }
  if (sub === "capabilities") {
    io.out(CAPABILITIES.join("\n"));
    return 0;
  }

  const config = loadHostConfig({
    configPath: io.configPath,
  });
  const runtime: OverrideRuntime = {
    config,
    env: io.env,
    procFs: io.procFs,
    now: io.now,
    writeErr: io.err,
    socketPath: io.socketPath,
    allowTestOverride: io.allowTestOverride === true,
    allowEnvThreadId: io.allowEnvThreadId === true,
    testMode: io.testMode === true,
  };

  if (sub === "self-check") {
    return runSelfCheck(config, io, args.includes("--json"));
  }

  if (sub === "hint") {
    const { cwd } = splitCwdAndRest(args, io.cwd);
    io.out(overrideHint(cwd, runtime));
    return 0;
  }

  if (sub === "hook") {
    const stdin = io.stdin ?? readStdinSync();
    return runPreToolUseHook(stdin, io.cwd, runtime);
  }

  if (sub === "ports-session") {
    const agent = args[0] ?? "";
    if (!agent || !["claude", "grok", "codex"].includes(agent)) {
      io.err("usage: marscode-host-guard ports-session <claude|grok|codex>");
      return 64;
    }
    const stdin = io.stdin ?? readStdinSync();
    const res = runPortsSessionHook({ agent, stdinText: stdin, cwd: io.cwd, env: io.env });
    if (res.stdout) io.out(res.stdout.replace(/\n$/, ""));
    return res.exitCode;
  }

  if (sub === "git-check" || sub === "git") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    return enforceDirectGuard("git", rest, cwd, runtime);
  }

  if (sub === "gh-check" || sub === "gh") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    return enforceDirectGuard("gh", rest, cwd, runtime);
  }

  if (sub === "gh-run") {
    return runGhSubcommand(args, config, runtime, io);
  }

  if (sub === "argv-check") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const decision = checkArgvSecrets(rest);
    if (decision.verdict === "allow") return 0;
    return enforceVerdict("argv", rest, cwd, decision.reason, runtime);
  }

  if (sub === "install-check") {
    let withTree = false;
    const filtered: string[] = [];
    for (const a of args) {
      if (a === "--with-tree") {
        withTree = true;
      } else {
        filtered.push(a);
      }
    }
    const { cwd, rest } = splitCwdAndRest(filtered, io.cwd);
    const decision = decideInstallTokens(rest, cwd, config);
    if (decision.verdict === "deny") {
      return enforceVerdict("home-dev-install", rest, cwd, decision.reason, runtime);
    }
    if (withTree && rest.length > 0) {
      const pkg = extractPackageScript(rest[0]!, rest.slice(1), cwd);
      if (pkg.script) {
        const treeVerdict = decideTreeGuard(
          { script: pkg.script, cwd: pkg.directory },
          config,
          io.env,
          io.procFs,
        );
        if (treeVerdict.verdict === "deny") {
          return enforceVerdict("tree-guard", rest, pkg.directory, treeVerdict.reason, runtime);
        }
      }
    }
    return 0;
  }

  if (sub === "tree-check") {
    const parsed = parseTreeCheckArgs(args, io.cwd);
    const decision = decideTreeGuard(
      {
        kind: parsed.kind,
        script: parsed.script,
        args: parsed.commandArgs,
        cwd: parsed.cwd,
      },
      config,
      io.env,
      io.procFs,
    );
    if (decision.verdict === "allow") return 0;
    const cmd =
      parsed.commandArgs.length > 0
        ? parsed.commandArgs
        : [parsed.script || parsed.kind || "tree-check"];
    return enforceVerdict("tree-guard", cmd, parsed.cwd, decision.reason, runtime);
  }

  if (sub === "ports-check") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const decision = decidePortsCheck(rest, cwd);
    if (decision.verdict === "allow") return 0;
    return enforceVerdict("ports-guard", rest, cwd, decision.reason, runtime);
  }

  if (sub === "release-check") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const decision = decideReleaseGuard(rest, cwd, config, io.procFs);
    if (decision.verdict === "allow") return 0;
    return enforceVerdict("release-guard", ["eas", ...rest], cwd, decision.reason, runtime);
  }

  if (sub === "cloud-check") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const argvDecision = checkArgvSecrets(rest);
    if (argvDecision.verdict === "deny") {
      return enforceVerdict("argv", rest, cwd, argvDecision.reason, runtime);
    }
    const decision = decideCloudCli(rest, cwd, config, io.procFs);
    if (decision.verdict === "allow") return 0;
    const guardName = NodePath.basename(rest[0] ?? "")
      .toLowerCase()
      .startsWith("fly")
      ? "fly-deploy"
      : "cloud-cli";
    return enforceVerdict(guardName, rest, cwd, decision.reason, runtime);
  }

  if (sub === "override") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const guard = rest[0] ?? "";
    const refusal = rest[1] ?? "";
    const cmd = rest.slice(2);
    if (!guard || !refusal) {
      io.err("usage: marscode-host-guard override <guard> <refusal> [--cwd DIR] [--] <cmd...>");
      return 64;
    }
    const state = createOverrideState();
    const ok = await requestOverrideGrant(
      { guard, command: cmd.length > 0 ? cmd : [guard], cwd, refusal, allowBlocking: true },
      runtime,
      state,
    );
    if (ok) return 0;
    recordRefusal({ guard, command: cmd.length > 0 ? cmd : [guard], cwd, refusal }, runtime, state);
    io.err(overrideHint(cwd, runtime, state));
    return 1;
  }

  if (sub === "owner-check") {
    const { cwd, rest } = splitCwdAndRest(args, io.cwd);
    const action = rest[0] ?? "";
    if (!action) {
      io.err("usage: marscode-host-guard owner-check <action> [--cwd DIR] [--] [cmd...]");
      return 64;
    }
    const cmd = rest.slice(1);
    const ok = await ownerAllowed(action, cwd, runtime, {
      command: cmd.length > 0 ? cmd : [action],
    });
    return ok ? 0 : REFUSED_EXIT_CODE;
  }

  io.err(`marscode-host-guard: unknown subcommand '${sub}'\n${usageText()}`);
  return 64;
}
