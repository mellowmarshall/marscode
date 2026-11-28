// @effect-diagnostics nodeBuiltinImport:off - Pending agent-proposed reaper rules, stored beside the reaper stamps and accepted into policy.toml.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ReaperRuleProposal,
  type ReaperRuleProposalView,
  type ReaperProposalDecision,
  type ReaperProposeRulesInput,
  type ReaperProposeRulesResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ReaperPolicy from "../ReaperPolicy.ts";
import * as StorageManifest from "../StorageManifest.ts";
import { manifestHistoryRoots } from "./ReaperPathGuard.ts";
import { scanProcessPaths } from "./ReaperProcPaths.ts";
import { previewRule } from "./ReaperRulePreview.ts";

const MAX_PENDING = 50;
const MAX_PENDING_PER_THREAD = 20;

export class ReaperProposalNotFoundError extends Schema.TaggedError<ReaperProposalNotFoundError>()(
  "ReaperProposalNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `No pending cleanup rule proposal ${this.id}.`;
  }
}

export class ReaperProposalRefusedError extends Schema.TaggedError<ReaperProposalRefusedError>()(
  "ReaperProposalRefusedError",
  { id: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ReaperProposalStoreError extends Schema.TaggedError<ReaperProposalStoreError>()(
  "ReaperProposalStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the cleanup rule proposals.`;
  }
}

export class ReaperProposals extends Context.Service<
  ReaperProposals,
  {
    /** Pending proposals, each with a dry-run of what it would remove now. */
    readonly list: Effect.Effect<ReadonlyArray<ReaperRuleProposalView>, ReaperProposalStoreError>;
    /** Queues rules that pass the policy's path checks; refused ones come back with the reason. */
    readonly propose: (
      input: ReaperProposeRulesInput & { readonly threadId?: ThreadId },
    ) => Effect.Effect<ReaperProposeRulesResult, ReaperProposalStoreError>;
    /** Accept writes the rule, turned off, through the policy writer; reject drops it. */
    readonly decide: (
      input: ReaperProposalDecision,
    ) => Effect.Effect<
      ReadonlyArray<ReaperRuleProposalView>,
      ReaperProposalNotFoundError | ReaperProposalRefusedError | ReaperProposalStoreError
    >;
    /** The user's own save of the whole rule list, under the same lock as accept. */
    readonly savePolicy: (
      rules: ReadonlyArray<ReaperPolicy.ReaperPolicyRule>,
    ) => Effect.Effect<ReaperPolicy.ReaperPolicyDocument, ReaperProposalRefusedError>;
  }
>()("t3/devtools/reaper/ReaperProposals") {}

const StoreFile = Schema.Struct({ proposals: Schema.Array(ReaperRuleProposal) });
const StoreJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreJson);
const encodeStoreFile = Schema.encodeEffect(StoreJson);

