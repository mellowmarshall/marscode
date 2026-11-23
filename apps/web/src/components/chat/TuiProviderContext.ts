import type { RunId } from "@t3tools/contracts";
import { createContext, use } from "react";
import { resolveEffectiveTuiProvider, type TuiProviderKey } from "~/lib/tuiOutputPalette";
import type { TimelineRow, TimelineRowSharedState } from "./timelineRowContext";

export const TuiProviderContext = createContext<TuiProviderKey>("default");

export function useTuiProvider(): TuiProviderKey {
  return use(TuiProviderContext);
}

export function resolveInstanceTuiProvider(
  instanceId: string | null | undefined,
  tuiProviderByInstanceId: ReadonlyMap<string, TuiProviderKey>,
  providerTuiPalettes: boolean,
): TuiProviderKey {
  if (!providerTuiPalettes) return "default";
  if (instanceId) {
    const mapped = tuiProviderByInstanceId.get(instanceId);
    if (mapped) return mapped;
  }
  return resolveEffectiveTuiProvider(instanceId, providerTuiPalettes);
}

export function resolveRowTuiProvider(
  row: TimelineRow,
  ctx: TimelineRowSharedState,
): TuiProviderKey | undefined {
  if (row.kind === "message" && row.message.role === "user") {
    return undefined;
  }
  let runId: RunId | null | undefined;
  if (row.kind === "message" || row.kind === "assistant-meta") {
    runId = row.projectedItem?.item.runId ?? row.message.runId;
  } else if (row.kind === "proposed-plan") {
    runId = row.proposedPlan.runId;
  } else if (row.kind === "work") {
    runId = row.groupedEntries.at(-1)?.runId;
  } else if (row.kind === "work-live") {
    runId = row.entry.runId;
  } else if (row.kind === "work-toggle") {
    runId = row.runId;
  } else if (row.kind === "turn-fold" || row.kind === "attempt-fold") {
    runId = row.runId;
  } else if (row.kind === "event") {
    const item = row.projectedItem.item;
    if (item.type === "subagent") {
      if (!ctx.providerTuiPalettes) return "default";
      const fromInstance = item.providerInstanceId
        ? ctx.tuiProviderByInstanceId.get(item.providerInstanceId)
        : undefined;
      if (fromInstance) return fromInstance;
      if (item.driver) return resolveEffectiveTuiProvider(item.driver, true);
      if (item.providerInstanceId) {
        return resolveEffectiveTuiProvider(item.providerInstanceId, true);
      }
    }
    runId = item.runId;
  }
  if (runId) {
    const byRun = ctx.tuiProviderByRunId.get(runId);
    if (byRun) return byRun;
  }
  return ctx.defaultTuiProvider;
}
