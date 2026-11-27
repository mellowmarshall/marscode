/** Wire shapes the devtools reaper routes return; the web client reads them unchanged. */

export interface ReaperLog {
  (message: string): void;
}

export interface ReaperOrphanCandidate {
  readonly pid: number;
  readonly cmd: string;
  readonly age_s: number;
}

export interface ReaperStaleTmpStatus {
  readonly max_age_hours: number;
  readonly roots: ReadonlyArray<string>;
  readonly dirs: number;
  readonly files: number;
  readonly skipped_active: number;
}

export interface ReaperStatus {
  readonly protected: {
    readonly sessions: number;
    readonly worktrees: number;
    readonly paths: number;
  };
  readonly orphan_candidates: ReadonlyArray<ReaperOrphanCandidate>;
  readonly stale_tmp: ReaperStaleTmpStatus;
  readonly cargo_last_run: {
    readonly stamp_path: string;
    readonly last_run: string | null;
    readonly age_s: number | null;
  };
}

export interface ReaperCargoItem {
  readonly kind: "build-dir" | "incremental";
  readonly action: "removed" | "would-remove" | "skipped" | "failed";
  readonly path: string;
  readonly bytes?: number;
  readonly reason?: string;
}

export interface ReaperCargoResult {
  readonly dry_run: boolean;
  readonly build_dirs: number;
  readonly removed: number;
  readonly removed_bytes: number;
  readonly incremental: number;
  readonly incremental_bytes: number;
  readonly skipped_in_use: number;
  readonly aborted_reason: string | null;
  readonly items: ReadonlyArray<ReaperCargoItem>;
}

export interface ReaperScanMount {
  readonly mount: string;
  readonly total_bytes: number;
  readonly used_bytes: number;
  readonly avail_bytes: number;
  readonly used_pct: number;
}

export interface ReaperHostScan {
  readonly schema_version: 1;
  readonly scanned_at: string;
  readonly host: string;
  readonly platform: string;
  readonly mounts: ReadonlyArray<ReaperScanMount>;
  readonly high_pressure: boolean;
  readonly pressure_mounts: ReadonlyArray<string>;
  readonly t3_manifest: {
    readonly present: true;
    readonly generated_at: string;
    readonly history_roots: ReadonlyArray<string>;
    readonly ephemeral_roots: ReadonlyArray<string>;
  };
  readonly policy: { readonly path: string; readonly approved_rules: number };
  readonly alerts: {
    readonly apport_coredumps: { readonly count: number; readonly bytes: number };
  };
}

export interface ReaperRunSummary {
  readonly orphans_terminated: number;
  /** Why the file sweeps did not run (a failed or blind process scan); null when they ran. */
  readonly sweeps_refused: string | null;
  readonly tmp: { readonly removed: number; readonly bytes: number; readonly skipped: number };
  readonly exhaust_removed: number;
  readonly ephemeral_removed: number;
  readonly approved_removed: number;
  readonly docker: { readonly containers: number; readonly networks: number };
  readonly cargo: ReaperCargoResult | null;
}
