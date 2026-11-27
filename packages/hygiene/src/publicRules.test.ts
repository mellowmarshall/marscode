import { describe, expect, it } from "vite-plus/test";

import { parsePolicy } from "./hygienePolicy.ts";
import type { HygieneSurface } from "./hygieneCatalog.ts";
import { checkIdentity, checkTrailerEmail } from "./identity.ts";
import { scanText } from "./textScan.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function rules(text: string, surface: HygieneSurface = "tree"): ReadonlyArray<string> {
  return scanText(text, { source: "sample", surface, denylist: null }).map(
    (f) => `${f.classId} ${f.rule}`,
  );
}

describe("home-paths", () => {
  it("flags an unknown user's home and allows neutral names", () => {
    expect(rules("cd /home/zzqx/project")).toEqual(["home-paths public:home-paths"]);
    expect(rules("open /Users/qrvz/Library")).toEqual(["home-paths public:home-paths"]);
    expect(rules("/home/dev/repo /Users/user/x /home/runner/w /home/.config")).toEqual([]);
    expect(rules("apps/mobile/src/features/home/homeList.ts")).toEqual([]);
    expect(rules("/home/$USER and /home/<user>")).toEqual([]);
  });

  it("allows an upstream name only through the policy file", () => {
    const policy = parsePolicy(
      JSON.stringify({
        upstreamNames: [{ name: "zzqx", reason: "upstream fixture path kept as is", issue: "#1" }],
      }),
    );
    const found = scanText("/home/zzqx/x", {
      source: "s",
      surface: "tree",
      denylist: null,
      policy,
    });
    expect(found).toEqual([]);
  });
});

describe("data-layout", () => {
  it("flags data roots, backups, and private file links", () => {
    expect(rules("worktree at /data/Dev/widget-lab/wt")).toEqual([
      "data-layout public:data-dev-root",
    ]);
    expect(rules("rsync to /data/archive-backup/")).toEqual([
      "data-layout public:data-backup-root",
    ]);
    expect(rules("see file:///home/zzqx/notes.md")).toEqual(["data-layout public:file-url"]);
    expect(rules("see file:///data/Dev")).toEqual(["data-layout public:file-url"]);
  });

  it("allows neutral file links and unrelated data paths", () => {
    expect(rules("file:///home/alice/a.md file:///Users/dev/b file:///data/local/tmp")).toEqual([]);
    expect(rules("/data/data/com.example.app and /srv/data/Dev")).toEqual([]);
  });

  it("allows placeholder and public names under the public /data/Dev default root", () => {
    expect(
      rules(
        "/data/Dev/project-a /data/Dev/example-repo /data/Dev/sample-repo /data/Dev/.ship-queue",
      ),
    ).toEqual([]);
    expect(rules("/data/Dev/marscode/wt /data/Dev/repo /data/Dev/tools")).toEqual([]);
    expect(rules("/data/Dev/project-ab")).toEqual(["data-layout public:data-dev-root"]);
  });
});

describe("ssh-targets", () => {
  it("flags ssh to a machine that is not a placeholder", () => {
    expect(rules("ssh deploy@build-box-7")).toEqual(["ssh-targets public:ssh-target"]);
    expect(rules("ssh -p 2222 -i key ops@10.20.30.40")).toEqual(["ssh-targets public:ssh-target"]);
  });

  it("allows placeholders and public forges", () => {
    expect(rules("ssh dev@example.com; ssh a@box.test; ssh a@host-a; ssh a@localhost")).toEqual([]);
    expect(rules("ssh -T git@github.com; ssh u@203.0.113.9; ssh u@node.invalid")).toEqual([]);
    expect(rules("ssh -p 2222 dev@host-d-linux")).toEqual([]);
    expect(rules("ssh dev@host-dlinux")).toEqual(["ssh-targets public:ssh-target"]);
    expect(rules("git clone ssh://git@private-host/repo")).toEqual([]);
  });
});

describe("network-identity", () => {
  it("flags a tailnet name that is not a placeholder", () => {
    expect(rules("https://desk.tail77aa.ts.net/")).toEqual([
      "network-identity public:tailnet-host",
    ]);
  });

  it("allows placeholder tailnets and leaves private IP ranges alone", () => {
    expect(rules("box.tailnet.ts.net host.example.ts.net vps.ts.net a.tail1234.ts.net")).toEqual(
      [],
    );
    expect(rules("listen on 10.0.0.5 and 192.168.1.20")).toEqual([]);
  });
});

describe("agent-session-ids", () => {
  it("allows opaque ids with the neutral agent name", () => {
    expect(rules(`Co-authored-by: MarsCode Agent <${UUID}@agents.local>`)).toEqual([]);
    expect(rules(`Agent Session: ${UUID}\nAgent Thread: t3-thread://${UUID}/${UUID}`)).toEqual([]);
    expect(rules("lines.push(`Agent Thread: ${thread}`)")).toEqual([]);
    expect(rules("the `@agents.local` domain")).toEqual([]);
  });

  it("flags thread titles and free text", () => {
    expect(rules(`Co-authored-by: Tidy Up Widgets <${UUID}@agents.local>`)).toEqual([
      "agent-session-ids public:agents-local",
    ]);
    expect(rules("Co-authored-by: MarsCode Agent <tidy-widgets@agents.local>")).toEqual([
      "agent-session-ids public:agents-local",
    ]);
    expect(rules("Agent Thread: Tidy up the widget list")).toEqual([
      "agent-session-ids public:agent-session-line",
    ]);
    expect(rules(`Agent Session: ${UUID} (tidy widgets)`)).toEqual([
      "agent-session-ids public:agent-session-line",
    ]);
  });
});

describe("operational-telemetry", () => {
  it("flags load, job ids, cost, and token totals in GitHub text only", () => {
    const text = "load1=3.2 on job=1234; spent $12.40 over 1.2B tokens";
    expect(rules(text, "github-text").toSorted()).toEqual([
      "operational-telemetry public:cost-total",
      "operational-telemetry public:host-load",
      "operational-telemetry public:job-id",
      "operational-telemetry public:token-total",
    ]);
    expect(rules(text, "tree")).toEqual([]);
  });

  it("keeps ordinary PR prose clean", () => {
    const prose = "Fixes #12. Limits output to 500 tokens; adds 3 tests; job queue docs.";
    expect(rules(prose, "github-text")).toEqual([]);
  });
});

describe("commit-identity", () => {
  it("accepts only GitHub noreply authors and noreply trailers", () => {
    expect(checkIdentity("12345+octo-dev@users.noreply.github.com")).toBe(true);
    expect(checkIdentity("octo-dev@users.noreply.github.com")).toBe(false);
    expect(checkIdentity("dev@example.com")).toBe(false);
    expect(checkTrailerEmail("noreply@anthropic.com")).toBe(true);
    expect(checkTrailerEmail("42+bot@users.noreply.github.com")).toBe(true);
    expect(checkTrailerEmail("dev@example.com")).toBe(false);
  });
});
