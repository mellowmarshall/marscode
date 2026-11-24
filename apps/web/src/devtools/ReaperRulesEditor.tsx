/** Editable `~/.config/reaper/policy.toml` cleanup rules list with hard-protected T3 history roots. */
import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import { PlusIcon, SaveIcon, ShieldIcon, Trash2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import type { ReaperPolicyRule } from "./devtoolsClient";

export interface RuleDraftItem {
  readonly draftKey: string;
  readonly path: string;
  readonly maxAgeDaysText: string;
  readonly keepLatestText: string;
  readonly enabled: boolean;
}

let nextRuleDraftSeq = 1;
export function toRuleDrafts(rules: ReadonlyArray<ReaperPolicyRule>): RuleDraftItem[] {
  return rules.map((r) => ({
    draftKey: `rule-${nextRuleDraftSeq++}`,
    path: r.path,
    maxAgeDaysText: String(r.maxAgeDays),
    keepLatestText: String(r.keepLatest),
    enabled: r.enabled,
  }));
}

export function parseRuleDrafts(drafts: ReadonlyArray<RuleDraftItem>): {
  readonly valid: boolean;
  readonly rules: ReadonlyArray<ReaperPolicyRule>;
} {
  const rules: ReaperPolicyRule[] = [];
  let valid = true;
  for (const d of drafts) {
    const maxAge = Number(d.maxAgeDaysText.trim());
    const keep = Number(d.keepLatestText.trim());
    const ageOk =
      d.maxAgeDaysText.trim() !== "" && Number.isFinite(maxAge) && maxAge >= 1 && maxAge <= 3650;
    const keepOk =
      d.keepLatestText.trim() !== "" && Number.isFinite(keep) && keep >= 0 && keep <= 1000;
    if (!ageOk || !keepOk || !d.path.trim()) valid = false;
    rules.push({
      path: d.path,
      maxAgeDays: ageOk ? Math.round(maxAge * 100) / 100 : 1,
      keepLatest: keepOk ? Math.round(keep) : 0,
      enabled: d.enabled,
    });
  }
  return { valid, rules };
}

export function ReaperRulesEditor({
  policyPath,
  rulesDraft,
  protectedRoots,
  rulesDirty,
  rulesValid = true,
  readOnly = false,
  busy,
  onChangeRules,
  onSave,
}: {
  readonly policyPath: string | null;
  readonly rulesDraft: ReadonlyArray<RuleDraftItem>;
  readonly protectedRoots: ReadonlyArray<string>;
  readonly rulesDirty: boolean;
  readonly rulesValid?: boolean;
  readonly readOnly?: boolean;
  readonly busy: boolean;
  readonly onChangeRules: (updater: (prev: RuleDraftItem[]) => RuleDraftItem[]) => void;
  readonly onSave: () => void;
}) {
  const gt = useGT();
  const [showProtected, setShowProtected] = useState(false);

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">
            <T>Approved Cleanup Rules</T>
          </div>
          {policyPath ? (
            <div className="font-mono text-3xs text-muted-foreground">{policyPath}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {!rulesValid ? (
            <span className="text-3xs text-destructive">
              <T>Min 1 day · keep 0–1000</T>
            </span>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly || busy}
            onClick={() =>
              onChangeRules((prev) => [
                ...prev,
                {
                  draftKey: `rule-${nextRuleDraftSeq++}`,
                  path: "/data/",
                  maxAgeDaysText: "14",
                  keepLatestText: "2",
                  enabled: false,
                },
              ])
            }
          >
            <PlusIcon className="mr-1 size-3" />
            <T>Add rule</T>
          </Button>
          <Button
            size="xs"
            disabled={readOnly || !rulesDirty || !rulesValid || busy}
            onClick={onSave}
          >
            <SaveIcon className="mr-1 size-3" />
            <T>Save rules</T>
          </Button>
        </div>
      </div>

      <div className="divide-y divide-border/50">
        {rulesDraft.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            <T>No custom cleanup rules configured yet.</T>
          </div>
        ) : (
          rulesDraft.map((rule) => (
            <div
              key={rule.draftKey}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
            >
              <Switch
                checked={rule.enabled}
                disabled={readOnly}
                aria-label={gt("Enable rule for {path}", { path: rule.path })}
                onCheckedChange={(checked) =>
                  onChangeRules((prev) =>
                    prev.map((r) =>
                      r.draftKey === rule.draftKey ? { ...r, enabled: Boolean(checked) } : r,
                    ),
                  )
                }
              />
              <Input
                size="sm"
                className="min-w-56 flex-1"
                disabled={readOnly}
                value={rule.path}
                aria-label={gt("Cleanup directory path")}
                onChange={(e) =>
                  onChangeRules((prev) =>
                    prev.map((r) =>
                      r.draftKey === rule.draftKey ? { ...r, path: e.target.value } : r,
                    ),
                  )
                }
              />
              <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                <span>
                  <T>Max days</T>
                </span>
                <Input
                  type="text"
                  inputMode="decimal"
                  size="sm"
                  disabled={readOnly}
                  className="w-20"
                  value={rule.maxAgeDaysText}
                  onChange={(e) =>
                    onChangeRules((prev) =>
                      prev.map((r) =>
                        r.draftKey === rule.draftKey ? { ...r, maxAgeDaysText: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                <span>
                  <T>Keep latest</T>
                </span>
                <Input
                  type="text"
                  inputMode="numeric"
                  size="sm"
                  disabled={readOnly}
                  className="w-16"
                  value={rule.keepLatestText}
                  onChange={(e) =>
                    onChangeRules((prev) =>
                      prev.map((r) =>
                        r.draftKey === rule.draftKey ? { ...r, keepLatestText: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <Button
                size="xs"
                variant="ghost"
                disabled={readOnly}
                aria-label={gt("Delete rule")}
                onClick={() =>
                  onChangeRules((prev) => prev.filter((r) => r.draftKey !== rule.draftKey))
                }
              >
                <Trash2Icon className="size-3.5 text-muted-foreground hover:text-destructive" />
              </Button>
            </div>
          ))
        )}
      </div>

      {protectedRoots.length > 0 ? (
        <div className="border-t border-border/60 bg-muted/15 px-3 py-2 text-2xs">
          <button
            type="button"
            className="flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowProtected((v) => !v)}
          >
            <ShieldIcon className="size-3 text-success" />
            <T>
              <Var>{protectedRoots.length}</Var> hard-protected T3 history roots (never deleted)
            </T>
          </button>
          {showProtected ? (
            <ul className="mt-1.5 space-y-0.5 pl-4 font-mono text-3xs text-muted-foreground">
              {protectedRoots.map((root) => (
                <li key={root}>{root}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
