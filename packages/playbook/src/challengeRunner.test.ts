// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Tests for the standalone playbook challenge CLI runner and provider builders.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildProviderInvocation,
  normalizeCodexEffort,
  pickLatestAstraFromCatalog,
  readCachedCodexAstraModel,
  readHostChallengeConfig,
} from "./challengeProviders.ts";
import { PLAYBOOK_CHALLENGE_JSON_SCHEMA, PlaybookChallengeReply } from "./challengeReply.ts";
import {
  computeChallengeTimeouts,
  createCliChallengeModel,
  extractStreamResultText,
  extractTurnDoneExitCode,
} from "./challengeRunner.ts";
import { cleanupTempDirs, makeTempDir } from "./testing/fixtureRepo.ts";

afterEach(cleanupTempDirs);

const VALID_REPLY = {
  acceptable: true,
  summary: "Clean compliance pass",
  bypass_detected: false,
  playbook_friction: false,
  violations: [],
  rejected_rises: [],
  rises_accepted: false,
  defects: [],
};

function writeExecutable(dir: string, name: string, script: string): string {
  const filePath = NodePath.join(dir, name);
  NodeFS.writeFileSync(filePath, script, { mode: 0o755 });
  return filePath;
}

describe("challengeRunner", () => {
  it("reads host-config.json defaults, fallbacks, timeout bounds, and explicit disable", () => {
    const dir = makeTempDir("pb-runner-cfg-");
    const missing = readHostChallengeConfig({
      PLAYBOOK_HOST_CONFIG: NodePath.join(dir, "missing.json"),
    });
    expect(missing.timeoutSec).toBe(900);
    expect(missing.candidates).toEqual([
      { provider: "codex", model: "auto:astra", effort: "medium" },
    ]);

    const disabledPath = NodePath.join(dir, "disabled.json");
    NodeFS.writeFileSync(disabledPath, JSON.stringify({ playbook_challenge: null }));
    expect(readHostChallengeConfig({ PLAYBOOK_HOST_CONFIG: disabledPath }).candidates).toEqual([]);

    const customPath = NodePath.join(dir, "custom.json");
    NodeFS.writeFileSync(
      customPath,
      JSON.stringify({
        challenge_timeout_s: 300,
        playbook_challenge: {
          default: { provider: "openai", model: "auto:astra", effort: "HIGH" },
          fallbacks: [{ provider: "claude", model: "claude-opus-5-5", effort: "medium" }],
        },
      }),
    );
    expect(readHostChallengeConfig({ PLAYBOOK_HOST_CONFIG: customPath })).toEqual({
      timeoutSec: 300,
      candidates: [
        { provider: "codex", model: "auto:astra", effort: "high" },
        { provider: "claudeAgent", model: "claude-opus-5-5", effort: "medium" },
      ],
    });
  });

  it("scales total and idle timeouts with prompt size within host bounds", () => {
    expect(computeChallengeTimeouts(10_000, 300)).toEqual({ totalMs: 300_000, idleMs: 180_000 });
    expect(computeChallengeTimeouts(45_000, 300)).toEqual({ totalMs: 400_000, idleMs: 180_000 });
    expect(computeChallengeTimeouts(10_000, 60)).toEqual({ totalMs: 60_000, idleMs: 60_000 });
  });

  it("selects the latest listed API-supported Astra model matching the requested effort", () => {
    const catalog = JSON.stringify({
      models: [
        {
          slug: "gpt-6.9-astra",
          visibility: "hide",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        {
          slug: "gpt-6-astra",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        {
          slug: "gpt-6.2-astra",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
        },
        {
          slug: "gpt-6.10-astra",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "low" }],
        },
      ],
    });
    expect(pickLatestAstraFromCatalog(catalog, "medium")).toBe("gpt-6.2-astra");
    expect(() => pickLatestAstraFromCatalog(catalog, "xhigh")).toThrow(/no Astra model/);
  });

  it("extracts turn completion codes and structured output from NDJSON streams", () => {
    expect(extractTurnDoneExitCode('{"type":"turn.completed"}')).toBe(0);
    expect(extractTurnDoneExitCode('{"type":"turn.failed"}')).toBe(1);
    expect(extractTurnDoneExitCode('{"type":"result","structured_output":{}}')).toBe(0);
    expect(extractTurnDoneExitCode('{"type":"result","is_error":true}')).toBe(1);
    expect(extractTurnDoneExitCode('{"type":"item.started"}')).toBeNull();

    const claudeStream = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}',
      JSON.stringify({ type: "result", structured_output: VALID_REPLY }),
    ].join("\n");
    expect(JSON.parse(extractStreamResultText(claudeStream))).toEqual(VALID_REPLY);

    const codexStream = [
      '{"type":"thread.started"}',
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(VALID_REPLY) },
      }),
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(JSON.parse(extractStreamResultText(codexStream))).toEqual(VALID_REPLY);
  });

  it("builds read-only provider invocations with strict schema parity and deny rules", () => {
    const schemaKeys = Object.keys(PLAYBOOK_CHALLENGE_JSON_SCHEMA.properties).toSorted();
    const effectKeys = Object.keys(PlaybookChallengeReply.fields).toSorted();
    expect(schemaKeys).toEqual(effectKeys);
    expect([...PLAYBOOK_CHALLENGE_JSON_SCHEMA.required].toSorted()).toEqual(effectKeys);
    expect(schemaKeys).not.toContain("diagnosis");
    expect(schemaKeys).not.toContain("analysis");
    expect(schemaKeys).not.toContain("recommendation");
    expect(normalizeCodexEffort("ultrathink")).toBe("xhigh");
    expect(normalizeCodexEffort("minimal")).toBe("low");
    expect(normalizeCodexEffort("bogus")).toBe("medium");

    const work = makeTempDir("pb-inv-");
    NodeFS.writeFileSync(
      NodePath.join(work, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-6.2-astra",
            visibility: "list",
            supported_in_api: true,
            supported_reasoning_levels: [{ effort: "medium" }],
          },
        ],
      }),
    );
    expect(readCachedCodexAstraModel("medium", { CODEX_HOME: work })).toBe("gpt-6.2-astra");

    const codexInv = buildProviderInvocation({
      candidate: { provider: "codex", model: "auto:astra", effort: "ultrathink" },
      binary: "/usr/bin/codex",
      cwd: work,
      prompt: "review me",
      workDir: work,
      env: {},
      resolvedCodexModel: "gpt-6.2-astra",
    });
    expect(codexInv.resolvedModel).toBe("gpt-6.2-astra");
    expect(codexInv.resolvedEffort).toBe("xhigh");
    expect(codexInv.args).toContain("read-only");
    expect(codexInv.args).toContain("project_doc_max_bytes=0");
    expect(codexInv.answerFile).toBe(NodePath.join(work, "answer.txt"));

    const claudeInv = buildProviderInvocation({
      candidate: { provider: "claudeAgent", model: "claude-opus-5-5", effort: "medium" },
      binary: "/usr/bin/claude",
      cwd: work,
      prompt: "review me",
      workDir: work,
      env: { HOME: work },
    });
    expect(claudeInv.args).toContain("--safe-mode");
    expect(claudeInv.args).toContain("Read,Glob,Grep");
    expect(claudeInv.args).toContain("--restricted");
    const settingsIdx = claudeInv.args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    const claudeSettings = JSON.parse(
      NodeFS.readFileSync(claudeInv.args[settingsIdx + 1]!, "utf8"),
    ) as { permissions?: { deny?: string[] } };
    expect(claudeSettings.permissions?.deny).toContain("Read(~/.ssh/**)");
  });

  it("falls back to the next configured candidate when the primary exits non-zero", async () => {
    const dir = makeTempDir("pb-live-");
    const binDir = NodePath.join(dir, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    writeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
if [ "$1" = "debug" ]; then
  printf '{"models":[{"slug":"gpt-6.2-astra","visibility":"list","supported_in_api":true,"supported_reasoning_levels":[{"effort":"medium"}]}]}\\n'
  exit 0
fi
echo "rate limit exceeded" >&2
exit 1
`,
    );
    writeExecutable(
      binDir,
      "claude",
      `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '${JSON.stringify({ type: "result", structured_output: VALID_REPLY })}'
`,
    );
    const cfgPath = NodePath.join(dir, "host-config.json");
    NodeFS.writeFileSync(
      cfgPath,
      JSON.stringify({
        challenge_timeout_s: 60,
        playbook_challenge: {
          default: { provider: "codex", model: "auto:astra", effort: "medium" },
          fallbacks: [{ provider: "claudeAgent", model: "claude-opus-5-5", effort: "medium" }],
        },
      }),
    );
    const model = createCliChallengeModel({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: dir,
      PLAYBOOK_HOST_CONFIG: cfgPath,
    });
    expect(model).not.toBeNull();
    const res = await model!({ cwd: dir, prompt: "check compliance" });
    expect(res.fallbackUsed).toBe(true);
    expect(res.reviewer).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "medium",
    });
    expect(res.reply.acceptable).toBe(true);
  });

  it("kills the reviewer process group cleanly when aborted", async () => {
    const dir = makeTempDir("pb-abort-");
    const binDir = NodePath.join(dir, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    writeExecutable(
      binDir,
      "codex",
      `#!/usr/bin/env bash
sleep 30
`,
    );
    const cfgPath = NodePath.join(dir, "host-config.json");
    NodeFS.writeFileSync(
      cfgPath,
      JSON.stringify({
        challenge_timeout_s: 60,
        playbook_challenge: {
          default: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" },
          fallbacks: [],
        },
      }),
    );
    const model = createCliChallengeModel({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: dir,
      PLAYBOOK_HOST_CONFIG: cfgPath,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(model!({ cwd: dir, prompt: "hi", signal: ac.signal })).rejects.toThrow(
      /cancelled/,
    );
  });
});
