import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AssistantSelectionToolbar } from "../../src/components/chat/AssistantSelectionToolbar";
import { render } from "../render";
import { captureMedia, MediaFrame } from "./readmeMediaCapture";

const REPLY =
  "The search filter reads the query once per keystroke, so typing fast queues stale requests. Debounce it and cancel the previous request.";

function CiteDemo() {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <MediaFrame name="cite" width={640}>
      <div ref={setViewport} data-assistant-citation-viewport="" className="space-y-3 pb-12">
        <p className="ml-auto w-fit rounded-xl bg-secondary px-3 py-2 text-sm">
          Why does the search box lag?
        </p>
        <div
          data-assistant-citation-source="msg-1"
          data-assistant-citation-environment="env-local"
          data-assistant-citation-thread="thread-1"
          className="text-sm leading-6"
        >
          <p>{REPLY}</p>
        </div>
      </div>
      <AssistantSelectionToolbar
        viewport={viewport}
        threadRef={{
          environmentId: EnvironmentId.make("env-local"),
          threadId: ThreadId.make("thread-1"),
        }}
        onCite={() => true}
      />
    </MediaFrame>
  );
}

describe("README media: Cite", () => {
  it("shows Cite on a text selection", async () => {
    await using _screen = await render(<CiteDemo />);
    const reply = page.getByText(REPLY);
    await expect.element(reply).toBeVisible();
    await captureMedia("frames/cite/00", "cite");

    await userEvent.tripleClick(reply);
    const cite = page.getByRole("button", { name: "Cite selection in composer" });
    await expect.element(cite).toBeVisible();
    await captureMedia("frames/cite/01", "cite");

    await cite.hover();
    await captureMedia("frames/cite/02", "cite");
  });
});
