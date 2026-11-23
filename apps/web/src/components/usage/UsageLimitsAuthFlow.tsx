import {
  AuthProvidersManageScope,
  type ProviderAuthRespondInput,
  type ProviderAuthResponse,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type LimitRecoveryTarget,
  providerAuthWebviewPartition,
} from "@t3tools/shared/usageLimitsHealth";
import { CopyIcon, ExternalLinkIcon, GlobeIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { createElement, lazy, Suspense, useEffect, useRef, useState } from "react";

import { isWebUrl } from "../../browser/webUrl";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const ProviderAuthTerminal = lazy(() => import("../settings/ProviderAuthTerminal"));

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

interface AuthWebviewElement extends HTMLElement {
  addEventListener: HTMLElement["addEventListener"];
  removeEventListener: HTMLElement["removeEventListener"];
}

function EmbeddedAuthWebview({
  initialUrl,
  flowId,
  onOpenOsBrowser,
}: {
  readonly initialUrl: string;
  readonly flowId: string;
  readonly onOpenOsBrowser: () => void;
}) {
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const webviewRef = useRef<AuthWebviewElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Electron webview navigation events to reflect the live URL
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    const onNavigate = (event: Event) => {
      const nextUrl = (event as Event & { readonly url?: unknown }).url;
      if (typeof nextUrl === "string" && nextUrl.length > 0) setCurrentUrl(nextUrl);
    };
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
        <GlobeIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono">{currentUrl}</span>
        <Button size="xs" variant="ghost-muted" onClick={onOpenOsBrowser}>
          <T>OS browser</T>
          <ExternalLinkIcon className="size-3" aria-hidden />
        </Button>
      </div>
      {createElement("webview", {
        ref: webviewRef,
        src: initialUrl,
        partition: providerAuthWebviewPartition(flowId),
        className: "block h-[420px] w-full bg-background",
      })}
    </div>
  );
}

