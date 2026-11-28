/**
 * The Fleet host chip's CI switch. Turning CI off is one click. Turning it back on for a host whose
 * `.off` marker carries a reason (usually the owner protecting a long task) opens a confirmation
 * that shows the reason, who set it and when. Only "Turn CI on" sends the turn-on, carrying the
 * shown marker's version, so the server removes only the marker the owner saw.
 */
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import type { MergedFleetHost } from "./devdeckTypes";

/**
 * `confirmVersion` is the content hash of the `.off` marker the confirmation showed; null when no
 * confirmation was shown. The server removes the marker only if it still has that version.
 */
export type FleetCiToggle = (
  host: MergedFleetHost,
  enabled: boolean,
  confirmVersion: string | null,
) => void;

function formatOffAt(at: string | null | undefined): string | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : at;
}

export function FleetCiSwitch({
  host,
  toggling,
  onToggleCi,
}: {
  readonly host: MergedFleetHost;
  readonly toggling: boolean;
  readonly onToggleCi: FleetCiToggle;
}) {
  const gt = useGT();
  // The version of the marker the dialog shows, captured when it opens; null while closed.
  const [shownVersion, setShownVersion] = useState<string | null>(null);
  const ciEnabled = !host.ciOff;
  const reason = host.ciOffReason?.trim() || null;
  const offBy = host.probe?.ci_off_by?.trim() || gt("unknown");
  const offAt = formatOffAt(host.probe?.ci_off_at) ?? gt("an unknown time");

  return (
    <>
      <button
        type="button"
        role="switch"
        data-fd="ci-switch"
        data-on={ciEnabled}
        aria-checked={ciEnabled}
        aria-label={
          ciEnabled
            ? gt("Disable CI on {host}", { host: host.shortName })
            : gt("Enable CI on {host}", { host: host.shortName })
        }
        disabled={toggling}
        onClick={() => {
          if (ciEnabled) onToggleCi(host, false, null);
          else if (reason) setShownVersion(host.probe?.ci_off_version ?? "");
          else onToggleCi(host, true, null);
        }}
      >
        <span data-fd="ci-switch-dot" aria-hidden />
        <span>{ciEnabled ? gt("CI on") : gt("CI off")}</span>
      </button>
      <AlertDialog
        open={shownVersion !== null}
        onOpenChange={(open) => {
          if (!open) setShownVersion(null);
        }}
      >
        <AlertDialogPopup data-testid="ci-on-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Turn CI back on for <Var>{host.shortName}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                CI was turned off on this host with a reason. CI jobs will start running on it
                again.
              </T>
            </AlertDialogDescription>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                <T>Reason</T>
              </dt>
              <dd data-testid="ci-on-confirm-reason" className="font-medium wrap-anywhere">
                {reason}
              </dd>
              <dt className="text-muted-foreground">
                <T>Set by</T>
              </dt>
              <dd data-testid="ci-on-confirm-by" className="wrap-anywhere">
                {offBy}
              </dd>
              <dt className="text-muted-foreground">
                <T>Set at</T>
              </dt>
              <dd data-testid="ci-on-confirm-at">{offAt}</dd>
            </dl>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const version = shownVersion ?? "";
                setShownVersion(null);
                onToggleCi(host, true, version);
              }}
            >
              <T>Turn CI on</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
