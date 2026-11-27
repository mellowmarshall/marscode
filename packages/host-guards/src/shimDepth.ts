// @effect-diagnostics nodeBuiltinImport:off - Shim recursion guard (HG_SHIM_DEPTH / HG_SHIM_NEXT / HG_SHIM_HOPS).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const SHIM_DEPTH_LIMIT = 1;
const SHIM_HOPS_LIMIT = 32;
const SHIM_RECURSION_EXIT_CODE = 126;

export interface ShimDepthOk {
  readonly ok: true;
  readonly depth: number;
  readonly hops: number;
  readonly nextEnv: Readonly<Record<string, string>>;
}

export interface ShimDepthRefused {
  readonly ok: false;
  readonly exitCode: number;
  readonly depth: number;
  readonly hops: number;
  readonly message: string;
}

export type ShimDepthResult = ShimDepthOk | ShimDepthRefused;

function sameFile(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const stA = NodeFS.statSync(a);
    const stB = NodeFS.statSync(b);
    return stA.dev === stB.dev && stA.ino === stB.ino;
  } catch {
    return NodePath.resolve(a) === NodePath.resolve(b);
  }
}

function parseNonNegativeCounter(raw: string | undefined): number {
  if (!raw || !/^[0-9]+$/.test(raw)) return 0;
  return Number.parseInt(raw.slice(0, 4), 10);
}

/**
 * Checks shim nesting depth before handing execution to the real binary.
 * Refuses at depth >= 2 (depth > SHIM_DEPTH_LIMIT) or total ancestry hops > 32 with exit 126.
 */
export function checkShimDepth(
  shimPath: string,
  realPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ShimDepthResult {
  const prevDepth = parseNonNegativeCounter(env.HG_SHIM_DEPTH);
  const hops = parseNonNegativeCounter(env.HG_SHIM_HOPS) + 1;
  const nextExpected = env.HG_SHIM_NEXT ?? "";

  let depth: number;
  let chain: string;
  if (nextExpected && sameFile(nextExpected, shimPath)) {
    depth = prevDepth + 1;
    chain = `${env.HG_SHIM_CHAIN || "?"} -> ${shimPath}`;
  } else {
    depth = 1;
    chain = shimPath;
  }

  const trail = env.HG_SHIM_TRAIL ? `${env.HG_SHIM_TRAIL} -> ${shimPath}` : shimPath;
  const name = NodePath.basename(shimPath);

  if (depth > SHIM_DEPTH_LIMIT) {
    return {
      ok: false,
      exitCode: SHIM_RECURSION_EXIT_CODE,
      depth,
      hops,
      message: `host-guards: shim recursion (${name}, depth ${depth}): ${chain}`,
    };
  }
  if (hops > SHIM_HOPS_LIMIT) {
    return {
      ok: false,
      exitCode: SHIM_RECURSION_EXIT_CODE,
      depth,
      hops,
      message: `host-guards: shim recursion (${name}, ${hops} shim starts in one process ancestry): ${trail}`,
    };
  }

  return {
    ok: true,
    depth,
    hops,
    nextEnv: {
      HG_SHIM_DEPTH: String(depth),
      HG_SHIM_CHAIN: chain,
      HG_SHIM_NEXT: realPath,
      HG_SHIM_HOPS: String(hops),
      HG_SHIM_TRAIL: trail,
    },
  };
}
