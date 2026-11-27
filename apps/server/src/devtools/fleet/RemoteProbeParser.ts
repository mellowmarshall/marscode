// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standard-Unix remote SSH probe script and Linux/macOS output parsers (zero DevDeck dependency).
import type {
  FleetDiskInfo,
  FleetGpuInfo,
  FleetHostTelemetry,
  FleetNodeState,
  FleetServerItem,
} from "./FleetTypes.ts";
import { parseDockerPsLines } from "./DockerPsParser.ts";
import { parseGpuLines, parseProcMeminfo, parseProcStat } from "./NativeHostSampler.ts";
import { parseRemoteProcs, REMOTE_PROCS_PROBE } from "./RemoteProcsParser.ts";

export const REMOTE_PROBE_SCRIPT = `os=$(uname)
echo "---OS---"
echo "$os"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t t3fleet 2>/dev/null) || tmp=
[ -z "$tmp" ] || trap 'rm -rf "$tmp"' EXIT
cpid=
if [ -n "$tmp" ]; then
  if [ "$os" = Darwin ]; then
    top -l 2 -n 0 -s 1 </dev/null 2>/dev/null | grep "CPU usage" >"$tmp/cpu" &
    cpid=$!
  else
    { head -n 1 /proc/stat; sleep 0.5; head -n 1 /proc/stat; } </dev/null >"$tmp/cpu" 2>/dev/null &
    cpid=$!
  fi
fi
docker=
for d in docker /usr/local/bin/docker /opt/homebrew/bin/docker "$HOME/.orbstack/bin/docker"; do
  command -v "$d" >/dev/null 2>&1 && { docker=$d; break; }
done
if [ "$os" = Darwin ]; then
  echo "---LOAD---"; sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}'
  echo "---CPUS---"; sysctl -n hw.ncpu 2>/dev/null
  echo "---BOOT---"; sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,]+' '{print $4}'
  echo "---VMSTAT---"; sysctl -n hw.pagesize hw.memsize 2>/dev/null; vm_stat 2>/dev/null
  echo "---DISK---"; df -kP /System/Volumes/Data 2>/dev/null
  echo "---POWER---"; pmset -g batt 2>/dev/null | head -n 2
else
  echo "---LOAD---"; cut -d" " -f1 /proc/loadavg 2>/dev/null
  echo "---CPUS---"; nproc 2>/dev/null
  echo "---UPTIME---"; cut -d" " -f1 /proc/uptime 2>/dev/null
  echo "---MEMINFO---"; grep -E "^(MemTotal|MemAvailable|MemFree):" /proc/meminfo 2>/dev/null
  echo "---DISK---"; df -kP / /data 2>/dev/null
  echo "---GPU---"
  for c in /sys/class/drm/card[0-9]*; do
    case "$(basename "$c")" in *-*) continue ;; esac
    [ -d "$c/device" ] || continue
    st=$(cat "$c/device/power/runtime_status" 2>/dev/null || true)
    b="-"; [ "$st" = suspended ] || b=$(cat "$c/device/gpu_busy_percent" 2>/dev/null || echo "-")
    u=$(cat "$c/device/mem_info_vram_used" 2>/dev/null || echo "-")
    t=$(cat "$c/device/mem_info_vram_total" 2>/dev/null || echo "-")
    [ "$b" != "-" ] || [ "$t" != "-" ] && echo "SYSFS $b $u $t"
  done
  nv=$(command -v nvidia-smi 2>/dev/null || { [ -x /usr/lib/wsl/lib/nvidia-smi ] && echo /usr/lib/wsl/lib/nvidia-smi; } || true)
  if [ -n "$nv" ]; then
    "$nv" --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | awk -F',' 'NF==3{gsub(/ /,"",$1);gsub(/ /,"",$2);gsub(/ /,"",$3);print "NV "$1" "$2" "$3}'
  fi
fi
${REMOTE_PROCS_PROBE}echo "---CPU---"; [ -z "$cpid" ] || { wait "$cpid" 2>/dev/null; cat "$tmp/cpu" 2>/dev/null; }
echo "---DOCKER---"
if [ -n "$docker" ]; then
  timeout 4 "$docker" ps -a --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.oneoff"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}' 2>/dev/null || true
fi
echo "---END---"
`;

function splitSections(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let name = "";
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 6 &&
      trimmed.startsWith("---") &&
      trimmed.endsWith("---") &&
      !/\s/.test(trimmed)
    ) {
      if (name) out.set(name, lines.join("\n"));
      name = trimmed.slice(3, -3);
      lines = [];
      out.set(name, "");
      continue;
    }
    lines.push(line);
  }
  if (name) out.set(name, lines.join("\n"));
  if (!out.has("END") && name) {
    out.delete(name);
  }
  return out;
}

