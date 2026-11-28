#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot media build and CI check; synchronous Node APIs keep it small.
// Renders README media from real web components with neutral fixtures (apps/web/test/readme),
// then records a hash of the sources each image depicts in docs/readme/media.json.
// `--check` recomputes those hashes without a browser and fails when media is stale.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const MEDIA_DIR = NodePath.join(ROOT, "docs/readme");
const MANIFEST = NodePath.join(MEDIA_DIR, "media.json");
const WEB_DIR = NodePath.join(ROOT, "apps/web");

interface MediaEntry {
  readonly sources: ReadonlyArray<string>;
  hash?: string;
}
type Manifest = Record<string, MediaEntry>;

// Seconds each frame shows, output width, and whether the last frame holds twice as long so the
// loop reads as an end state (a seamless cycle such as a pulse does not hold).
const GIFS = {
  "cite.gif": { seconds: 1.2, width: 640, holdLast: true },
  "ship-queue.gif": { seconds: 0.8, width: 900, holdLast: true },
  "approval-glow.gif": { seconds: 0.2, width: 320, holdLast: false },
  "job-health.gif": { seconds: 0.9, width: 300, holdLast: true },
} as const;

function readManifest(): Manifest {
  return JSON.parse(NodeFS.readFileSync(MANIFEST, "utf8")) as Manifest;
}

function hashSources(globs: ReadonlyArray<string>): string {
  const files = new Set<string>();
  for (const pattern of globs) {
    const matches = NodeFS.globSync(pattern, { cwd: ROOT });
    if (matches.length === 0) throw new Error(`media.json source matches no file: ${pattern}`);
    for (const file of matches) files.add(file.split(NodePath.sep).join("/"));
  }
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [...files].toSorted()) {
    hash.update(`${file}\0`);
    hash.update(NodeFS.readFileSync(NodePath.join(ROOT, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function check(): number {
  const manifest = readManifest();
  const stale = Object.entries(manifest).flatMap(([name, entry]) => {
    if (!NodeFS.existsSync(NodePath.join(MEDIA_DIR, name))) return [`${name} (missing)`];
    return entry.hash === hashSources(entry.sources) ? [] : [name];
  });
  if (stale.length === 0) {
    console.log(`readme media: ${Object.keys(manifest).length} files current`);
    return 0;
  }
  console.error(`readme media is stale: ${stale.join(", ")}`);
  console.error("run: vp run readme:media");
  return 1;
}

// Playwright's pinned headless shell is not always installed; use the newest build that is.
function newestHeadlessShell(): string {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? NodePath.join(NodeOS.homedir(), ".cache/ms-playwright");
  const builds = NodeFS.readdirSync(cache)
    .filter((dir) => /^chromium_headless_shell-\d+$/.test(dir))
    .map((dir) => ({ dir, revision: Number(dir.split("-")[1]) }))
    .toSorted((a, b) => b.revision - a.revision);
  for (const { dir } of builds) {
    const bin = NodePath.join(cache, dir, "chrome-headless-shell-linux64/chrome-headless-shell");
    if (NodeFS.existsSync(bin)) return bin;
  }
  throw new Error(`no chromium headless shell under ${cache}; this script does not download one`);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnSyncOptions = {},
) {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  return result.status ?? 1;
}

function ffmpeg(args: ReadonlyArray<string>) {
  if (run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]) !== 0) {
    throw new Error(`ffmpeg failed: ${args.join(" ")}`);
  }
}

function buildGif(name: keyof typeof GIFS, framesDir: string, out: string) {
  const frames = NodeFS.readdirSync(framesDir)
    .filter((f) => f.endsWith(".png"))
    .toSorted();
  // The concat demuxer drops frames whose size differs from the first one.
  const sizes = new Set(
    frames.map((f) =>
      NodeFS.readFileSync(NodePath.join(framesDir, f)).subarray(16, 24).toString("hex"),
    ),
  );
  if (sizes.size !== 1)
    throw new Error(`${name}: frames differ in size; pin the MediaFrame height`);
  const { seconds, width, holdLast } = GIFS[name];
  const list = frames.flatMap((f, i) => [
    `file '${NodePath.join(framesDir, f)}'`,
    `duration ${holdLast && i === frames.length - 1 ? seconds * 2 : seconds}`,
  ]);
  // The concat demuxer ignores the last duration unless the last file repeats.
  list.push(`file '${NodePath.join(framesDir, frames.at(-1)!)}'`);
  const listFile = NodePath.join(framesDir, "frames.txt");
  NodeFS.writeFileSync(listFile, `${list.join("\n")}\n`);
  const scale = `scale=${width}:-1:flags=lanczos`;
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-vf",
    `${scale},split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none`,
    "-loop",
    "0",
    out,
  ]);
}

function generate(): number {
  const manifest = readManifest();
  const outDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "readme-media-"));
  const env = {
    ...process.env,
    T3CODE_README_MEDIA_DIR: outDir,
    T3CODE_README_MEDIA_BROWSER: newestHeadlessShell(),
  };
  console.log(`readme media: browser ${env.T3CODE_README_MEDIA_BROWSER}`);
  const test = () => run("vp", ["test", "run", "--project", "readme-media"], { cwd: WEB_DIR, env });
  // A cold Vite dependency cache reloads the page mid-run once; the second run is warm.
  if (test() !== 0 && test() !== 0) return 1;

  for (const [name, entry] of Object.entries(manifest)) {
    const out = NodePath.join(MEDIA_DIR, name);
    const base = name.replace(/\.(webp|gif)$/, "");
    if (name.endsWith(".gif")) {
      buildGif(name as keyof typeof GIFS, NodePath.join(outDir, "frames", base), out);
    } else {
      ffmpeg([
        "-i",
        NodePath.join(outDir, `${base}.png`),
        "-c:v",
        "libwebp",
        "-quality",
        "82",
        out,
      ]);
    }
    entry.hash = hashSources(entry.sources);
    console.log(`readme media: ${name} ${(NodeFS.statSync(out).size / 1024).toFixed(0)} KiB`);
  }
  NodeFS.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  return 0;
}

process.exitCode = process.argv.includes("--check") ? check() : generate();
