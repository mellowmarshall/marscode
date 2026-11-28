import * as Schema from "effect/Schema";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

const SavedWidthSchema = Schema.Finite;

export const THREAD_DETAILS_CARD_GAP = 12;
// Keep default in sync with --thread-details-panel-width in index.css.
export const THREAD_DETAILS_CARD_DEFAULT_WIDTH = 280;
export const THREAD_DETAILS_CARD_MIN_WIDTH = 240;
export const THREAD_DETAILS_CARD_MAX_WIDTH = 480;
export const THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY = "t3code:thread-details-panel-width";

export function clampThreadDetailsCardWidth(
  value: number,
  maxWidth = THREAD_DETAILS_CARD_MAX_WIDTH,
): number {
  const effectiveMax = Math.max(THREAD_DETAILS_CARD_MIN_WIDTH, maxWidth);
  if (!Number.isFinite(value)) {
    return Math.min(THREAD_DETAILS_CARD_DEFAULT_WIDTH, effectiveMax);
  }
  return Math.max(THREAD_DETAILS_CARD_MIN_WIDTH, Math.min(effectiveMax, Math.round(value)));
}

export function readSavedThreadDetailsCardWidth(): number {
  if (typeof window === "undefined") return THREAD_DETAILS_CARD_DEFAULT_WIDTH;
  try {
    const stored = getLocalStorageItem(THREAD_DETAILS_CARD_WIDTH_STORAGE_KEY, SavedWidthSchema);
    return stored === null
      ? THREAD_DETAILS_CARD_DEFAULT_WIDTH
      : clampThreadDetailsCardWidth(stored);
  } catch {
    return THREAD_DETAILS_CARD_DEFAULT_WIDTH;
  }
}

export function resolveThreadDetailsCardMaxWidth({
  fitWidth,
  lane,
}: {
  fitWidth: number;
  lane: { padding: number; minChatWidth: number };
}): number {
  return Math.min(
    THREAD_DETAILS_CARD_MAX_WIDTH,
    Math.floor(
      fitWidth -
        THREAD_DETAILS_CARD_GAP -
        DETAILS_CARD_CLEARANCE -
        lane.padding -
        lane.minChatWidth,
    ),
  );
}

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  narrowestWidth = container.width,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
  preferredWidth,
}: {
  container: { width: number; height: number };
  // While a panel animates the container, the card fits only if it fits at both ends.
  narrowestWidth?: number;
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
  preferredWidth?: number | undefined;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const requestedWidth =
    preferredWidth === undefined
      ? THREAD_DETAILS_CARD_DEFAULT_WIDTH
      : clampThreadDetailsCardWidth(preferredWidth);
  // The transition ends are sampled once, so a resize mid-animation can leave them
  // wider than the container is now.
  const fitWidth = Math.min(narrowestWidth, container.width);
  const maxFittingWidth = resolveThreadDetailsCardMaxWidth({ fitWidth, lane });
  const minRequiredWidth = Math.min(requestedWidth, THREAD_DETAILS_CARD_DEFAULT_WIDTH);
  if (maxFittingWidth < minRequiredWidth) return null;
  const width = Math.min(requestedWidth, maxFittingWidth);
  const x = container.width - width - gap;
  const y = gap + topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    right: gap,
    width,
    y,
    height,
  } as const;
}
