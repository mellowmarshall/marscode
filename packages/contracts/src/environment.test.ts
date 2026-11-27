import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionEnvironmentDescriptor,
  repositoryGroupingDisplayNameOf,
  type RepositoryIdentity,
} from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [
      { kind: "npx" },
      { kind: "npm-global", prefix: "/opt/node" },
      { kind: "t3-launcher", launcher: "/opt/bin/t3", baseDir: "/data/t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    const spaced = { kind: "t3-launcher", launcher: "/opt/bin/t3 ", baseDir: " /data/t3 " };
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, serverInstallation: spaced },
      }).capabilities.serverInstallation,
    ).toEqual(spaced);
    for (const installation of [
      { kind: "future-manager" },
      { kind: "npm-global" },
      { kind: "t3-launcher", launcher: "t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});

describe("repositoryGroupingDisplayNameOf", () => {
  const identity = (overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity => ({
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/t3tools/t3code.git",
    },
    displayName: "t3tools/t3code",
    ...overrides,
  });

  it("strips the owner path by default and keeps it when qualified", () => {
    expect(repositoryGroupingDisplayNameOf(identity())).toBe("t3code");
    expect(repositoryGroupingDisplayNameOf(identity(), { qualified: true })).toBe("t3tools/t3code");
  });

  it("names a fork by its origin, with or without an origin display name", () => {
    const origin = { canonicalKey: "github.com/julius/t3code-fork" };
    expect(repositoryGroupingDisplayNameOf(identity({ origin }))).toBe("t3code-fork");
    expect(repositoryGroupingDisplayNameOf(identity({ origin }), { qualified: true })).toBe(
      "github.com/julius/t3code-fork",
    );
    expect(
      repositoryGroupingDisplayNameOf(
        identity({ origin: { ...origin, displayName: "julius/t3code-fork" } }),
      ),
    ).toBe("t3code-fork");
  });

  it("handles nested paths, names without an owner, trailing slashes and no name", () => {
    expect(
      repositoryGroupingDisplayNameOf(identity({ displayName: "org/project/_git/service" })),
    ).toBe("service");
    expect(repositoryGroupingDisplayNameOf(identity({ displayName: "group/sub/repo" }))).toBe(
      "repo",
    );
    expect(repositoryGroupingDisplayNameOf(identity({ displayName: "T3 Code" }))).toBe("T3 Code");
    expect(repositoryGroupingDisplayNameOf(identity({ displayName: "owner/repo/" }))).toBe("repo");
    const { displayName: _omitted, ...withoutDisplayName } = identity();
    expect(repositoryGroupingDisplayNameOf(withoutDisplayName)).toBeUndefined();
  });
});
