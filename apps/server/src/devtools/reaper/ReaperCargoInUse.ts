// @effect-diagnostics nodeBuiltinImport:off - Paths that services name (systemd, launchd, XDG autostart, crontab, command links).
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const PATH_TOKEN_RE = /\/[^\s"'<>;:,=]+/g;
const CRONTAB_TIMEOUT_MS = 10_000;

/** Folders whose files a service manager reads, each with the file suffix it reads. */
function defaultUnitSources(homeDir: string): ReadonlyArray<{
  readonly dir: string;
  readonly suffix: string;
  readonly dropIns?: boolean;
}> {
  const systemdDirs = [
    NodePath.join(homeDir, ".config", "systemd", "user"),
    NodePath.join(homeDir, ".local", "share", "systemd", "user"),
    "/etc/systemd/user",
    "/etc/systemd/system",
  ];
  return [
    ...systemdDirs.map((dir) => ({ dir, suffix: ".service", dropIns: true })),
    { dir: NodePath.join(homeDir, ".config", "autostart"), suffix: ".desktop" },
    { dir: NodePath.join(homeDir, "Library", "LaunchAgents"), suffix: ".plist" },
    { dir: "/Library/LaunchAgents", suffix: ".plist" },
    { dir: "/Library/LaunchDaemons", suffix: ".plist" },
  ];
}

function defaultLinkDirs(homeDir: string): ReadonlyArray<string> {
  return [NodePath.join(homeDir, ".local", "bin"), NodePath.join(homeDir, "bin")];
}

/** The user's crontab; a failure or no crontab reads as empty. */
function readCrontab(): Promise<string> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile("crontab", ["-l"], { timeout: CRONTAB_TIMEOUT_MS }, (error, stdout) =>
      resolve(error ? "" : stdout),
    );
  });
}

async function readTexts(dir: string, suffix: string, dropIns: boolean): Promise<string[]> {
  const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  const texts: string[] = [];
  for (const name of names) {
    const target = NodePath.join(dir, name);
    if (name.endsWith(suffix)) {
      texts.push(await NodeFSP.readFile(target, "utf8").catch(() => ""));
    } else if (dropIns && name.endsWith(`${suffix}.d`)) {
      for (const conf of await NodeFSP.readdir(target).catch(() => [] as string[])) {
        if (conf.endsWith(".conf")) {
          texts.push(await NodeFSP.readFile(NodePath.join(target, conf), "utf8").catch(() => ""));
        }
      }
    }
  }
  return texts;
}

export interface NamedPathSources {
  readonly homeDir: string;
  readonly unitSources?: ReturnType<typeof defaultUnitSources>;
  readonly linkDirs?: ReadonlyArray<string>;
  readonly crontab?: () => Promise<string>;
}

/**
 * Every absolute path a service names (`%h` is home), as written and as a real path, plus the
 * targets of the links in the command folders: a service runs `target/release/server`.
 */
export async function serviceNamedPaths(sources: NamedPathSources): Promise<Set<string>> {
  const texts = [await (sources.crontab ?? readCrontab)()];
  for (const source of sources.unitSources ?? defaultUnitSources(sources.homeDir)) {
    texts.push(...(await readTexts(source.dir, source.suffix, source.dropIns === true)));
  }
  const paths = new Set<string>();
  for (const text of texts) {
    for (const token of text.replaceAll("%h", sources.homeDir).match(PATH_TOKEN_RE) ?? []) {
      const trimmed = token.length > 1 ? token.replace(/\/+$/, "") : token;
      paths.add(trimmed);
      paths.add(await NodeFSP.realpath(trimmed).catch(() => trimmed));
    }
  }
  for (const dir of sources.linkDirs ?? defaultLinkDirs(sources.homeDir)) {
    for (const name of await NodeFSP.readdir(dir).catch(() => [] as string[])) {
      const link = NodePath.join(dir, name);
      const st = await NodeFSP.lstat(link).catch(() => null);
      if (st?.isSymbolicLink() === true) {
        const target = await NodeFSP.realpath(link).catch(async () =>
          NodePath.resolve(dir, await NodeFSP.readlink(link).catch(() => link)),
        );
        paths.add(target);
      }
    }
  }
  return paths;
}
