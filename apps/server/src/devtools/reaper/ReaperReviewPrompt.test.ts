import { expect, it } from "@effect/vitest";

import { buildStorageCleanupReviewPrompt, REAPER_PROPOSE_TOOL } from "./ReaperReviewPrompt.ts";

it("asks a local review to propose rules through the tool and a remote one only to report", () => {
  const local = buildStorageCleanupReviewPrompt({ host: "host-a", isLocalHost: true });
  const remote = buildStorageCleanupReviewPrompt({ host: "remote-box", isLocalHost: false });
  for (const prompt of [local, remote]) {
    expect(prompt).toContain("Never delete, move, or truncate anything yourself");
    expect(prompt).toContain("never propose a repo or worktree root");
  }
  expect(local).toContain(`calling the \`${REAPER_PROPOSE_TOOL}\` tool`);
  expect(remote).toContain("Do not call it.");
});
