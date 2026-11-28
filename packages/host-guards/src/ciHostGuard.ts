// @effect-diagnostics nodeBuiltinImport:off - Owner-only rule for `ship-queue hosts on`: a CI host turned off with a reason stays off unless the owner approves.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type CiHostOnDecision =
  | { readonly verdict: "allow" }
  | { readonly verdict: "deny"; readonly reason: string };

const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface OffMarker {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
}

/**
 * Reads `<queueRoot>/hosts/<host>.off` the way ship-queue writes it (`at=`, `by=`, `reason=`
 * lines). A hand-written marker with none of those fields keeps its text as the reason. A marker
 * that exists but cannot be read counts as one with a reason, so the rule fails closed.
 */
function readOffMarker(queueRoot: string, host: string): OffMarker | null {
  const filePath = NodePath.join(queueRoot, "hosts", `${host}.off`);
  if (!NodeFS.existsSync(filePath)) return null;
  let text: string;
  try {
    text = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return { at: "", by: "", reason: "unreadable .off marker" };
  }
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const known = fields.at !== undefined || fields.by !== undefined || fields.reason !== undefined;
  const loose = known ? "" : text.replace(/\s+/g, " ").trim().slice(0, 500);
  return { at: fields.at ?? "", by: fields.by ?? "", reason: fields.reason || loose };
}

/**
 * `ship-queue hosts on <host>` removes the host's `.off` marker. When that marker carries a reason
 * (usually the owner protecting a long task on the host), only the owner may remove it, so the
 * request goes through the host-guard override flow. A marker with no reason, or no marker, is a
 * normal turn-on.
 */
export function decideCiHostOn(input: {
  readonly queueRoot: string;
  readonly host: string;
}): CiHostOnDecision {
  const host = input.host.trim();
  if (!SAFE_HOST_RE.test(host)) return { verdict: "allow" };
  const marker = readOffMarker(input.queueRoot, host);
  const reason = marker?.reason.trim() ?? "";
  if (!marker || !reason) return { verdict: "allow" };
  return {
    verdict: "deny",
    reason:
      `host guard: refusing \`ship-queue hosts on ${host}\`: CI was turned off on ${host} ` +
      `by ${marker.by || "unknown"} at ${marker.at || "an unknown time"} with a reason: ${reason}. ` +
      "Only the owner can turn it back on.",
  };
}
