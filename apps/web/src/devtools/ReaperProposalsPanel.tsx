/** Cleanup rules an Agent cleanup review proposed; each waits for the user to accept or reject it. */
import type { ReaperRuleProposal } from "@t3tools/contracts";
import { T, Var, useGT } from "gt-react";
import { BotIcon, CheckIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { formatJobBytes } from "./jobs/jobTypes";

export function ReaperProposalsPanel({
  proposals,
  readOnly,
  busy,
  onDecide,
}: {
  readonly proposals: ReadonlyArray<ReaperRuleProposal>;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onDecide: (proposal: ReaperRuleProposal, decision: "accept" | "reject") => void;
}) {
  const gt = useGT();
  if (proposals.length === 0) return null;

  return (
    <section
      aria-label={gt("Proposed cleanup rules")}
      className="overflow-hidden rounded-lg border border-primary/40 bg-card/40"
    >
      <div className="space-y-0.5 border-b border-border/60 bg-primary/5 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <BotIcon className="size-3.5 text-primary" />
          <T>
            Proposed cleanup rules (<Var>{proposals.length}</Var>)
          </T>
        </div>
        <p className="text-2xs text-muted-foreground">
          <T>
            An agent cleanup review found these. Nothing has been deleted. Accepting a rule adds it
            to the approved rules below, and the Reaper applies it on its next pass. History paths
            stay protected.
          </T>
        </p>
      </div>
      <ul className="divide-y divide-border/50">
        {proposals.map((proposal) => (
          <li key={proposal.id} className="space-y-1.5 px-3 py-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="min-w-0 break-all font-mono text-2xs text-foreground">
                {proposal.path}
              </code>
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={readOnly || busy}
                  aria-label={gt("Reject rule for {path}", { path: proposal.path })}
                  onClick={() => onDecide(proposal, "reject")}
                >
                  <XIcon className="mr-1 size-3" />
                  <T>Reject</T>
                </Button>
                <Button
                  size="xs"
                  disabled={readOnly || busy}
                  aria-label={gt("Accept rule for {path}", { path: proposal.path })}
                  onClick={() => onDecide(proposal, "accept")}
                >
                  <CheckIcon className="mr-1 size-3" />
                  <T>Accept</T>
                </Button>
              </div>
            </div>
            <dl className="grid gap-x-3 gap-y-1 text-2xs sm:grid-cols-[auto_1fr]">
              <dt className="font-medium text-muted-foreground">
                <T>Deletes</T>
              </dt>
              <dd className="text-foreground">{proposal.deletes}</dd>
              <dt className="font-medium text-muted-foreground">
                <T>Why it is safe</T>
              </dt>
              <dd className="text-foreground">{proposal.safeBecause}</dd>
            </dl>
            <div className="text-3xs text-muted-foreground">
              {proposal.estimatedBytes !== undefined ? (
                <T>
                  Entries older than <Var>{proposal.maxAgeDays}</Var> days, keeping the newest{" "}
                  <Var>{proposal.keepLatest}</Var> · about{" "}
                  <Var>{formatJobBytes(proposal.estimatedBytes)}</Var>
                </T>
              ) : (
                <T>
                  Entries older than <Var>{proposal.maxAgeDays}</Var> days, keeping the newest{" "}
                  <Var>{proposal.keepLatest}</Var>
                </T>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
