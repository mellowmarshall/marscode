/**
 * The minimal valid evidence-only playbook.json: what `playbook init` writes and
 * `playbook minimal [--merge JSON]` prints (for fixtures and repos with nothing detected).
 */
import { EXIT_USAGE } from "./result.ts";
import { isRecord } from "./strictJson.ts";

export const MINIMAL_DECLARATION = {
  evidenceDir: ".playbook/evidence",
  contracts: {
    size: { evidence: ".playbook/evidence/size.json" },
    generations: { none: "no generated artifacts yet" },
    fleet: { none: "no deployed infrastructure yet" },
    optimization: { none: "nothing to budget: no route, job or action" },
    tools: { evidence: ".playbook/evidence/tools.json" },
  },
  ci: {
    evidence: ".playbook/evidence/ci.json",
    granularThresholdMs: 30000,
  },
} as const;

/**
 * The minimal declaration with MERGE's contracts merged in: an object value merges into
 * the default, null removes the contract, any other value replaces it.
 */
function minimalDeclaration(
  merge: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const contracts: Record<string, unknown> = Object.fromEntries(
    Object.entries(MINIMAL_DECLARATION.contracts).map(([k, v]) => [k, { ...v }]),
  );
  for (const [name, value] of Object.entries(merge)) {
    if (value === null) {
      delete contracts[name];
      continue;
    }
    const base = contracts[name];
    contracts[name] = isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
  }
  return {
    evidenceDir: MINIMAL_DECLARATION.evidenceDir,
    contracts,
    ci: { ...MINIMAL_DECLARATION.ci },
  };
}

/** Python's json.dumps with its default separators and ensure_ascii. */
function pythonJsonCompact(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pythonJsonCompact).join(", ")}]`;
  if (isRecord(v)) {
    const parts = Object.entries(v).map(([k, x]) => `${asciiJson(k)}: ${pythonJsonCompact(x)}`);
    return `{${parts.join(", ")}}`;
  }
  return asciiJson(v);
}

function asciiJson(v: unknown): string {
  return (JSON.stringify(v) ?? "null").replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** `playbook minimal [--merge JSON]`: one line of JSON. */
export function cmdMinimal(merge: string | undefined, io: Io): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(merge ?? "{}");
  } catch (cause) {
    io.err(
      `playbook: --merge is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_USAGE;
  }
  if (!isRecord(parsed)) {
    io.err("playbook: --merge is not a JSON object");
    return EXIT_USAGE;
  }
  io.out(pythonJsonCompact(minimalDeclaration(parsed)));
  return 0;
}