function parseDfDisks(text: string, isDarwin: boolean): ReadonlyArray<FleetDiskInfo> {
  const out: FleetDiskInfo[] = [];
  const seenMounts = new Set<string>();
  const seenDevs = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const cols = rawLine.trim().split(/\s+/);
    if (cols.length < 6 || cols[0] === "Filesystem") continue;
    const dev = cols[0]!;
    const totalKb = Number(cols[1]);
    const availKb = Number(cols[3]);
    const mount = cols.slice(5).join(" ");
    if (!Number.isFinite(totalKb) || totalKb <= 0 || seenMounts.has(mount) || seenDevs.has(dev)) {
      continue;
    }
    seenMounts.add(mount);
    seenDevs.add(dev);
    const total = totalKb * 1024;
    const avail = Number.isFinite(availKb) && availKb >= 0 ? availKb * 1024 : 0;
    const used = Math.max(0, Math.min(total, total - avail));
    const label = isDarwin
      ? "macOS"
      : mount === "/"
        ? "root (/home)"
        : mount === "/data"
          ? "/data"
          : mount;
    out.push({ mount, label, used, total });
  }
  return out;
}

function parseDarwinVmStat(text: string): { readonly used: number; readonly total: number } {
  const lines = text.trim().split("\n");
  const pageSize = Number(lines[0]?.trim() ?? "0");
  const totalBytes = Number(lines[1]?.trim() ?? "0");
  if (
    !Number.isFinite(pageSize) ||
    pageSize <= 0 ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0
  ) {
    return { used: 0, total: 0 };
  }
  const readPages = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  const free = readPages("Pages free");
  const inactive = readPages("Pages inactive");
  const speculative = readPages("Pages speculative");
  const avail = (free + inactive + speculative) * pageSize;
  return {
    used: Math.max(0, Math.min(totalBytes, totalBytes - avail)),
    total: totalBytes,
  };
}

function parseDarwinTopCpu(text: string): number | undefined {
  const matches = Array.from(text.matchAll(/CPU usage:\s+([0-9.]+)%\s+user,\s+([0-9.]+)%\s+sys/g));
  const last = matches[matches.length - 1];
  if (!last) return undefined;
  const busy = Number(last[1]) + Number(last[2]);
  return Number.isFinite(busy) ? Math.round(Math.max(0, Math.min(100, busy)) * 10) / 10 : undefined;
}

function parseLinuxCpuDelta(text: string): number | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("cpu "));
  if (lines.length < 2) return undefined;
  const first = parseProcStat(lines[0]!);
  const second = parseProcStat(lines[1]!);
  if (!first || !second || second.total <= first.total || second.idle < first.idle) {
    return undefined;
  }
  const dt = second.total - first.total;
  const di = second.idle - first.idle;
  return Math.round(Math.max(0, Math.min(100, (100 * (dt - di)) / dt)) * 10) / 10;
}

export function parseRemoteProbeOutput(
  hostName: string,
  text: string,
  sshAlias: string,
  note?: string,
): FleetNodeState {
  const sec = splitSections(text);
  const isDarwin = (sec.get("OS") ?? "").trim() === "Darwin";
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const loadNum = Number((sec.get("LOAD") ?? "").trim());
  const load1 = Number.isFinite(loadNum) ? Math.round(loadNum * 100) / 100 : undefined;
  const cpusNum = Number((sec.get("CPUS") ?? "").trim());
  const cpus = Number.isInteger(cpusNum) && cpusNum > 0 ? cpusNum : 1;

  let uptimeS = 0;
  if (isDarwin) {
    const bootSec = Number((sec.get("BOOT") ?? "").trim());
    if (Number.isFinite(bootSec) && bootSec > 0) {
      uptimeS = Math.max(0, Math.floor(Date.now() / 1000 - bootSec));
    }
  } else {
    const up = Number((sec.get("UPTIME") ?? "").trim());
    if (Number.isFinite(up) && up > 0) uptimeS = Math.floor(up);
  }

  const mem = isDarwin
    ? parseDarwinVmStat(sec.get("VMSTAT") ?? "")
    : (parseProcMeminfo(sec.get("MEMINFO") ?? "") ?? { used: 0, total: 0 });
  const cpuPct = isDarwin
    ? parseDarwinTopCpu(sec.get("CPU") ?? "")
    : parseLinuxCpuDelta(sec.get("CPU") ?? "");
  const disks = parseDfDisks(sec.get("DISK") ?? "", isDarwin);
  const gpu: FleetGpuInfo | null = !isDarwin ? parseGpuLines(sec.get("GPU") ?? "") : null;
  const servers: ReadonlyArray<FleetServerItem> = parseDockerPsLines(
    sec.get("DOCKER") ?? "",
    new Map(),
  );

  const powerRaw = sec.get("POWER") ?? "";
  const power: "ac" | "battery" | undefined = /Battery Power/i.test(powerRaw)
    ? "battery"
    : /AC Power/i.test(powerRaw)
      ? "ac"
      : undefined;

  const host: FleetHostTelemetry = {
    name: hostName,
    uptime_s: uptimeS,
    ...(load1 !== undefined ? { load1 } : {}),
    cpus,
    ...(cpuPct !== undefined ? { cpu_pct: cpuPct } : {}),
    cpu_hist: cpuPct !== undefined ? [cpuPct] : [],
    mem,
    disks,
    ...(gpu ? { gpu } : {}),
    ts: nowIso,
  };

  return {
    host,
    servers,
    sessions: parseRemoteProcs(sec.get("PROCS") ?? ""),
    status: "up",
    is_local: false,
    ssh: sshAlias,
    ...(note ? { note } : {}),
    ...(power ? { power } : {}),
    updated_at: nowIso,
  };
}
