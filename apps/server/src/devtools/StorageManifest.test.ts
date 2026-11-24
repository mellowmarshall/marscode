// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { buildStorageManifest, writeStorageManifest } from "./StorageManifest.ts";

describe("StorageManifest", () => {
  it("classifies built-in and custom providers into history vs ephemeral roots", () => {
    const manifest = buildStorageManifest({
      baseDir: "/home/alice/.t3",
      stateDir: "/home/alice/.t3/userdata",
      worktreesDir: "/home/alice/.t3/worktrees",
      dbPath: "/home/alice/.t3/userdata/statev2.sqlite",
      attachmentsDir: "/home/alice/.t3/userdata/attachments",
      logsDir: "/home/alice/.t3/userdata/logs",
      browserArtifactsDir: "/home/alice/.t3/userdata/browser-artifacts",
      homeDir: "/home/alice",
      host: "workstation-1.local",
      now: "2026-11-21T20:00:00.000Z",
      env: {},
      providerInstances: {
        codex_alt: {
          driver: "codex",
          displayName: "Codex Alt",
          enabled: true,
          config: { homePath: "~/custom-codex", shadowHomePath: "~/shadow-codex" },
        } as never,
        antigravity: {
          driver: "antigravity",
          displayName: "Antigravity",
          enabled: true,
          config: {},
        } as never,
      },
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.host).toBe("workstation-1");

    const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    expect(byId.get("codex:codex_alt:sessions")).toMatchObject({
      trust: "history",
      kind: "session-files",
      path: "/home/alice/custom-codex/sessions",
      extensions: [".jsonl", ".jsonl.zst"],
      tierAction: "move",
    });
    expect(byId.get("codex:codex_alt:shadow-tmp")).toMatchObject({
      trust: "ephemeral",
      kind: "temp-dir",
      path: "/home/alice/shadow-codex/tmp",
    });
    expect(byId.get("claudeAgent:claudeAgent:projects")).toMatchObject({
      trust: "history",
      path: "/home/alice/.claude/projects",
    });
    const agBrain = byId.get("antigravity:antigravity:brain");
    expect(agBrain?.trust).toBe("history");
    expect(agBrain?.kind).toBe("session-dirs");
    expect(agBrain?.path).toContain("/home/alice/.t3/userdata/providers/antigravity/");
    expect(byId.get("antigravity:antigravity:runtime-temp")?.trust).toBe("ephemeral");
    expect(byId.get("t3code:state-db")?.tierAction).toBe("protect-only");
  });

  it("writes storage-manifest.json atomically", async () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-manifest-"));
    try {
      const target = NodePath.join(tmp, "nested", "storage-manifest.json");
      const manifest = buildStorageManifest({
        baseDir: "/tmp/t3",
        stateDir: "/tmp/t3/userdata",
        worktreesDir: "/tmp/t3/worktrees",
        dbPath: "/tmp/t3/userdata/statev2.sqlite",
        attachmentsDir: "/tmp/t3/userdata/attachments",
        logsDir: "/tmp/t3/userdata/logs",
        browserArtifactsDir: "/tmp/t3/userdata/browser-artifacts",
        homeDir: "/tmp/home",
        env: {},
      });
      await writeStorageManifest(manifest, target);
      const parsed = JSON.parse(NodeFS.readFileSync(target, "utf8")) as { schemaVersion: number };
      expect(parsed.schemaVersion).toBe(1);
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
