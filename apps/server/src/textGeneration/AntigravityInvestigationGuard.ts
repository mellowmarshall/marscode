/**
 * Read-only investigation permission and tool-call guards for `AntigravityTextGeneration`.
 * Reuses `resolveAntigravityClientFilePath` from `AntigravityClientFiles.ts` for symlink-safe
 * canonical containment checks against the checkout root.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as AcpSchema from "effect-acp/compat";

import { resolveAntigravityClientFilePath } from "../provider/acp/AntigravityClientFiles.ts";

const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think"]);
const READ_ONLY_PERMISSION_KINDS = new Set(["read", "search"]);

/** Verify every ACP tool location resolves canonically inside `cwd` (symlink-safe). */
const areLocationsInsideRoot = Effect.fn("AntigravityInvestigationGuard.areLocationsInside")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly cwd: string;
    readonly locations: ReadonlyArray<{ readonly path: string }>;
  }) {
    for (const location of input.locations) {
      if (!location.path.trim()) return false;
      const resolved = input.path.isAbsolute(location.path)
        ? location.path
        : input.path.resolve(input.cwd, location.path);
      const inside = yield* resolveAntigravityClientFilePath({
        fileSystem: input.fileSystem,
        path: input.path,
        allowedRoots: [input.cwd],
        requestPath: resolved,
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!inside) return false;
    }
    return true;
  },
);

/**
 * Evaluate an ACP permission request during read-only investigation.
 * Requires `kind` in `read | search`, a non-empty `locations` list whose entries all resolve
 * canonically inside `cwd`, and an explicit `allow_once` option (never `allow_always`).
 */
export const allowReadOnlyPermission = Effect.fn(
  "AntigravityInvestigationGuard.allowReadOnlyPermission",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
  readonly request: AcpSchema.RequestPermissionRequest;
}): Effect.fn.Return<string | null> {
  const kind = input.request.toolCall.kind;
  if (typeof kind !== "string" || !READ_ONLY_PERMISSION_KINDS.has(kind)) return null;
  const locations = input.request.toolCall.locations ?? [];
  if (locations.length === 0) return null;
  const allowOnce = input.request.options.find((option) => option.kind === "allow_once");
  if (allowOnce === undefined) return null;
  const inside = yield* areLocationsInsideRoot({
    fileSystem: input.fileSystem,
    path: input.path,
    cwd: input.cwd,
    locations,
  });
  return inside ? allowOnce.optionId : null;
});

/** Check whether a `tool_call` or `tool_call_update` is permitted during read-only investigation. */
export const isReadOnlyToolUpdateAllowed = Effect.fn(
  "AntigravityInvestigationGuard.isReadOnlyToolUpdateAllowed",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
  readonly update: Extract<
    AcpSchema.SessionNotification["update"],
    { readonly sessionUpdate: "tool_call" | "tool_call_update" }
  >;
  readonly allowedToolCalls: Set<string>;
}): Effect.fn.Return<boolean> {
  const { update } = input;
  const kind = update.kind;
  const kindAllowed =
    update.sessionUpdate === "tool_call"
      ? typeof kind === "string" && READ_ONLY_TOOL_KINDS.has(kind)
      : (typeof kind === "string" && READ_ONLY_TOOL_KINDS.has(kind)) ||
        ((kind === undefined || kind === null) && input.allowedToolCalls.has(update.toolCallId));
  if (!kindAllowed) return false;

  const locations = update.locations;
  if (locations !== undefined && locations !== null && locations.length > 0) {
    const inside = yield* areLocationsInsideRoot({
      fileSystem: input.fileSystem,
      path: input.path,
      cwd: input.cwd,
      locations,
    });
    if (!inside) return false;
  }
  if (update.sessionUpdate === "tool_call") {
    input.allowedToolCalls.add(update.toolCallId);
  }
  return true;
});
