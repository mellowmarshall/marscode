import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  resolveChatCanvasModel,
  type ChatCanvasMeasurements,
} from "./canvasStore";
import type { ChatCanvasPreview } from "./chatCanvasLayout";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const measurements = (width: number, height = 900): ChatCanvasMeasurements => ({
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
});
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};

describe("chat canvas model", () => {
  it("shows the details card inline only where the canvas fits it beside the chat", () => {
    const resolve = (width: number, narrowestWidth = width) =>
      resolveChatCanvasModel({
        measurements: { ...measurements(width), narrowestWidth },
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      }).detailsCardMode;
    expect(resolve(1400)).toBe("inline");
    expect(resolve(900)).toBe("popover");
    expect(resolve(1400, 900)).toBe("popover");
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number) =>
      resolveChatCanvasModel({
        measurements: measurements(1100, 300),
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
  });

  it("ignores a details card measured for another thread", () => {
    const model = resolveChatCanvasModel({
      measurements: measurements(1100, 300),
      detailsCardMeasurement: { threadRef: otherThreadRef, width: 280, fullContentHeight: 400 },
      threadRef,
      preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.layout.overlapsDetailsCard).toBe(false);
    expect(model.detailsCardMode).toBe("inline");
  });

  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
    store.getState().setMeasurements({ ...measurements(1400), narrowestWidth: 900 });
    expect(store.getState().measurements.narrowestWidth).toBe(900);
    expect(store.getState()).not.toBe(measured);
  });

  it("preserves detailsCardWidth across measurements and resolves resized placement", () => {
    const store = createChatCanvasStore();
    store.getState().setDetailsCardWidth(400);
    expect(store.getState().measurements.detailsCardWidth).toBe(400);

    // Repeating the same width preserves state identity.
    const afterWidth = store.getState();
    store.getState().setDetailsCardWidth(400);
    expect(store.getState()).toBe(afterWidth);

    // Setting measurements without an explicit detailsCardWidth keeps the chosen width.
    store.getState().setMeasurements(measurements(1400));
    expect(store.getState().measurements.detailsCardWidth).toBe(400);

    // Out-of-range widths clamp to the supported bounds.
    store.getState().setDetailsCardWidth(999);
    expect(store.getState().measurements.detailsCardWidth).toBe(480);

    const model = resolveChatCanvasModel({
      measurements: { ...measurements(1400), detailsCardWidth: 400 },
      detailsCardMeasurement: { threadRef, width: 400, fullContentHeight: 320 },
      threadRef,
      preview: null,
      detailsCardInlineOpen: true,
    });
    expect(model.detailsCardMode).toBe("inline");
    expect(model.detailsCardPlacement?.width).toBe(400);
    expect(model.preferredDetailsCard?.width).toBe(400);
    // Chat stays clear of the widened details card (1400 - 400 - 12 - 32 = 956 >= chat.left + chat.width).
    expect(model.layout.chat.left + model.layout.chat.width).toBeLessThanOrEqual(
      model.detailsCardPlacement!.x - 32,
    );
  });
});
