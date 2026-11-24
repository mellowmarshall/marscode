/**
 * Isolated React error boundary for DevTools panels and modals.
 * Turns unexpected render throws or malformed wire payloads into a local recoverable state
 * with an explicit Reset button instead of crashing the surrounding window or sidebar.
 */
import { Component, type ReactNode } from "react";
import { T, Var } from "gt-react";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "../components/ui/button";

function DevtoolsErrorFallback({
  panelName,
  message,
  compact,
  floating,
  onReset,
}: {
  readonly panelName: string;
  readonly message: string;
  readonly compact: boolean;
  readonly floating: boolean;
  readonly onReset: () => void;
}) {
  const floatingClass = floating
    ? "fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] bg-popover shadow-lg"
    : "";
  if (compact) {
    return (
      <div
        data-testid="devtools-error-boundary"
        className={`space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-2xs ${floatingClass}`.trim()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-destructive">
            <AlertTriangleIcon className="size-3 shrink-0" />
            <span className="truncate">
              <T>
                <Var>{panelName}</Var> failed to render
              </T>
            </span>
          </span>
          <Button size="xs" variant="outline" onClick={onReset}>
            <RotateCcwIcon className="mr-1 size-2.5" />
            <T>Reset</T>
          </Button>
        </div>
        {message ? (
          <div className="truncate font-mono text-3xs text-muted-foreground">{message}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid="devtools-error-boundary"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-foreground">
            <T>
              <Var>{panelName}</Var> encountered a render error
            </T>
          </div>
          {message ? (
            <div className="truncate font-mono text-3xs text-muted-foreground">{message}</div>
          ) : null}
        </div>
      </div>
      <Button size="xs" variant="outline" onClick={onReset}>
        <RotateCcwIcon className="mr-1 size-3" />
        <T>Reset panel</T>
      </Button>
    </div>
  );
}

interface DevtoolsErrorBoundaryProps {
  readonly panelName: string;
  readonly children: ReactNode;
  readonly compact?: boolean | undefined;
  readonly floating?: boolean | undefined;
  readonly resetKeys?: ReadonlyArray<unknown> | undefined;
}

interface DevtoolsErrorBoundaryState {
  readonly errorMessage: string | null;
  readonly resetKeys?: ReadonlyArray<unknown> | undefined;
}

export class DevtoolsErrorBoundary extends Component<
  DevtoolsErrorBoundaryProps,
  DevtoolsErrorBoundaryState
> {
  override state: DevtoolsErrorBoundaryState = {
    errorMessage: null,
    resetKeys: this.props.resetKeys,
  };

  static getDerivedStateFromProps(
    { resetKeys }: DevtoolsErrorBoundaryProps,
    state: DevtoolsErrorBoundaryState,
  ): DevtoolsErrorBoundaryState | null {
    if (
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, idx) => !Object.is(key, state.resetKeys?.[idx]))
    ) {
      return { errorMessage: null, resetKeys };
    }
    return null;
  }

  static getDerivedStateFromError(error: unknown): Partial<DevtoolsErrorBoundaryState> {
    const raw = error instanceof Error ? error.message : String(error ?? "Unexpected render error");
    return { errorMessage: raw.slice(0, 240) };
  }

  override render() {
    if (this.state.errorMessage !== null) {
      return (
        <DevtoolsErrorFallback
          panelName={this.props.panelName}
          message={this.state.errorMessage}
          compact={this.props.compact === true}
          floating={this.props.floating === true}
          onReset={() => this.setState({ errorMessage: null })}
        />
      );
    }
    return this.props.children;
  }
}
