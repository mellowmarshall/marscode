// @effect-diagnostics nodeBuiltinImport:off - Which installed host-guard file `ship-queue hosts on` trusts, checked on real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { pickTrustedGuardBinary } from "./hostsToggle.ts";

const tempDirs: string[] = [];
const UID = typeof process.getuid === "function" ? process.getuid() : -1;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function guardFile(mode: number): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-guard-bin-"));
  tempDirs.push(dir);
  const file = NodePath.join(dir, "marscode-host-guard");
  NodeFS.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  // chmod after the write, so the umask cannot mask the bits under test.
  NodeFS.chmodSync(file, mode);
  return file;
}

describe.skipIf(UID < 0)("the host guard file ship-queue trusts", () => {
  it("accepts a regular file owned by this user and writable only by it", () => {
    const file = guardFile(0o755);
    expect(pickTrustedGuardBinary([file], UID)).toBe(NodeFS.realpathSync(file));
  });

  it("refuses a file that group or others can write", () => {
    expect(pickTrustedGuardBinary([guardFile(0o775)], UID)).toBeNull();
    expect(pickTrustedGuardBinary([guardFile(0o757)], UID)).toBeNull();
  });

  it("refuses a symlink to an unsafe file, and takes the next safe candidate", () => {
    const unsafe = guardFile(0o777);
    const link = NodePath.join(NodePath.dirname(unsafe), "linked-guard");
    NodeFS.symlinkSync(unsafe, link);
    expect(pickTrustedGuardBinary([link], UID)).toBeNull();
    const safe = guardFile(0o755);
    expect(pickTrustedGuardBinary([link, safe], UID)).toBe(NodeFS.realpathSync(safe));
  });

  it.skipIf(UID === 0)("refuses a file owned by another user (uid comparison injected)", () => {
    // Making a file with a foreign owner needs root, so the caller's uid is the injected value.
    const file = guardFile(0o755);
    const otherUid = UID === 0 ? 1 : UID + 1;
    expect(pickTrustedGuardBinary([file], otherUid)).toBeNull();
  });

  it("refuses a missing candidate and a directory", () => {
    const dir = NodePath.dirname(guardFile(0o755));
    expect(pickTrustedGuardBinary([NodePath.join(dir, "absent"), dir], UID)).toBeNull();
  });
});
