import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import {
  ArrowUpRightIcon,
  BarChart3Icon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";

import { m } from "~/i18n/messages";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import {
  fetchDevtoolsJson,
  type DevtoolsConfigPayload,
  type DevtoolsHostConfig,
  type FleetConfigSnapshot,
  type ResolvedRolePlan,
  type ReviewEffort,
  type ReviewModelSpec,
  type ReviewRoleConfig,
} from "./devtoolsClient";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import {
  checkFleetConfigDrift,
  recordSavedFleetConfig,
  useFleetConfigStore,
} from "./devtoolsFleetConfigStore";
import { DevtoolsStateBanner } from "./DevtoolsStateBanner";
import {
  DEFAULT_COMPLETED_SHIP_LINGER_MINUTES,
  DEFAULT_FLEET_CONSOLE_TAB,
  DEFAULT_SHOW_SIDEBAR_JOB_STATUS,
  useCompletedShipLingerMinutes,
  useDefaultFleetConsoleTab,
  useShowSidebarJobStatus,
  type CompletedShipLingerMinutes,
  type DefaultFleetConsoleTab,
} from "./devtoolsPreferences";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

interface ProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

const FALLBACK_PROVIDERS: ReadonlyArray<ProviderChoice> = [
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "auto:astra", label: m(msg("Latest Astra (auto)")) },
      { id: "gpt-6.2-astra", label: "gpt-6.2-astra" },
      { id: "gpt-6.2-sol", label: "gpt-6.2-sol" },
      { id: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    ],
  },
  {
    id: "claudeAgent",
    label: "Claude",
    models: [
      { id: "claude-fable-5-2", label: "claude-fable-5-2" },
      { id: "claude-opus-5-5", label: "claude-opus-5-5" },
      { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" },
      { id: "claude-haiku-5-5", label: "claude-haiku-5-5" },
    ],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    models: [
      { id: "gemini-4-neon", label: "gemini-4-neon" },
      { id: "gemini-4-carbon", label: "gemini-4-carbon" },
      { id: "gemini-3.8-flash", label: "gemini-3.8-flash" },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    models: [
      { id: "grok-4.7", label: "grok-4.7" },
      { id: "grok-4.7-build-fast", label: "grok-4.7-build-fast" },
    ],
  },
];

const CLI_CHALLENGE_PROVIDERS = new Set(["codex", "claudeAgent", "antigravity", "grok"]);

const EFFORT_OPTIONS: ReadonlyArray<{ readonly value: ReviewEffort; readonly label: string }> = [
  { value: "low", label: msg("Low") },
  { value: "medium", label: msg("Medium") },
  { value: "high", label: msg("High") },
  { value: "xhigh", label: msg("XHigh") },
  { value: "max", label: msg("Max") },
];

const LINGER_LABELS: Record<CompletedShipLingerMinutes, string> = {
  "0": msg("Hide immediately"),
  "5": msg("5 minutes (default)"),
  "15": msg("15 minutes"),
};

const TAB_LABELS: Record<DefaultFleetConsoleTab, string> = {
  machines: msg("Machines (default)"),
  reaper: msg("Reaper & Sweep"),
};

function buildProviderChoices(
  liveProviders: ReadonlyArray<ServerProvider>,
  cliOnly: boolean,
): ReadonlyArray<ProviderChoice> {
  const byId = new Map<string, ProviderChoice>();
  for (const p of liveProviders) {
    if (!p.enabled) continue;
    if (cliOnly && !CLI_CHALLENGE_PROVIDERS.has(p.instanceId)) continue;
    const models: Array<{ readonly id: string; readonly label: string }> = [];
    if (p.instanceId === "codex" && cliOnly) {
      models.push({ id: "auto:astra", label: m(msg("Latest Astra (auto)")) });
    }
    for (const model of p.models) {
      if (!models.some((x) => x.id === model.slug)) {
        models.push({ id: model.slug, label: model.name || model.slug });
      }
    }
    if (models.length > 0) {
      byId.set(p.instanceId, {
        id: p.instanceId,
        label: p.displayName || p.instanceId,
        models,
      });
    }
  }
  for (const fb of FALLBACK_PROVIDERS) {
    if (cliOnly && !CLI_CHALLENGE_PROVIDERS.has(fb.id)) continue;
    if (!byId.has(fb.id)) {
      byId.set(fb.id, fb);
    }
  }
  return Array.from(byId.values());
}

function formatRemainingBadge(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return m(msg("usage n/a"));
  return m(msg("{pct}% left"), { pct: Math.round(pct) });
}

function ModelSpecEditorRow({
  spec,
  providers,
  usageRemaining,
  onChange,
  onRemove,
  label,
}: {
  readonly spec: ReviewModelSpec;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly usageRemaining: Readonly<Record<string, number | null>>;
  readonly onChange: (next: ReviewModelSpec) => void;
  readonly onRemove?: () => void;
  readonly label: string;
}) {
  const gt = useGT();
  const currentProvider = providers.find((p) => p.id === spec.provider) ?? {
    id: spec.provider,
    label: spec.provider,
    models: [{ id: spec.model, label: spec.model }],
  };
  const models = currentProvider.models.some((item) => item.id === spec.model)
    ? currentProvider.models
    : [{ id: spec.model, label: spec.model }, ...currentProvider.models];
  const rem = usageRemaining[spec.provider];
  const effortOption = EFFORT_OPTIONS.find((e) => e.value === spec.effort);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2">
      <div className="min-w-[118px] flex-1 sm:flex-none">
        <Select
          value={spec.provider}
          onValueChange={(nextProvider) => {
            if (!nextProvider) return;
            const provObj = providers.find((p) => p.id === nextProvider);
            const firstModel = provObj?.models[0]?.id ?? spec.model;
            onChange({ ...spec, provider: nextProvider, model: firstModel });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={gt("{label} provider", { label })}
            className="w-full"
          >
            <SelectValue>{currentProvider.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start">
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="min-w-[175px] flex-[2]">
        <Select
          value={spec.model}
          onValueChange={(nextModel) => {
            if (!nextModel) return;
            onChange({ ...spec, model: nextModel });
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("{label} model", { label })} className="w-full">
            <SelectValue>
              {models.find((item) => item.id === spec.model)?.label ?? spec.model}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start">
            {models.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="w-[100px]">
        <Select
          value={spec.effort}
          onValueChange={(nextEffort) => {
            if (!nextEffort) return;
            onChange({ ...spec, effort: nextEffort as ReviewEffort });
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("{label} effort", { label })} className="w-full">
            <SelectValue>{effortOption ? m(effortOption.label) : spec.effort}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {EFFORT_OPTIONS.map((e) => (
              <SelectItem key={e.value} value={e.value}>
                {m(e.label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <Badge
        size="sm"
        variant={rem !== null && rem !== undefined && rem < 10 ? "error" : "outline"}
      >
        {formatRemainingBadge(rem)}
      </Badge>

      {onRemove ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Remove {label}", { label })}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5 text-muted-foreground" />
        </Button>
      ) : null}
    </div>
  );
}

function RoleModelCard({
  title,
  description,
  roleConfig,
  resolved,
  providers,
  onChange,
  extraFooter,
}: {
  readonly title: string;
  readonly description: string;
  readonly roleConfig: ReviewRoleConfig;
  readonly resolved: ResolvedRolePlan | null;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly onChange: (next: ReviewRoleConfig) => void;
  readonly extraFooter?: ReactNode;
}) {
  const gt = useGT();
  const usageRemaining = resolved?.usageRemaining ?? {};

  const handleAddFallback = () => {
    const usedKeys = new Set([
      `${roleConfig.default.provider}:${roleConfig.default.model}:${roleConfig.default.effort}`,
      ...roleConfig.fallbacks.map((f) => `${f.provider}:${f.model}:${f.effort}`),
    ]);
    for (const p of providers) {
      for (const model of p.models) {
        const key = `${p.id}:${model.id}:${roleConfig.default.effort}`;
        if (!usedKeys.has(key)) {
          onChange({
            ...roleConfig,
            fallbacks: [
              ...roleConfig.fallbacks,
              { provider: p.id, model: model.id, effort: roleConfig.default.effort },
            ],
          });
          return;
        }
      }
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {resolved ? (
          <Badge
            size="sm"
            variant={resolved.fallbackUsed ? "warning" : "secondary"}
            className="shrink-0"
          >
            <T>
              Active: <Var>{resolved.selected.model}</Var> (<Var>{resolved.selected.effort}</Var>) ·{" "}
              <Var>{formatRemainingBadge(resolved.selected.remainingPct)}</Var>
            </T>
          </Badge>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">
          <T>Default model</T>
        </div>
        <ModelSpecEditorRow
          label={gt("{title} default", { title })}
          spec={roleConfig.default}
          providers={providers}
          usageRemaining={usageRemaining}
          onChange={(next) => onChange({ ...roleConfig, default: next })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            <T>Fallback pool (auto-picks highest remaining usage %)</T>
          </div>
          <Button size="xs" variant="outline" onClick={handleAddFallback}>
            <PlusIcon className="mr-1 size-3" />
            <T>Add fallback</T>
          </Button>
        </div>
        {roleConfig.fallbacks.length === 0 ? (
          <p className="text-xs text-muted-foreground/80">
            <T>No fallbacks configured. Only the default model will be tried.</T>
          </p>
        ) : (
          <div className="space-y-1.5">
            {roleConfig.fallbacks.map((fb, idx) => (
              <ModelSpecEditorRow
                key={`${fb.provider}:${fb.model}:${fb.effort}`}
                label={gt("{title} fallback {n}", { title, n: idx + 1 })}
                spec={fb}
                providers={providers}
                usageRemaining={usageRemaining}
                onChange={(next) => {
                  const nextList = roleConfig.fallbacks.map((item, i) => (i === idx ? next : item));
                  onChange({ ...roleConfig, fallbacks: nextList });
                }}
                onRemove={() => {
                  onChange({
                    ...roleConfig,
                    fallbacks: roleConfig.fallbacks.filter((_, i) => i !== idx),
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-2.5 text-xs">
        <label className="flex items-center gap-2 text-muted-foreground">
          <span>
            <T>Fall back when remaining usage is below</T>
          </span>
          <Input
            type="number"
            min={0}
            max={100}
            size="sm"
            className="w-20"
            value={roleConfig.min_remaining_pct}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed)) {
                onChange({
                  ...roleConfig,
                  min_remaining_pct: Math.max(0, Math.min(100, Math.round(parsed))),
                });
              }
            }}
          />
          <span>%</span>
        </label>
        {extraFooter}
      </div>
    </div>
  );
}

function resolveHostSelection(
  snap: FleetConfigSnapshot,
  nextHost: string,
): {
  readonly payload: DevtoolsConfigPayload;
  readonly draft: DevtoolsHostConfig;
  readonly error: string | null;
} {
  const selectedState =
    nextHost === "all" ? null : (snap.hosts.find((h) => h.host.name === nextHost) ?? null);
  if (selectedState && !selectedState.reachable) {
    return {
      payload: {
        configPath: selectedState.configPath,
        config: snap.localConfig,
        resolved: snap.resolved,
      },
      draft: snap.localConfig,
      error:
        selectedState.error ??
        m(msg("Selected host is unreachable via SSH; showing local host configuration.")),
    };
  }
  const activeConfig = selectedState?.config ?? snap.localConfig;
  return {
    payload: {
      configPath: selectedState?.configPath ?? snap.configPath,
      config: activeConfig,
      resolved: snap.resolved,
    },
    draft: activeConfig,
    error: null,
  };
}

function DevtoolsSettingsPanelInner() {
  const gt = useGT();
  const navigate = useNavigate();
  const searchableSetting = useSearchableSetting();
  const primaryEnvId = usePrimaryEnvironmentId();
  const environmentId = primaryEnvId as EnvironmentId | undefined;
  const liveProviders =
    useAtomValue(
      environmentId
        ? serverEnvironment.providersValueAtom(environmentId)
        : serverEnvironment.providersValueAtom("__none__" as EnvironmentId),
    ) ?? EMPTY_PROVIDERS;

  const fleetStore = useFleetConfigStore(environmentId);
  const fleetSnapshot = fleetStore.fleetSnapshot;
  const [targetHost, setTargetHost] = useState<string>("all");
  const targetHostRef = useRef("all");
  const initialSelection = fleetSnapshot
    ? resolveHostSelection(fleetSnapshot, "all")
    : fleetStore.localPayload
      ? { payload: fleetStore.localPayload, draft: fleetStore.localPayload.config, error: null }
      : null;
  const [payload, setPayload] = useState<DevtoolsConfigPayload | null>(
    () => initialSelection?.payload ?? null,
  );
  const [draft, setDraft] = useState<DevtoolsHostConfig | null>(
    () => initialSelection?.draft ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(() => initialSelection?.error ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showSidebarPills, setShowSidebarPills] = useShowSidebarJobStatus();
  const [shipLinger, setShipLinger] = useCompletedShipLingerMinutes();
  const [defaultTab, setDefaultTab] = useDefaultFleetConsoleTab();

  const challengeProviders = buildProviderChoices(liveProviders, true);
  const reviewProviders = buildProviderChoices(liveProviders, false);

  const isDirty =
    payload !== null && draft !== null && JSON.stringify(payload.config) !== JSON.stringify(draft);
  const isDirtyRef = useRef(isDirty);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preserves unsaved form edits when a background drift check returns
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- triggers quiet background drift check on panel open while cached config renders immediately
  useEffect(() => {
    if (!environmentId) return;
    checkFleetConfigDrift(environmentId);
  }, [environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrates editor payload/draft when cached or background-refreshed config arrives without clobbering dirty edits
  useEffect(() => {
    if (fleetSnapshot) {
      const currentTarget = targetHostRef.current;
      const validTarget =
        currentTarget === "all" || fleetSnapshot.hosts.some((h) => h.host.name === currentTarget)
          ? currentTarget
          : "all";
      if (validTarget !== currentTarget) {
        targetHostRef.current = validTarget;
        setTargetHost(validTarget);
      }
      const resolved = resolveHostSelection(fleetSnapshot, validTarget);
      setPayload(resolved.payload);
      if (!isDirtyRef.current) {
        setDraft(resolved.draft);
      }
      setError(resolved.error);
      return;
    }
    if (fleetStore.localPayload) {
      setPayload(fleetStore.localPayload);
      if (!isDirtyRef.current) {
        setDraft(fleetStore.localPayload.config);
      }
      setError(null);
      return;
    }
    if (fleetStore.error) {
      setError(fleetStore.error);
    }
  }, [fleetSnapshot, fleetStore.localPayload, fleetStore.error]);

  const checkingDrift = fleetStore.checking;

  const driftedHostsCount = fleetSnapshot
    ? fleetSnapshot.hosts.filter((h) => !h.host.local && h.reachable && !h.inSyncWithLocal).length
    : 0;

  const saveConfigToTarget = async (explicitTarget: string) => {
    if (!environmentId || !draft) return;
    setSaving(true);
    setSaveError(null);
    const res = await fetchDevtoolsJson<DevtoolsConfigPayload>(environmentId, "/config", {
      method: "POST",
      body: { ...draft, targetHost: explicitTarget },
    });
    setSaving(false);
    if (res.ok && res.data) {
      const results = res.data.results;
      const viewedTarget = targetHostRef.current;
      const viewedTargetResult = results?.find((r) =>
        viewedTarget === "all" ? r.local : r.host === viewedTarget,
      );
      const viewedTargetSucceeded = results
        ? viewedTargetResult
          ? viewedTargetResult.ok
          : res.data.ok !== false
        : res.data.ok !== false;
      if (viewedTargetSucceeded) {
        const nextConfig = viewedTargetResult?.config ?? res.data.config;
        setPayload({ ...res.data, config: nextConfig });
        setDraft(nextConfig);
      }
      if (!results || results.some((r) => r.ok)) {
        recordSavedFleetConfig(environmentId, res.data);
      }
      if (results && results.length > 0) {
        const failed = results.filter((r) => !r.ok);
        const succeeded = results.filter((r) => r.ok);
        if (failed.length === 0) {
          toastManager.add({
            type: "success",
            title:
              explicitTarget === "all"
                ? gt("Synced DevTools config to all {n} hosts", { n: succeeded.length })
                : gt("Saved DevTools config to {host}", { host: explicitTarget }),
          });
        } else {
          const failedNames = failed.map((f) => f.host).join(", ");
          const msgText = gt("Saved on {ok}/{total} hosts; failed on: {hosts}", {
            ok: succeeded.length,
            total: results.length,
            hosts: failedNames,
          });
          setSaveError(msgText);
          toastManager.add({ type: "warning", title: msgText });
        }
      } else {
        toastManager.add({ type: "success", title: gt("DevTools configuration saved") });
      }
    } else {
      const msgText = res.data?.error ?? res.error ?? gt("Failed to save DevTools configuration");
      setSaveError(msgText);
      toastManager.add({ type: "error", title: msgText });
    }
  };

  const handleSave = () => saveConfigToTarget(targetHost);
  const displayError = saveError ?? error ?? (!draft ? fleetStore.error : null);

  const selectedHostEntry =
    targetHost === "all"
      ? null
      : (fleetSnapshot?.hosts.find((h) => h.host.name === targetHost) ?? null);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="devtools-review-models"
        title={gt("Review & challenger models")}
        headerAction={
          <div className="flex flex-wrap items-center gap-1.5">
            {checkingDrift && draft ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label={gt("Checking fleet hosts for config drift")}
                      className="inline-flex items-center px-1 text-muted-foreground"
                    >
                      <Loader2Icon className="size-3 animate-spin" />
                    </span>
                  }
                />
                <TooltipPopup side="bottom">
                  <T>Checking fleet hosts for config drift…</T>
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={!environmentId || checkingDrift}
              onClick={() => {
                setSaveError(null);
                if (environmentId) checkFleetConfigDrift(environmentId, { forceRefresh: true });
              }}
            >
              <RefreshCwIcon className="mr-1 size-3" />
              <T>Refresh</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/usage", search: { metric: "reviews" } })}
            >
              <BarChart3Icon className="mr-1 size-3" />
              <T>Review stats</T>
            </Button>
            {fleetSnapshot &&
            fleetSnapshot.hosts.length > 1 &&
            (driftedHostsCount > 0 || targetHost !== "all") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving || !environmentId || !draft}
                onClick={() => void saveConfigToTarget("all")}
              >
                <ServerIcon className="mr-1 size-3" />
                <T>Sync to all hosts</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!isDirty || saving || !environmentId}
              onClick={() => void handleSave()}
            >
              {saving ? (
                <T>Saving…</T>
              ) : targetHost === "all" ? (
                <T>Save to all hosts</T>
              ) : (
                <T>
                  Save to <Var>{targetHost}</Var>
                </T>
              )}
            </Button>
          </div>
        }
      >
        {fleetSnapshot ? (
          <div className="space-y-2 rounded-lg border bg-card/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <ServerIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium">
                  <T>Target host</T>
                </span>
                <div className="min-w-[210px]">
                  <Select
                    value={targetHost}
                    onValueChange={(v) => {
                      if (!v) return;
                      targetHostRef.current = v;
                      setTargetHost(v);
                      setSaveError(null);
                      if (fleetSnapshot) {
                        const resolved = resolveHostSelection(fleetSnapshot, v);
                        setPayload(resolved.payload);
                        setDraft(resolved.draft);
                        setError(resolved.error);
                      }
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Target host")}>
                      <SelectValue>
                        {targetHost === "all"
                          ? gt("All hosts ({n} in fleet)", { n: fleetSnapshot.hosts.length })
                          : (selectedHostEntry?.host.label ?? targetHost)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start">
                      <SelectItem value="all">
                        {gt("All hosts ({n} in fleet)", { n: fleetSnapshot.hosts.length })}
                      </SelectItem>
                      {fleetSnapshot.hosts.map((entry) => (
                        <SelectItem key={entry.host.name} value={entry.host.name}>
                          {entry.host.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              <span className="text-2xs text-muted-foreground">
                {targetHost === "all" ? (
                  <T>
                    Writes ~/.local/lib/ship-queue/host-config.json locally and via SSH to every
                    reachable host
                  </T>
                ) : (
                  <T>
                    Editing <Var>{selectedHostEntry?.host.label ?? targetHost}</Var> (
                    <Var>
                      {selectedHostEntry?.configPath ?? "~/.local/lib/ship-queue/host-config.json"}
                    </Var>
                    )
                  </T>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {fleetSnapshot.hosts.map((entry) => {
                const statusLabel = entry.host.local
                  ? gt("local")
                  : !entry.reachable
                    ? gt("offline")
                    : !entry.exists
                      ? gt("default")
                      : entry.inSyncWithLocal
                        ? gt("synced")
                        : gt("drifted");
                const badgeVariant = entry.host.local
                  ? "secondary"
                  : !entry.reachable
                    ? "error"
                    : entry.inSyncWithLocal && entry.exists
                      ? "secondary"
                      : "warning";
                return (
                  <Badge key={entry.host.name} size="sm" variant={badgeVariant}>
                    {entry.host.name}: {statusLabel}
                  </Badge>
                );
              })}
            </div>
          </div>
        ) : null}

        {draft && displayError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {displayError}
          </div>
        ) : null}

        {draft ? (
          <div className="space-y-3 py-2">
            <div id={searchableSetting("devtools-playbook-models").id}>
              <RoleModelCard
                title={gt("Playbook Challenge")}
                description={gt(
                  "Strictly evaluates changes against PLAYBOOK.md via direct headless CLI (codex, claude, agy, grok). Falls back automatically when remaining usage drops below threshold or on quota errors.",
                )}
                roleConfig={draft.playbook_challenge}
                resolved={payload?.resolved.playbookChallenge ?? null}
                providers={challengeProviders}
                onChange={(next) => setDraft({ ...draft, playbook_challenge: next })}
                extraFooter={
                  <label className="flex items-center gap-2 text-muted-foreground">
                    <span>
                      <T>Base timeout</T>
                    </span>
                    <Input
                      type="number"
                      min={30}
                      max={900}
                      size="sm"
                      className="w-20"
                      value={draft.challenge_timeout_s}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) {
                          setDraft({
                            ...draft,
                            challenge_timeout_s: Math.max(30, Math.min(900, Math.round(v))),
                          });
                        }
                      }}
                    />
                    <span>s</span>
                  </label>
                }
              />
            </div>

            <div id={searchableSetting("devtools-ship-review-models").id}>
              <RoleModelCard
                title={gt("Ship Queue Adversarial Review")}
                description={gt(
                  "Default code reviewer model and usage-aware fallback exposed to agents via orchestrator_capabilities and ship-queue review-model before submitting to Ship Queue.",
                )}
                roleConfig={draft.ship_queue_review}
                resolved={payload?.resolved.shipQueueReview ?? null}
                providers={reviewProviders}
                onChange={(next) => setDraft({ ...draft, ship_queue_review: next })}
              />
            </div>

            {payload?.configPath ? (
              <p className="text-2xs text-muted-foreground">
                <T>
                  Host config file:{" "}
                  <code className="font-mono">
                    <Var>{payload.configPath}</Var>
                  </code>
                </T>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="py-2">
            {checkingDrift ? (
              <DevtoolsStateBanner
                compact
                status="connecting"
                title={<T>Loading host configuration…</T>}
              />
            ) : displayError ? (
              <DevtoolsStateBanner
                compact
                status="error"
                title={displayError}
                onRetry={() => {
                  setError(null);
                  setSaveError(null);
                  if (environmentId) checkFleetConfigDrift(environmentId, { forceRefresh: true });
                }}
              />
            ) : (
              <DevtoolsStateBanner
                compact
                status="unconfigured"
                title={<T>Connect an environment to edit host settings.</T>}
              />
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="devtools-host-guards" title={gt("Host guards")}>
        <SettingsRow
          title={gt("Active approvals, alerts & audit")}
          description={gt(
            "Manage active guard bundles, 24-hour password access, host-guard notifications, and audit history in Security & approvals.",
          )}
          control={
            <Link
              to="/settings/security"
              className="inline-flex items-center gap-1 text-xs font-medium text-info-foreground hover:underline"
            >
              <T>Open Security</T>
              <ArrowUpRightIcon className="size-3.5" />
            </Link>
          }
        />

        {draft ? (
          <>
            <SettingsRow
              {...searchableSetting("devtools-guard-timeout")}
              description={gt(
                "Seconds a pending host-guard approval prompt waits before expiring (30-600s).",
              )}
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={30}
                    max={600}
                    size="sm"
                    className="w-24"
                    value={draft.guards.request_timeout_s}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        setDraft({
                          ...draft,
                          guards: {
                            ...draft.guards,
                            request_timeout_s: Math.max(30, Math.min(600, Math.round(v))),
                          },
                        });
                      }
                    }}
                  />
                  <span className="text-xs text-muted-foreground">s</span>
                </div>
              }
            />
            <SettingsRow
              {...searchableSetting("devtools-guard-ttl")}
              description={gt(
                "Seconds an approved one-shot host-guard grant remains valid (10-600s).",
              )}
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={10}
                    max={600}
                    size="sm"
                    className="w-24"
                    value={draft.guards.grant_ttl_s}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        setDraft({
                          ...draft,
                          guards: {
                            ...draft.guards,
                            grant_ttl_s: Math.max(10, Math.min(600, Math.round(v))),
                          },
                        });
                      }
                    }}
                  />
                  <span className="text-xs text-muted-foreground">s</span>
                </div>
              }
            />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection id="devtools-jobs-ui" title={gt("Jobs & Ship Queue UI")}>
        <SettingsRow
          {...searchableSetting("devtools-sidebar-job-pills")}
          description={gt(
            "Show live shipping, deploying, and bounded-job progress indicators on thread rows.",
          )}
          resetAction={
            showSidebarPills !== DEFAULT_SHOW_SIDEBAR_JOB_STATUS ? (
              <SettingResetButton
                ariaLabel={gt("Reset sidebar job pills to default")}
                onClick={() => setShowSidebarPills(DEFAULT_SHOW_SIDEBAR_JOB_STATUS)}
              />
            ) : null
          }
          control={
            <Switch
              checked={showSidebarPills}
              onCheckedChange={(checked) => setShowSidebarPills(Boolean(checked))}
              aria-label={gt("Sidebar job status pills")}
            />
          }
        />

        <SettingsRow
          {...searchableSetting("devtools-ship-linger")}
          description={gt(
            "How long completed Ship Queue jobs remain visible in the thread right rail.",
          )}
          resetAction={
            shipLinger !== DEFAULT_COMPLETED_SHIP_LINGER_MINUTES ? (
              <SettingResetButton
                ariaLabel={gt("Reset completed ship linger to default")}
                onClick={() => setShipLinger(DEFAULT_COMPLETED_SHIP_LINGER_MINUTES)}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-48">
              <Select
                value={shipLinger}
                onValueChange={(v) => {
                  if (v === "0" || v === "5" || v === "15") setShipLinger(v);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label={gt("Completed ship linger")}
                >
                  <SelectValue>{m(LINGER_LABELS[shipLinger])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {(Object.keys(LINGER_LABELS) as CompletedShipLingerMinutes[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {m(LINGER_LABELS[k])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />

        {draft ? (
          <SettingsRow
            {...searchableSetting("devtools-job-stall-minutes")}
            description={gt(
              "Default minutes of log silence before a bounded job triggers a stall alert (1-240 min).",
            )}
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={240}
                  size="sm"
                  className="w-24"
                  value={draft.jobs.default_stall_minutes}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      setDraft({
                        ...draft,
                        jobs: { default_stall_minutes: Math.max(1, Math.min(240, Math.round(v))) },
                      });
                    }
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  <T>min</T>
                </span>
              </div>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="devtools-fleet-devdeck" title={gt("Fleet Console & DevDeck")}>
        <SettingsRow
          {...searchableSetting("devtools-default-fleet-tab")}
          description={gt("Initial section opened when launching Fleet Console from the sidebar.")}
          resetAction={
            defaultTab !== DEFAULT_FLEET_CONSOLE_TAB ? (
              <SettingResetButton
                ariaLabel={gt("Reset default Fleet Console tab to default")}
                onClick={() => setDefaultTab(DEFAULT_FLEET_CONSOLE_TAB)}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-48">
              <Select
                value={defaultTab}
                onValueChange={(v) => {
                  if (v === "machines" || v === "reaper") {
                    setDefaultTab(v);
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label={gt("Default Fleet Console tab")}
                >
                  <SelectValue>{m(TAB_LABELS[defaultTab])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {(Object.keys(TAB_LABELS) as DefaultFleetConsoleTab[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {m(TAB_LABELS[k])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />

        {draft ? (
          <SettingsRow
            {...searchableSetting("devtools-devdeck-endpoint")}
            description={gt(
              "Optional legacy DevDeck daemon override (Unix socket path or loopback host:port). Leave blank to use T3's built-in native fleet telemetry.",
            )}
            control={
              <Input
                type="text"
                size="sm"
                className="w-full sm:w-64"
                placeholder={gt("Built-in native (default)")}
                value={draft.devdeck.endpoint_override}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    devdeck: { endpoint_override: e.target.value },
                  })
                }
              />
            }
          />
        ) : null}

        <SettingsRow
          title={gt("TUI palettes & output highlighting")}
          description={gt(
            "Provider TUI color palettes and semantic terminal highlighting live under Appearance.",
          )}
          control={
            <Link
              to="/settings/appearance"
              className="inline-flex items-center gap-1 text-xs font-medium text-info-foreground hover:underline"
            >
              <T>Open Appearance</T>
              <ArrowUpRightIcon className="size-3.5" />
            </Link>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function DevtoolsSettingsPanel() {
  const primaryEnvId = usePrimaryEnvironmentId();
  return (
    <DevtoolsErrorBoundary panelName="DevTools Settings">
      <DevtoolsSettingsPanelInner key={primaryEnvId ?? "__none__"} />
    </DevtoolsErrorBoundary>
  );
}