export function UsageLimitsAuthFlow({
  target,
  onFinished,
  onClose,
}: {
  readonly target: LimitRecoveryTarget;
  readonly onFinished: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canManage = useEnvironmentScope(target.environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({
      environmentId: target.environmentId,
      input: { instanceId: target.instanceId },
    }),
    messages,
  );
  const start = useAtomCommand(serverEnvironment.startProviderAuth, COMMAND_OPTIONS);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, COMMAND_OPTIONS);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, COMMAND_OPTIONS);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMAND_OPTIONS);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, COMMAND_OPTIONS);

  const [error, setError] = useState<string | null>(null);
  const [showInternalBrowser, setShowInternalBrowser] = useState(false);
  const [ownedFlowId, setOwnedFlowId] = useState<string | null>(null);

  const startedRef = useRef(false);
  const ownedFlowIdRef = useRef<string | null>(null);
  const activeFlowRef = useRef<{ flowId: string; active: boolean } | null>(null);
  const completedRefreshRef = useRef(false);
  const receivingCallbackRef = useRef<string | null>(null);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);

  const auth = query.data;
  const querySettled = query.isSuccess || query.error !== null;
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;

  // Codex desktop callbacks require the loopback listener armed by receiveProviderAuthCallback,
  // which opens the OS browser directly; other providers can render inside an ephemeral webview.
  const canEmbedWebview =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    target.driver !== "codex" &&
    Boolean(auth?.flowId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep the latest active flow snapshot for unmount cleanup without reading stale state
  useEffect(() => {
    activeFlowRef.current = auth?.flowId ? { flowId: auth.flowId, active } : null;
  }, [active, auth?.flowId]);

  // Wait for the initial auth-state snapshot before starting a flow so we never clobber an active
  // sign-in from Settings or another window, and record the flowId we started.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initiates the server auth flow once after the initial auth query resolves
  useEffect(() => {
    if (!canManage || startedRef.current || !querySettled) return;
    startedRef.current = true;
    if (active && auth?.flowId) {
      const adoptedFlowId = auth.flowId;
      ownedFlowIdRef.current = adoptedFlowId;
      queueMicrotask(() => setOwnedFlowId(adoptedFlowId));
      return;
    }
    void start({
      environmentId: target.environmentId,
      input: { instanceId: target.instanceId },
    }).then((result) => {
      if (result._tag === "Success") {
        const nextFlowId = result.value.flowId ?? null;
        ownedFlowIdRef.current = nextFlowId;
        setOwnedFlowId(nextFlowId);
        setError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : gt("Could not start sign-in."));
      }
    });
  }, [
    active,
    auth?.flowId,
    canManage,
    gt,
    querySettled,
    start,
    target.environmentId,
    target.instanceId,
  ]);

  // Only treat `succeeded` as completion when it matches the flow started/adopted by this panel.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes limits once when this component's owned auth flow succeeds
  useEffect(() => {
    if (
      auth?.phase !== "succeeded" ||
      completedRefreshRef.current ||
      ownedFlowIdRef.current === null ||
      auth.flowId !== ownedFlowIdRef.current
    ) {
      return;
    }
    completedRefreshRef.current = true;
    setShowInternalBrowser(false);
    void refreshProviders({ environmentId: target.environmentId, input: {} }).finally(() => {
      onFinished();
    });
  }, [auth?.flowId, auth?.phase, onFinished, refreshProviders, target.environmentId]);

  // Cancel any in-flight loopback callback listener and server auth flow on unmount.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cleanup releases desktop loopback listener and cancels active auth flow on unmount
  useEffect(() => {
    return () => {
      const pendingUrl = receivingCallbackRef.current;
      receivingCallbackRef.current = null;
      if (pendingUrl) {
        void window.desktopBridge?.cancelProviderAuthCallback?.(pendingUrl);
      }
      const current = activeFlowRef.current;
      if (current?.active && current.flowId === ownedFlowIdRef.current) {
        void cancel({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, flowId: current.flowId },
        });
      }
    };
  }, [cancel, target.environmentId, target.instanceId]);

  async function sendInteraction(response: ProviderAuthResponse): Promise<boolean> {
    if (!auth?.flowId || !interaction) return false;
    const result = await respond({
      environmentId: target.environmentId,
      input: {
        instanceId: target.instanceId,
        flowId: auth.flowId,
        interactionId: interaction.id,
        response,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Sign-in response failed."));
      return false;
    }
    return result._tag === "Success";
  }

  async function openInOsBrowser() {
    if (!url || !isWebUrl(url)) {
      setError(gt("This sign-in link is not a valid web address."));
      return;
    }
    setError(null);
    setShowInternalBrowser(false);
    try {
      if (interaction?.type === "browser" && interaction.requiresConsent) {
        const ok = await sendInteraction({ type: "browser", action: "accept" });
        if (!ok) return;
      }
      const receive = window.desktopBridge?.receiveProviderAuthCallback;
      if (receive && auth?.flowId && target.driver === "codex") {
        if (receivingCallbackRef.current === url) {
          await ensureLocalApi().shell.openExternal(url);
          return;
        }
        receivingCallbackRef.current = url;
        const callbackUrl = await receive(url);
        if (receivingCallbackRef.current !== url) return;
        receivingCallbackRef.current = null;
        const result = await complete({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, flowId: auth.flowId, callbackUrl },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : gt("Could not complete sign-in. Try again."),
          );
        }
        return;
      }
      await ensureLocalApi().shell.openExternal(url);
    } catch {
      receivingCallbackRef.current = null;
      setError(gt("Could not open the sign-in link. Copy it and open it in your browser."));
    }
  }

  async function openInInternalBrowser() {
    if (!url || !isWebUrl(url)) {
      setError(gt("This sign-in link is not a valid web address."));
      return;
    }
    if (interaction?.type === "browser" && interaction.requiresConsent) {
      const ok = await sendInteraction({ type: "browser", action: "accept" });
      if (!ok) return;
    }
    setError(null);
    if (canEmbedWebview) {
      setShowInternalBrowser(true);
    } else {
      await openInOsBrowser();
    }
  }

  function handleCancel() {
    setShowInternalBrowser(false);
    const pendingUrl = receivingCallbackRef.current;
    receivingCallbackRef.current = null;
    if (pendingUrl) {
      void window.desktopBridge?.cancelProviderAuthCallback?.(pendingUrl);
    }
    if (auth?.flowId && active) {
      void cancel({
        environmentId: target.environmentId,
        input: { instanceId: target.instanceId, flowId: auth.flowId },
      });
    }
    onClose();
  }

  const flushTerminal = async () => {
    if (terminalSending.current) return;
    terminalSending.current = true;
    try {
      while (terminalQueue.current.length > 0) {
        const next = terminalQueue.current.shift()!;
        await respond({ environmentId: target.environmentId, input: next });
      }
    } catch {
      // Terminal command failures surface via the auth stream/error banner.
    }
    terminalSending.current = false;
  };

  const ownedSucceeded =
    auth?.phase === "succeeded" && ownedFlowId !== null && auth.flowId === ownedFlowId;

  return (
    <div className="mt-2 flex flex-col gap-2.5 rounded-md border border-border bg-secondary/70 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {gt("Sign in · {provider} on {environment}", {
            provider: target.displayName,
            environment: target.environmentLabel,
          })}
        </span>
        <span className="text-muted-foreground">
          {ownedSucceeded
            ? gt("Signed in. Refreshing limits…")
            : auth?.phase === "verifying"
              ? gt("Verifying account…")
              : !querySettled || auth?.phase === "starting"
                ? gt("Starting sign-in…")
                : url
                  ? gt("Complete sign-in below or in your browser.")
                  : (auth?.message ?? gt("Waiting for provider…"))}
        </span>
        <Button size="xs" variant="ghost-muted" className="ms-auto" onClick={handleCancel}>
          {ownedSucceeded ? <T>Done</T> : <T>Cancel</T>}
        </Button>
      </div>

      {interaction?.type === "deviceCode" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-card px-2.5 py-1.5">
          <span className="text-muted-foreground">
            <T>Code:</T>
          </span>
          <code className="font-mono text-sm font-semibold tracking-wider text-foreground">
            {interaction.userCode}
          </code>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void writeTextToClipboard(interaction.userCode, {
                target: "Sign-in code",
                unavailableMessage: msg("Clipboard is unavailable."),
                failureMessage: msg("Could not copy sign-in code."),
              })
            }
          >
            <CopyIcon className="size-3" aria-hidden />
            <T>Copy code</T>
          </Button>
        </div>
      ) : null}

      {url ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {canEmbedWebview ? (
            <Button
              size="xs"
              variant={showInternalBrowser ? "outline" : "default"}
              disabled={!canManage}
              onClick={() => void openInInternalBrowser()}
            >
              <GlobeIcon className="size-3.5" aria-hidden />
              {showInternalBrowser ? <T>Reload in T3 browser</T> : <T>Open in T3 browser</T>}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant={canEmbedWebview ? "outline" : "default"}
            disabled={!canManage}
            onClick={() => void openInOsBrowser()}
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden />
            <T>Open in OS browser</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() =>
              void writeTextToClipboard(url, {
                target: "Sign-in link",
                unavailableMessage: msg("Clipboard is unavailable."),
                failureMessage: msg("Could not copy sign-in link."),
              })
            }
          >
            <CopyIcon className="size-3" aria-hidden />
            <T>Copy link</T>
          </Button>
        </div>
      ) : null}

      {showInternalBrowser && url && isWebUrl(url) && auth?.flowId ? (
        <EmbeddedAuthWebview
          key={`${auth.flowId}:${url}`}
          initialUrl={url}
          flowId={auth.flowId}
          onOpenOsBrowser={() => void openInOsBrowser()}
        />
      ) : null}

      {interaction?.type === "terminal" && auth?.flowId ? (
        <Suspense
          fallback={<span className="text-muted-foreground">{gt("Loading terminal…")}</span>}
        >
          <ProviderAuthTerminal
            key={`${auth.flowId}:${interaction.id}`}
            output={interaction.output}
            outputOffset={interaction.outputOffset}
            onResponse={(response) => {
              if (!canManage) return;
              terminalQueue.current.push({
                instanceId: target.instanceId,
                flowId: auth.flowId!,
                interactionId: interaction.id,
                response,
              });
              void flushTerminal();
            }}
          />
        </Suspense>
      ) : null}

      {error || (auth?.phase === "failed" && auth.message) ? (
        <p role="alert" className="text-destructive-foreground [overflow-wrap:anywhere]">
          {error ?? auth?.message}
        </p>
      ) : null}
    </div>
  );
}
