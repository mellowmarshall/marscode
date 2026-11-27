// @effect-diagnostics nodeBuiltinImport:off - Checkout .env.ports ledger, docker/server port bind checks, and SessionStart hook formatter.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { safeRealpath } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";

const PORTS_ENV_FILE = ".env.ports";
const DEFAULT_PORT_RANGE_MIN = 4000;
const DEFAULT_PORT_RANGE_MAX = 4999;

const PORT_LINE_RE = /^([A-Z][A-Z0-9_]*_PORT)=([0-9]+)$/;
const PORT_FLAGS = new Set(["--port", "-p", "--publish", "-P"]);
const SERVER_PORT_ENV_RE = /^(?:PORT|[A-Z0-9_]+_PORT)$/;

export interface PortsFileData {
  readonly label: string;
  readonly ports: ReadonlyArray<{ readonly name: string; readonly port: number }>;
}

function findPortsEnvDir(startDir: string): string | null {
  let cur = safeRealpath(startDir);
  for (let i = 0; i < 64; i += 1) {
    const candidate = NodePath.join(cur, PORTS_ENV_FILE);
    try {
      if (NodeFS.statSync(candidate).isFile()) return cur;
    } catch {
      // keep walking upward
    }
    const parent = NodePath.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function readPortsEnvFile(filePath: string): PortsFileData {
  let label = "";
  const ports: Array<{ readonly name: string; readonly port: number }> = [];
  let raw: string;
  try {
    raw = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return { label, ports };
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (!label) {
        const cleaned = line.replace(/^#+\s*/, "").trim();
        if (cleaned) label = cleaned;
      }
      continue;
    }
    const match = PORT_LINE_RE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const port = Number.parseInt(match[2], 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.push({ name: match[1], port });
    }
  }
  return { label, ports };
}

export function computePortsEnvUpdate(
  dir: string,
  currentEnv: NodeJS.ProcessEnv = process.env,
): {
  readonly set: Readonly<Record<string, string>>;
  readonly unset: ReadonlyArray<string>;
} {
  const realDir = safeRealpath(dir);
  const { ports } = readPortsEnvFile(NodePath.join(realDir, PORTS_ENV_FILE));
  const prevNames = (currentEnv.HG_PORTS_NAMES ?? "").split(/\s+/).filter(Boolean);
  const sameDir = currentEnv.HG_PORTS_DIR === realDir;
  const givenMap = new Map<string, string>();
  for (const item of (currentEnv.HG_PORTS_VALUES ?? "").split(/\s+/).filter(Boolean)) {
    const eq = item.indexOf("=");
    if (eq !== -1) givenMap.set(item.slice(0, eq), item.slice(eq + 1));
  }

  const nextEnv: Record<string, string | undefined> = { ...currentEnv };
  const unset: string[] = [];
  if (!sameDir) {
    for (const name of prevNames) {
      if (
        PORT_LINE_RE.test(`${name}=0`) &&
        (!givenMap.has(name) || currentEnv[name] === givenMap.get(name))
      ) {
        delete nextEnv[name];
        unset.push(name);
      }
    }
  }

  const set: Record<string, string> = {};
  const ours: string[] = [];
  for (const { name, port } of ports) {
    const portStr = String(port);
    if (nextEnv[name] === undefined) {
      nextEnv[name] = portStr;
      set[name] = portStr;
      ours.push(name);
    } else if (sameDir && prevNames.includes(name)) {
      ours.push(name);
    }
  }
  set.HG_PORTS_DIR = realDir;
  set.HG_PORTS_NAMES = ours.join(" ");
  set.HG_PORTS_VALUES = ours.map((n) => `${n}=${nextEnv[n] ?? ""}`).join(" ");
  return { set, unset };
}

function parseDockerPublishHostPort(spec: string): number | null {
  // Formats: "8080:80", "127.0.0.1:8080:80", "[::1]:8080:80/tcp"
  const noProto = spec.split("/", 1)[0] ?? "";
  const parts = noProto.split(":");
  if (parts.length < 2) return null;
  const hostPortStr = parts.length === 2 ? parts[0]! : parts[parts.length - 2]!;
  if (!/^\d+$/.test(hostPortStr)) return null;
  const port = Number.parseInt(hostPortStr, 10);
  return port > 0 && port <= 65535 ? port : null;
}

function extractBoundPorts(
  words: ReadonlyArray<string>,
  assignedEnv: Readonly<Record<string, string>> = {},
): ReadonlyArray<number> {
  if (words.length === 0) return [];
  const base = NodePath.basename(words[0]!);
  const found = new Set<number>();

  for (const [k, v] of Object.entries(assignedEnv)) {
    if (SERVER_PORT_ENV_RE.test(k) && /^\d+$/.test(v.trim())) {
      const p = Number.parseInt(v.trim(), 10);
      if (p > 0 && p <= 65535) found.add(p);
    }
  }

  const isDocker = base === "docker" || base === "podman";
  for (let i = 1; i < words.length; i += 1) {
    const tok = words[i]!;
    if (tok === "--") break;
    const eq = tok.indexOf("=");
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const attached = eq === -1 ? "" : tok.slice(eq + 1);
    const next = i + 1 < words.length ? words[i + 1]! : "";

    if (isDocker && (flag === "-p" || flag === "--publish")) {
      const spec = eq !== -1 ? attached : next;
      if (eq === -1 && next) i += 1;
      const port = parseDockerPublishHostPort(spec);
      if (port !== null) found.add(port);
      continue;
    }

    if (!isDocker && (PORT_FLAGS.has(flag) || flag === "--listen")) {
      const val = eq !== -1 ? attached : next;
      if (eq === -1 && next) i += 1;
      if (/^\d+$/.test(val)) {
        const p = Number.parseInt(val, 10);
        if (p > 0 && p <= 65535) found.add(p);
      }
    }
  }

  return Array.from(found).toSorted((a, b) => a - b);
}

export function decidePortsCheck(
  words: ReadonlyArray<string>,
  cwd: string,
  assignedEnv: Readonly<Record<string, string>> = {},
  options?: {
    readonly rangeMin?: number | undefined;
    readonly rangeMax?: number | undefined;
  },
): GuardVerdict {
  const ports = extractBoundPorts(words, assignedEnv);
  if (ports.length === 0) return ALLOW_VERDICT;

  const rangeMin = options?.rangeMin ?? DEFAULT_PORT_RANGE_MIN;
  const rangeMax = options?.rangeMax ?? DEFAULT_PORT_RANGE_MAX;
  const inManagedRange = (p: number) => p >= rangeMin && p <= rangeMax;

  const where = findPortsEnvDir(cwd);
  if (where === null) {
    const bad = ports.filter(inManagedRange);
    if (bad.length === 0) return ALLOW_VERDICT;
    return {
      verdict: "deny",
      reason:
        `host ports guard: refusing \`${words.join(" ").slice(0, 80)}\`: port ${bad.join(", ")} ` +
        `is in the managed port range (${rangeMin}-${rangeMax}), and ${cwd} has no ${PORTS_ENV_FILE}.`,
    };
  }

  const { ports: entries } = readPortsEnvFile(NodePath.join(where, PORTS_ENV_FILE));
  const allowed = new Map<number, string>();
  for (const e of entries) allowed.set(e.port, e.name);

  const bad = ports.filter((p) => !allowed.has(p));
  if (bad.length === 0) return ALLOW_VERDICT;

  const ownedSummary =
    Array.from(allowed.entries())
      .toSorted(([a], [b]) => a - b)
      .map(([p, name]) => `${name}=${p}`)
      .join(", ") || "none";
  return {
    verdict: "deny",
    reason:
      `host ports guard: refusing \`${words.join(" ").slice(0, 80)}\`: port ${bad.join(", ")} is not assigned to ${where}. ` +
      `Assigned ports: ${ownedSummary}.`,
  };
}

function shellQuote(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

export function runPortsSessionHook(options: {
  readonly agent: string;
  readonly stdinText: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): { readonly exitCode: number; readonly stdout: string } {
  const env = options.env ?? process.env;
  let eventCwd = options.cwd;
  if (options.stdinText.trim()) {
    try {
      const parsed = JSON.parse(options.stdinText) as { cwd?: unknown };
      if (typeof parsed.cwd === "string" && parsed.cwd.trim()) {
        eventCwd = parsed.cwd.trim();
      }
    } catch {
      // Use fallback cwd when stdin is not valid JSON.
    }
  }

  const where = findPortsEnvDir(eventCwd);
  if (where === null) return { exitCode: 0, stdout: "" };

  const { label, ports } = readPortsEnvFile(NodePath.join(where, PORTS_ENV_FILE));
  if (ports.length === 0) return { exitCode: 0, stdout: "" };

  const displayLabel = label || NodePath.basename(where);
  const summary = `ports (${displayLabel}): ${ports.map((p) => `${p.name}=${p.port}`).join(" ")}`;

  const envFile = env.CLAUDE_ENV_FILE?.trim();
  if (options.agent === "claude" && envFile) {
    const managedKeys = new Set([
      ...ports.map((p) => p.name),
      "HG_PORTS_DIR",
      "HG_PORTS_NAMES",
      "HG_PORTS_VALUES",
    ]);
    let kept: string[] = [];
    try {
      const existing = NodeFS.readFileSync(envFile, "utf8");
      kept = existing.split("\n").filter((ln) => {
        if (!ln.startsWith("export ")) return ln.length > 0;
        const key = ln.slice("export ".length).split("=", 1)[0] ?? "";
        return !managedKeys.has(key);
      });
    } catch {
      kept = [];
    }
    for (const p of ports) {
      kept.push(`export ${p.name}=${p.port}`);
    }
    kept.push(`export HG_PORTS_DIR=${shellQuote(where)}`);
    kept.push(`export HG_PORTS_NAMES=${shellQuote(ports.map((p) => p.name).join(" "))}`);
    kept.push(
      `export HG_PORTS_VALUES=${shellQuote(ports.map((p) => `${p.name}=${p.port}`).join(" "))}`,
    );
    NodeFS.mkdirSync(NodePath.dirname(envFile), { recursive: true });
    NodeFS.writeFileSync(envFile, `${kept.join("\n")}\n`, "utf8");
  }

  return { exitCode: 0, stdout: `${summary}\n` };
}
