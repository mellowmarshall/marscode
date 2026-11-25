// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Native CI hosts check, toggle, and provision runner backed by `ship-queue hosts`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CiHostManifestEntry, FleetHostsPanel, FleetHostsReport } from "./FleetTypes.ts";

const CHECK_TIMEOUT_MS = 10 * 60_000;
const CI_TOGGLE_TIMEOUT_MS = 30_000;
const PROVISION_TIMEOUT_MS = 15 * 60_000;
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function defaultT3StateDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg || NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(base, "t3code");
}

function legacyDevdeckHostsCheckPath(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg || NodePath.join(NodeOS.homedir(), ".local", "state");
  return NodePath.join(base, "devdeck", "hosts-check.json");
}

export function resolveCiHostsManifestPath(): string | null {
  const candidates: string[] = [];
  const mainCheckout = process.env.SHIP_QUEUE_MAIN_CHECKOUT?.trim() || "/dataprivate-repo/main";
  candidates.push(NodePath.join(mainCheckout, "ship-queue", "ci-hosts.json"));
  const libDir =
    process.env.SHIP_QUEUE_LIB_DIR?.trim() ||
    NodePath.join(NodeOS.homedir(), ".local", "lib", "ship-queue");
  candidates.push(NodePath.join(libDir, "ci-hosts.json"));
  candidates.push(
    NodePath.join(NodeOS.homedir(), "Dev", "devtools", "ship-queue", "ci-hosts.json"),
  );

  for (const p of candidates) {
    try {
      if (NodeFS.statSync(p).isFile()) return p;
    } catch {
      // try next
    }
  }
  return null;
}

export function readCiHostsManifest(overridePath?: string): ReadonlyArray<CiHostManifestEntry> {
  const manifestPath = overridePath ?? resolveCiHostsManifestPath();
  if (!manifestPath) return [];
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly hosts?: unknown;
    };
    if (!parsed || !Array.isArray(parsed.hosts)) return [];
    const out: CiHostManifestEntry[] = [];
    for (const raw of parsed.hosts) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      if (!name) continue;
      out.push({
        name,
        ssh: typeof rec.ssh === "string" && rec.ssh.trim() ? rec.ssh.trim() : null,
        ...(typeof rec.note === "string" ? { note: rec.note } : {}),
        ...(typeof rec.data_root === "string" ? { data_root: rec.data_root } : {}),
        ...(typeof rec.on === "string" && rec.on.trim() ? { on: rec.on.trim() } : {}),
        ...(typeof rec.role === "string" ? { role: rec.role } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function resolveShipQueueBin(): string {
  const localBin = NodePath.join(NodeOS.homedir(), ".local", "bin", "ship-queue");
  try {
    NodeFS.accessSync(localBin, NodeFS.constants.X_OK);
    return localBin;
  } catch {
    return "ship-queue";
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    NodeFS.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    NodeFS.renameSync(tmp, filePath);
  } catch {
    // best-effort state cache write
  }
}

function parseHostsReport(raw: string): FleetHostsReport | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.hosts)) return null;
    return {
      schema: 1,
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
      ...(typeof parsed.manifest === "string" ? { manifest: parsed.manifest } : {}),
      hosts: parsed.hosts.filter((h): h is Record<string, unknown> =>
        Boolean(h && typeof h === "object"),
      ),
      ...(Array.isArray(parsed.settings) ? { settings: parsed.settings } : {}),
    };
  } catch {
    return null;
  }
}

function mergeHostReports(prev: FleetHostsReport, next: FleetHostsReport): FleetHostsReport {
  const mergedHosts = [...prev.hosts];
  for (const h of next.hosts) {
    const name = typeof h.name === "string" ? h.name : "";
    if (!name) continue;
    const idx = mergedHosts.findIndex((old) => old.name === name);
    if (idx >= 0) mergedHosts[idx] = h;
    else mergedHosts.push(h);
  }
  return {
    ...prev,
    at: next.at,
    hosts: mergedHosts,
  };
}

