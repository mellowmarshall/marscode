// @effect-diagnostics nodeBuiltinImport:off - Writes a neutral temp denylist the §16 scan reads from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  SourceControlProviderError,
  type SourceControlProviderKind,
  type SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fakeSourceControlProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as RepositoryVisibility from "../../sourceControl/RepositoryVisibility.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as McpGitHubProse from "./githubProse.ts";

export interface GitHubBoundary {
  /** Visibility the forge reports per lowercase `owner/name`. */
  readonly visibility?: Readonly<Record<string, SourceControlRepositoryVisibility>>;
  /** Default for any repo not listed; private keeps the titled stamp of older tests. */
  readonly fallback?: SourceControlRepositoryVisibility | null;
  readonly reads?: Array<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The real prose choke and visibility service, stubbed only where the forge answers: each
 * provider's `getRepositoryVisibility`.
 */
export const layer = (boundary: GitHubBoundary = {}) => {
  const provider = (kind: SourceControlProviderKind) =>
    fakeSourceControlProvider(kind, {
      getRepositoryVisibility: ({ cwd, repository }) => {
        boundary.reads?.push(repository.toLowerCase());
        const answer =
          boundary.visibility?.[repository.toLowerCase()] ??
          (boundary.fallback === undefined ? "private" : boundary.fallback);
        return answer === null
          ? Effect.fail(
              new SourceControlProviderError({
                provider: kind,
                operation: "getRepositoryVisibility",
                cwd,
                detail: "unreachable",
              }),
            )
          : Effect.succeed(answer);
      },
    });
  return Layer.mergeAll(
    McpGitHubProse.layer.pipe(
      Layer.provide(RepositoryVisibility.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            get: (kind) => Effect.succeed(provider(kind)),
          }),
          ServerConfig.layerTest("/workspace/project", { prefix: "mcp-prose-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
    Layer.succeed(HostProcess.Environment, boundary.env ?? { HOME: "/home/dev" }),
  );
};

/** A 0600 denylist with neutral patterns, removed when the test's scope closes. */
export const tempDenylist = (text: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-prose-"));
      const path = NodePath.join(dir, "public-hygiene.denylist");
      NodeFS.writeFileSync(path, text, { mode: 0o600 });
      return { dir, path };
    }),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.map(({ path }) => path));