const make = Effect.fn("ReaperProposals.make")(function* (options: {
  readonly policyPath: string;
  readonly homeDir: string;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const storePath = NodePath.join(config.stateDir, "reaper", "proposals.json");
  const permit = yield* Semaphore.make(1);
  const platform = yield* HostProcess.Platform;
  const uid = (yield* HostProcess.UserId) ?? -1;

  const manifest = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => ({ providerInstances: {} })),
    Effect.map((settings) => StorageManifest.buildStorageManifestFromSettings(config, settings)),
  );
  // The same roots the policy route protects when the user saves rules by hand.
  const protectedRoots = (m: StorageManifest.StorageManifest) =>
    m.entries.filter((e) => e.trust === "history").map((e) => e.path);

  // A file that does not decode is kept as `.corrupt` beside it, never silently dropped.
  const keepCorrupt = (text: string) =>
    Effect.logWarning(
      `Reaper proposals file did not decode; kept a copy at ${storePath}.corrupt`,
    ).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => NodeFSP.writeFile(`${storePath}.corrupt`, text, "utf8"),
          catch: (cause) => new ReaperProposalStoreError({ operation: "write", cause }),
        }),
      ),
      Effect.as([] as ReadonlyArray<ReaperRuleProposal>),
    );

  const readStore = Effect.tryPromise({
    try: () => NodeFSP.readFile(storePath, "utf8"),
    catch: (cause) => new ReaperProposalStoreError({ operation: "read", cause }),
  }).pipe(
    Effect.flatMap((text) => {
      const decoded = decodeStoreFile(text);
      return decoded._tag === "Some" ? Effect.succeed(decoded.value.proposals) : keepCorrupt(text);
    }),
    Effect.catchTags({
      ReaperProposalStoreError: (error) =>
        (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? Effect.succeed([])
          : Effect.fail(error),
    }),
  );

  const writeStore = (proposals: ReadonlyArray<ReaperRuleProposal>) =>
    encodeStoreFile({ proposals }).pipe(
      Effect.mapError((cause) => new ReaperProposalStoreError({ operation: "write", cause })),
      Effect.flatMap((text) =>
        Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(storePath), { recursive: true });
            const tmp = `${storePath}.tmp.${NodeCrypto.randomUUID()}`;
            await NodeFSP.writeFile(tmp, text, "utf8");
            await NodeFSP.rename(tmp, storePath);
          },
          catch: (cause) => new ReaperProposalStoreError({ operation: "write", cause }),
        }),
      ),
    );

  const withPreviews = Effect.fn("ReaperProposals.preview")(function* (
    proposals: ReadonlyArray<ReaperRuleProposal>,
  ) {
    if (proposals.length === 0) return [];
    const m = yield* manifest;
    const historyRoots = yield* Effect.promise(() => manifestHistoryRoots(m));
    const nowMs = yield* Clock.currentTimeMillis;
    const scan = yield* Effect.promise(() => scanProcessPaths({ uid, platform }));
    return yield* Effect.forEach(proposals, (proposal) =>
      Effect.promise(() =>
        previewRule(proposal, { scan, historyRoots, uid, nowMs, homeDir: options.homeDir }).catch(
          () => null,
        ),
      ).pipe(Effect.map((preview) => ({ ...proposal, preview }))),
    );
  });

  const list = permit.withPermits(1)(readStore).pipe(Effect.flatMap(withPreviews));

  const propose = Effect.fn("ReaperProposals.propose")(function* (
    input: ReaperProposeRulesInput & { readonly threadId?: ThreadId },
  ) {
    const m = yield* manifest;
    const roots = protectedRoots(m);
    const current = ReaperPolicy.readReaperPolicySync(roots, options.policyPath);
    const proposedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    return yield* permit.withPermits(1)(
      Effect.gen(function* () {
        let pending = [...(yield* readStore)];
        const queued: Array<{ id: string; path: string }> = [];
        const refused: Array<{ path: string; reason: string }> = [];
        for (const rule of input.rules) {
          const checked = ReaperPolicy.validateReaperPolicyRules(
            [{ ...rule, enabled: false }],
            roots,
            options.homeDir,
            { agentProposal: true },
          );
          if (!checked.ok) {
            refused.push({ path: rule.path, reason: checked.error });
            continue;
          }
          const path = checked.rules[0]!.path;
          if (current.rules.some((r) => r.path === path)) {
            refused.push({ path, reason: `A cleanup rule for ${path} already exists.` });
            continue;
          }
          if (pending.some((p) => p.path === path)) {
            refused.push({ path, reason: `A proposal for ${path} already waits for the user.` });
            continue;
          }
          const fromThisThread = pending.filter((p) => p.threadId === input.threadId).length;
          if (pending.length >= MAX_PENDING || fromThisThread >= MAX_PENDING_PER_THREAD) {
            refused.push({ path, reason: "Too many proposals wait for the user already." });
            continue;
          }
          const id = `reaper-proposal:${NodeCrypto.randomUUID()}`;
          pending.push({
            ...rule,
            path,
            id,
            host: m.host,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            proposedAt,
          });
          queued.push({ id, path });
        }
        if (queued.length > 0) yield* writeStore(pending);
        return { queued, refused };
      }),
    );
  });

  const decide = Effect.fn("ReaperProposals.decide")(function* (input: ReaperProposalDecision) {
    const roots = protectedRoots(yield* manifest);
    const remaining = yield* permit.withPermits(1)(
      Effect.gen(function* () {
        const pending = yield* readStore;
        const proposal = pending.find((p) => p.id === input.id);
        if (proposal === undefined) {
          return yield* new ReaperProposalNotFoundError({ id: input.id });
        }
        if (input.decision === "accept") {
          const current = ReaperPolicy.readReaperPolicySync(roots, options.policyPath);
          const written = yield* Effect.promise(() =>
            ReaperPolicy.writeReaperPolicy(
              [
                ...current.rules,
                {
                  path: proposal.path,
                  maxAgeDays: proposal.maxAgeDays,
                  keepLatest: proposal.keepLatest,
                  enabled: false,
                },
              ],
              roots,
              options.policyPath,
              options.homeDir,
            ).catch((cause: unknown) => ({ ok: false as const, error: String(cause) })),
          );
          if (!written.ok) {
            return yield* new ReaperProposalRefusedError({ id: input.id, reason: written.error });
          }
        }
        const remaining = pending.filter((p) => p.id !== input.id);
        yield* writeStore(remaining);
        return remaining;
      }),
    );
    return yield* withPreviews(remaining);
  });

  const savePolicy = Effect.fn("ReaperProposals.savePolicy")(function* (
    rules: ReadonlyArray<ReaperPolicy.ReaperPolicyRule>,
  ) {
    const roots = protectedRoots(yield* manifest);
    const written = yield* permit.withPermits(1)(
      Effect.promise(() =>
        ReaperPolicy.writeReaperPolicy(rules, roots, options.policyPath, options.homeDir).catch(
          (cause: unknown) => ({ ok: false as const, error: String(cause) }),
        ),
      ),
    );
    if (!written.ok) {
      return yield* new ReaperProposalRefusedError({ id: "policy", reason: written.error });
    }
    return written.document;
  });

  return ReaperProposals.of({ list, propose, decide, savePolicy });
});

/** For tests: a policy file and home other than the user's. */
export const layerAt = (options: { readonly policyPath: string; readonly homeDir: string }) =>
  Layer.effect(ReaperProposals, make(options));

export const layer = Layer.effect(
  ReaperProposals,
  Effect.suspend(() =>
    make({ policyPath: ReaperPolicy.defaultReaperPolicyPath(), homeDir: NodeOS.homedir() }),
  ),
);
