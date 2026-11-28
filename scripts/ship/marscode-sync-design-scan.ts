// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge installer runs from extracted base tree without Effect/node_modules.
// Installs the playbook's design scan (packages/playbook/dist/pb_design_scan.mjs, the original
// playbook's scan bundled into one file) at <prefix>/lib/playbook/pb_design_scan.mjs, the path
// repos' design evidence runs directly. A file there that MarsCode did not write (another
// install's copy) is kept, with one warning line, as marscode-sync keeps another install's CLI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { WRAPPER_MARKER } from "./marscode-sync-parity.ts";

export const DESIGN_SCAN = "pb_design_scan.mjs";
const MARKER_LINE = `// ${WRAPPER_MARKER.slice(2)}`;

/** The design scan's bundle in a built worktree. */
export function designScanBundle(worktree: string): string {
  return NodePath.join(worktree, "packages", "playbook", "dist", DESIGN_SCAN);
}

/** Why the file at PATH is not MarsCode's to replace; null when it is absent or MarsCode wrote it. */
function foreign(path: string): string | null {
  let st: NodeFS.Stats;
  try {
    st = NodeFS.lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `a link to ${NodeFS.readlinkSync(path)}`;
  if (!st.isFile()) return "not a regular file";
  let first: string | undefined;
  try {
    first = NodeFS.readFileSync(path, "utf8").split("\n", 1)[0];
  } catch {
    return "a file marscode-sync cannot read";
  }
  return first === MARKER_LINE ? null : "a file another install wrote";
}

/**
 * Install the design scan from WORKTREE into DIR: "installed", "current" when DIR already
 * holds this bundle, or "kept" when another install's copy (or one it cannot read) stays.
 */
export function installDesignScan(
  worktree: string,
  opts: {
    readonly dir: string;
    readonly log: (msg: string) => void;
    readonly warn: (msg: string) => void;
  },
): "installed" | "current" | "kept" {
  const src = designScanBundle(worktree);
  if (!NodeFS.existsSync(src)) throw new Error(`marscode-sync: missing built bundle ${src}`);
  const dest = NodePath.join(opts.dir, DESIGN_SCAN);
  const kept = foreign(dest);
  if (kept !== null) {
    opts.warn(
      `marscode-sync: warning: skipped ${DESIGN_SCAN}: kept ${dest} (${kept}, not installed by marscode-sync); remove it to let marscode-sync install its design scan.`,
    );
    return "kept";
  }
  const text = `${MARKER_LINE}\n${NodeFS.readFileSync(src, "utf8")}`;
  if (NodeFS.existsSync(dest) && NodeFS.readFileSync(dest, "utf8") === text) return "current";
  NodeFS.mkdirSync(opts.dir, { recursive: true });
  const tmp = NodePath.join(opts.dir, `.${DESIGN_SCAN}.next.${process.pid}`);
  try {
    NodeFS.writeFileSync(tmp, text, { mode: 0o644 });
    NodeFS.renameSync(tmp, dest);
  } finally {
    NodeFS.rmSync(tmp, { force: true });
  }
  opts.log(`marscode-sync: installed ${dest}`);
  return "installed";
}
