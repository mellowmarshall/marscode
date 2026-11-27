import {
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { displayPath, formatFinding, loadDenylist, scanText } from "@t3tools/hygiene";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { stampAgentProse } from "@t3tools/shared/githubAttribution";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as RepositoryVisibility from "../../sourceControl/RepositoryVisibility.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

const GUIDANCE = "Rewrite the text with neutral placeholders (PLAYBOOK §16).";

/** Text bound for a public repository failed the §16 scan; carries class ids and lines only. */
export class GitHubTextRejectedError extends Schema.TaggedError<GitHubTextRejectedError>()(
  "GitHubTextRejectedError",
  { findings: Schema.Array(Schema.String), detail: Schema.String },
) {
  override get message(): string {
    return [this.detail, ...this.findings.map((finding) => `  ${finding}`), GUIDANCE].join("\n");
  }
}

/**
 * The forge repository a project's change request prose posts to: `at` (a resolved PR), or the
 * project's own remote. An unrecognised host reads as unknown visibility, so public.
 */
export function forgeTarget(
  project: OrchestrationProjectShell,
  at?: { readonly host: string; readonly repository: string },
): RepositoryVisibility.RepositoryTarget {
  const identity = project.repositoryIdentity;
  const kind = identity?.provider;
  const host =
    at?.host ??
    (identity && kind ? sourceControlDefinitions.changeRequestHost(identity, kind) : "");
  const repository =
    at?.repository ??
    (identity ? (sourceControlDefinitions.repositorySelector(identity) ?? "") : "");
  return {
    provider:
      sourceControlDefinitions.findByPublicHost(host)?.kind ??
      kind ??
      SourceControlProviderKind.make("unknown"),
    host,
    repository,
  };
}

export interface GitHubProseInput<Body extends string | undefined> {
  /** The repository the text posts to; `null` for a tracker that is not a repository. */
  readonly target: RepositoryVisibility.RepositoryTarget | null;
  readonly title?: string | undefined;
  readonly body: Body;
  /** Review line comments: scanned like the body, never stamped. */
  readonly comments?: ReadonlyArray<string> | undefined;
  readonly thread?: Pick<OrchestrationV2ThreadShell, "id" | "title"> | undefined;
}

/**
 * The one choke every MCP tool that posts forge prose calls: text bound for a public repository
 * (or one whose visibility is unknown) is scanned with the §16 rules and the host-local denylist,
 * then the body gets the calling agent's attribution stamp for that audience. Human UI paths
 * (`ws.ts`) never call this.
 */
export class McpGitHubProse extends Context.Service<
  McpGitHubProse,
  {
    readonly prepare: <Body extends string | undefined>(
      input: GitHubProseInput<Body>,
    ) => Effect.Effect<
      Body,
      GitHubTextRejectedError,
      McpInvocationContext.McpInvocationContext | Orchestrator.OrchestratorV2
    >;
  }
>()("t3/mcp/toolkits/githubProse/McpGitHubProse") {}

const stamp = Effect.fn("McpGitHubProse.stamp")(function* (
  body: string,
  audience: "public" | "private",
  knownThread: Pick<OrchestrationV2ThreadShell, "id" | "title"> | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const engine = yield* Orchestrator.OrchestratorV2;
  let thread = knownThread;
  if (thread === undefined && scope.thread !== undefined) {
    thread =
      (yield* engine
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.orElseSucceed(() => null))) ?? undefined;
  }
  const threadId = thread?.id ?? scope.thread?.threadId ?? scope.client?.senderThread?.threadId;
  const sessionId = scope.thread?.providerSessionId ?? scope.client?.sessionId;
  const displayName =
    thread?.title?.trim() ||
    scope.client?.senderThread?.title?.trim() ||
    scope.client?.label?.trim() ||
    undefined;
  return stampAgentProse(
    body,
    {
      ...(displayName ? { displayName } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(threadId ? { threadId } : {}),
    },
    { audience },
  );
});

const make = Effect.gen(function* () {
  const visibility = yield* RepositoryVisibility.RepositoryVisibility;

  const scan = Effect.fn("McpGitHubProse.scan")(function* (
    where: string,
    scope: string,
    texts: ReadonlyArray<{ readonly source: string; readonly text: string | undefined }>,
  ) {
    const env = yield* HostProcess.Environment;
    const denylist = loadDenylist(env);
    if (denylist.kind !== "loaded") {
      return yield* new GitHubTextRejectedError({
        findings: [],
        detail: `Text for ${where} (${scope}) was not posted: the private denylist at ${displayPath(denylist.path, env)} is ${denylist.kind}; it is required before text posts to a public repository (PLAYBOOK §16.3/§16.5).`,
      });
    }
    const findings = texts.flatMap(({ source, text }) =>
      text ? scanText(text, { source, surface: "github-text", denylist: denylist.rules }) : [],
    );
    if (findings.length > 0) {
      return yield* new GitHubTextRejectedError({
        findings: findings.map(formatFinding),
        detail: `Text for ${where} (${scope}) was not posted: ${findings.length} PLAYBOOK §16 finding(s):`,
      });
    }
  });

  const prepare = Effect.fn("McpGitHubProse.prepare")(function* <Body extends string | undefined>(
    input: GitHubProseInput<Body>,
  ) {
    const audience = input.target === null ? "private" : yield* visibility.of(input.target);
    if (audience !== "private") {
      yield* scan(
        input.target?.repository ?? "the repository",
        audience === "public" ? "public" : "visibility unknown, treated as public",
        [
          { source: "title", text: input.title },
          { source: "body", text: input.body },
          ...(input.comments ?? []).map((text, i) => ({ source: `comment-${i + 1}`, text })),
        ],
      );
    }
    if (input.body === undefined) return input.body;
    const stamped: string = yield* stamp(
      input.body,
      audience === "private" ? "private" : "public",
      input.thread,
    );
    return stamped as Body;
  });

  return McpGitHubProse.of({ prepare });
});

export const layer = Layer.effect(McpGitHubProse, make);
