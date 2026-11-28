// @effect-diagnostics nodeBuiltinImport:off - Pending agent-proposed reaper rules, stored beside the reaper stamps and accepted into policy.toml.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ReaperRuleProposal,
  type ReaperProposalDecision,
  type ReaperProposeRulesInput,
  type ReaperProposeRulesResult,
  type ThreadId,
} from "@t3tools/contracts";
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

const MAX_PENDING = 50;

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
    readonly list: Effect.Effect<ReadonlyArray<ReaperRuleProposal>, ReaperProposalStoreError>;
    /** Queues rules that pass the policy's path checks; refused ones come back with the reason. */
    readonly propose: (
      input: ReaperProposeRulesInput & { readonly threadId?: ThreadId },
    ) => Effect.Effect<ReaperProposeRulesResult, ReaperProposalStoreError>;
    /** Accept writes the rule, enabled, through the policy writer; reject drops it. */
    readonly decide: (
      input: ReaperProposalDecision,
    ) => Effect.Effect<
      ReadonlyArray<ReaperRuleProposal>,
      ReaperProposalNotFoundError | ReaperProposalRefusedError | ReaperProposalStoreError
    >;
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

  const manifest = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => ({ providerInstances: {} })),
    Effect.map((settings) => StorageManifest.buildStorageManifestFromSettings(config, settings)),
  );
  // The same roots the policy route protects when the user saves rules by hand.
  const protectedRoots = (m: StorageManifest.StorageManifest) =>
    m.entries.filter((e) => e.trust === "history").map((e) => e.path);

  const readStore = Effect.tryPromise({
    try: () => NodeFSP.readFile(storePath, "utf8"),
    catch: (cause) => new ReaperProposalStoreError({ operation: "read", cause }),
  }).pipe(
    Effect.map((text) => decodeStoreFile(text)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value.proposals : [])),
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

  const list = permit.withPermits(1)(readStore);

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
            [{ ...rule, enabled: true }],
            roots,
            options.homeDir,
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
          const id = `reaper-proposal:${NodeCrypto.randomUUID()}`;
          // A newer proposal for the same path replaces the one still pending.
          pending = pending.filter((p) => p.path !== path);
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
        if (queued.length > 0) yield* writeStore(pending.slice(-MAX_PENDING));
        return { queued, refused };
      }),
    );
  });

  const decide = Effect.fn("ReaperProposals.decide")(function* (input: ReaperProposalDecision) {
    const roots = protectedRoots(yield* manifest);
    return yield* permit.withPermits(1)(
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
                  enabled: true,
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
  });

  return ReaperProposals.of({ list, propose, decide });
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