interface ToggleRecord {
  readonly at: number;
  readonly ciOff: boolean;
  readonly ciOffAt: string | null;
  readonly ciOffBy: string | null;
  readonly ciOffReason: string | null;
}

export class NativeCiHosts {
  private readonly stateFile: string;
  private readonly shipQueueBin: string;
  private readonly manifestPath: string | undefined;

  private report: FleetHostsReport | null = null;
  private running = "";
  private lastError = "";
  private toggled = new Map<string, ToggleRecord>();

  constructor(options?: {
    readonly stateFile?: string | undefined;
    readonly shipQueueBin?: string | undefined;
    readonly manifestPath?: string | undefined;
  }) {
    this.stateFile = options?.stateFile ?? NodePath.join(defaultT3StateDir(), "hosts-check.json");
    this.shipQueueBin = options?.shipQueueBin ?? resolveShipQueueBin();
    this.manifestPath = options?.manifestPath;
    this.loadInitialReport();
  }

  private loadInitialReport(): void {
    for (const candidate of [this.stateFile, legacyDevdeckHostsCheckPath()]) {
      try {
        const raw = NodeFS.readFileSync(candidate, "utf8");
        const parsed = parseHostsReport(raw);
        if (parsed) {
          this.report = parsed;
          return;
        }
      } catch {
        // try next
      }
    }
  }

  getPanel(): FleetHostsPanel {
    return {
      report: this.report,
      ...(this.running ? { running: this.running } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private knownHostNames(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const h of readCiHostsManifest(this.manifestPath)) names.add(h.name);
    for (const h of this.report?.hosts ?? []) {
      if (typeof h.name === "string" && h.name) names.add(h.name);
    }
    return names;
  }

  private applyToggles(rep: FleetHostsReport, startedAt: number): FleetHostsReport {
    if (this.toggled.size === 0) return rep;
    const hosts = rep.hosts.map((h) => {
      const name = typeof h.name === "string" ? h.name : "";
      const tog = this.toggled.get(name);
      if (!tog || tog.at < startedAt) return h;
      return {
        ...h,
        ci_off: tog.ciOff,
        ci_off_at: tog.ciOffAt,
        ci_off_by: tog.ciOffBy,
        ci_off_reason: tog.ciOffReason,
      };
    });
    return { ...rep, hosts };
  }

  async check(
    host?: string,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host?.trim() ?? "";
    if (targetHost && !SAFE_HOST_RE.test(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    if (this.running) {
      return { ok: false, message: "A hosts check or provision is already running" };
    }
    this.running = targetHost ? `check ${targetHost}` : "check";
    onChanged?.();
    try {
      return await this.runCheckInternal(targetHost);
    } finally {
      this.running = "";
      onChanged?.();
    }
  }

  private runCheckInternal(
    targetHost: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const startedAt = Date.now();
    const args = ["hosts", "check", "--json", ...(targetHost ? [targetHost] : [])];
    return new Promise((resolve) => {
      NodeChildProcess.execFile(
        this.shipQueueBin,
        args,
        { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const exitCode =
            err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? Number((err as unknown as { code: number }).code)
              : err
                ? 2
                : 0;
          // Exit code 1 means drift detected, which still emits a valid schema-1 JSON report.
          if (err && exitCode !== 1) {
            const first = (stderr || err.message).trim().split("\n")[0] || "hosts check failed";
            this.lastError = `ship-queue hosts check: ${first}`;
            resolve({ ok: false, message: this.lastError });
            return;
          }
          const parsed = parseHostsReport(stdout);
          if (!parsed) {
            const first = (stderr || "not JSON schema 1").trim().split("\n")[0] || "invalid report";
            this.lastError = `ship-queue hosts check gave no report: ${first}`;
            resolve({ ok: false, message: this.lastError });
            return;
          }
          const merged = targetHost && this.report ? mergeHostReports(this.report, parsed) : parsed;
          const finalRep = this.applyToggles(merged, startedAt);
          this.report = finalRep;
          this.lastError = "";
          atomicWriteJson(this.stateFile, finalRep);
          resolve({
            ok: true,
            message: targetHost ? `Checked ${targetHost}` : "Checked all hosts",
          });
        },
      );
    });
  }

  async setCi(
    host: string,
    enabled: boolean,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host.trim();
    if (!SAFE_HOST_RE.test(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    const known = this.knownHostNames();
    if (known.size > 0 && !known.has(targetHost)) {
      return { ok: false, message: `${targetHost} is not a known CI host` };
    }
    const reason = "turned off in T3 Code";
    const args = enabled
      ? ["hosts", "on", targetHost]
      : ["hosts", "off", targetHost, "--reason", reason];

    const res = await new Promise<{ readonly ok: boolean; readonly msg: string }>((resolve) => {
      NodeChildProcess.execFile(
        this.shipQueueBin,
        args,
        { timeout: CI_TOGGLE_TIMEOUT_MS, maxBuffer: 512 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              msg: (stderr || stdout || err.message).trim().split("\n")[0] || "hosts toggle failed",
            });
            return;
          }
          resolve({
            ok: true,
            msg: enabled ? `CI enabled on ${targetHost}` : `CI disabled on ${targetHost}`,
          });
        },
      );
    });
    if (!res.ok) return { ok: false, message: res.msg };

    const nowIso = new Date().toISOString();
    const rec: ToggleRecord = {
      at: Date.now(),
      ciOff: !enabled,
      ciOffAt: enabled ? null : nowIso,
      ciOffBy: enabled ? null : "t3code",
      ciOffReason: enabled ? null : reason,
    };
    this.toggled.set(targetHost, rec);
    if (this.report) {
      this.report = this.applyToggles(this.report, 0);
      atomicWriteJson(this.stateFile, this.report);
    }
    onChanged?.();
    return { ok: true, message: res.msg };
  }

  async provision(
    host: string,
    onProgress?: (line: string) => void,
    onChanged?: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const targetHost = host.trim();
    if (!SAFE_HOST_RE.test(targetHost)) {
      return { ok: false, message: `Invalid host name: ${targetHost}` };
    }
    if (this.running) {
      return { ok: false, message: "A hosts check or provision is already running" };
    }
    this.running = `provision ${targetHost}`;
    onChanged?.();
    try {
      const provRes = await new Promise<{ readonly ok: boolean; readonly message: string }>(
        (resolve) => {
          const child = NodeChildProcess.spawn(
            this.shipQueueBin,
            ["hosts", "provision", targetHost],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let lastLine = "";
          let failedLine = "";
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, PROVISION_TIMEOUT_MS);

          const handleChunk = (chunk: Buffer) => {
            for (const raw of chunk.toString("utf8").split("\n")) {
              const line = raw.trim();
              if (!line) continue;
              lastLine = line;
              if (!failedLine && /\bresult=(failed|error)\b/i.test(line)) {
                failedLine = line;
              }
              onProgress?.(line);
            }
          };
          child.stdout?.on("data", handleChunk);
          child.stderr?.on("data", handleChunk);
          child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ ok: false, message: err.message });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
              resolve({ ok: false, message: `Provisioning ${targetHost} timed out` });
            } else if (code !== 0 || failedLine) {
              resolve({
                ok: false,
                message: failedLine || lastLine || `ship-queue hosts provision exited ${code ?? 1}`,
              });
            } else {
              resolve({ ok: true, message: lastLine || `Provisioned ${targetHost}` });
            }
          });
        },
      );
      // Re-probe the host so the panel reflects the post-provision state.
      await this.runCheckInternal(targetHost);
      return provRes;
    } finally {
      this.running = "";
      onChanged?.();
    }
  }
}
