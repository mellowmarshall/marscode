// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for the gh text guard and visibility-aware stamping through the CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runHostGuardCli } from "./cli.ts";
import { decideGhText } from "./ghTextGuard.ts";
import { REFUSED_EXIT_CODE } from "./hook.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";

const THREAD = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const SESSION = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const REPO = "example-org/demo-app";
const BANNED_PATH = "/data/Dev/widget-lab";
const BANNED_HOST = "widget-box-9";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly config: HostGuardsConfig;
  readonly configPath: string;
  readonly fakeGh: string;
  readonly recordPath: string;
  readonly probesPath: string;
  readonly env: (visibility: string, extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

function makeFixture(options: { readonly denylist?: boolean } = {}): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-text-"));
  roots.push(root);
  const recordPath = NodePath.join(root, "gh-record.json");
  const probesPath = NodePath.join(root, "gh-probes.log");
  const fakeGh = NodePath.join(root, "fake-gh");
  NodeFS.writeFileSync(
    fakeGh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api" && args.includes(".visibility")) {
  fs.appendFileSync(${JSON.stringify(probesPath)}, args[1] + "\\n");
  const map = JSON.parse(process.env.FAKE_GH_VISIBILITY_MAP || "{}");
  const slug = args[1].replace(/^repos\\//, "");
  process.stdout.write((map[slug] ?? (process.env.FAKE_GH_VISIBILITY || "")) + "\\n");
  process.exit(0);
}
const record = { args, files: {} };
for (let i = 0; i < args.length; i += 1) {
  if ((args[i] === "-F" || args[i] === "--body-file") && fs.existsSync(args[i + 1] || "")) {
    record.files[args[i + 1]] = fs.readFileSync(args[i + 1], "utf8");
  }
}
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record), "utf8");
`,
    { mode: 0o755 },
  );
  const denylistPath = NodePath.join(root, "public-hygiene.denylist");
  if (options.denylist !== false) {
    NodeFS.writeFileSync(denylistPath, "@class host-names\nwidget-box-[0-9]+\n", { mode: 0o600 });
  }
  const configPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(root, "src"),
      dataRoot: NodePath.join(root, "data"),
      stateDir: NodePath.join(root, "state"),
      realGit: "/usr/bin/git",
      realGh: fakeGh,
    }),
    "utf8",
  );
  return {
    root,
    config: loadHostConfig({ configPath }),
    configPath,
    fakeGh,
    recordPath,
    probesPath,
    env: (visibility, extra = {}) => ({
      HOME: root,
      PATH: "/usr/bin:/bin",
      MARSCODE_HYGIENE_DENYLIST: denylistPath,
      FAKE_GH_VISIBILITY: visibility,
      ...extra,
    }),
  };
}

const comment = (body: string, repo = REPO) => [
  "issue",
  "comment",
  "1",
  "-R",
  repo,
  "--body",
  body,
];

describe("gh text guard", () => {
  it("denies public text with findings by class id and line, never the matched text", () => {
    const fx = makeFixture();
    const verdict = decideGhText(
      comment(`Intro\nSee ${BANNED_PATH}\nOn ${BANNED_HOST}`),
      fx.root,
      fx.config,
      { env: fx.env("public") },
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("data-layout body:2 (public:data-dev-root)");
    expect(verdict.reason).toContain("host-names body:3 (private:host-names)");
    expect(verdict.reason).toContain("Rewrite the text with neutral placeholders (PLAYBOOK §16).");
    expect(verdict.reason).not.toMatch(/widget/);
  });

  it("allows clean public text, any private text, and asks gh for visibility once per cache window", () => {
    const fx = makeFixture();
    const options = { env: fx.env("public") };
    expect(decideGhText(comment("A neutral note."), fx.root, fx.config, options).verdict).toBe(
      "allow",
    );
    expect(decideGhText(comment("Another note."), fx.root, fx.config, options).verdict).toBe(
      "allow",
    );
    expect(NodeFS.readFileSync(fx.probesPath, "utf8")).toBe(`repos/${REPO}\n`);
    const privateRepo = "example-org/private-app";
    expect(
      decideGhText(comment(`See ${BANNED_PATH}`, privateRepo), fx.root, fx.config, {
        env: fx.env("private"),
      }).verdict,
    ).toBe("allow");
  });

  it("scans unknown visibility as public and refuses without the denylist, naming its path", () => {
    const fx = makeFixture({ denylist: false });
    const verdict = decideGhText(comment("A neutral note."), fx.root, fx.config, {
      env: fx.env("not-a-visibility"),
    });
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("unknown visibility");
    expect(verdict.reason).toContain("~/public-hygiene.denylist is missing");
  });

  it("scans titles, body files, stdin, release notes, and gh api title/body fields and --input", () => {
    const fx = makeFixture();
    const options = { env: fx.env("public"), readStdin: () => `stdin ${BANNED_PATH}` };
    const file = NodePath.join(fx.root, "body.md");
    NodeFS.writeFileSync(file, `ok\n${BANNED_PATH}\n`);
    const input = NodePath.join(fx.root, "payload.json");
    NodeFS.writeFileSync(input, JSON.stringify({ title: "t", body: `x ${BANNED_HOST}` }));
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["pr", "create", "-R", REPO, "-t", `Fix ${BANNED_PATH}`, "-b", "ok"], "title:1"],
      [["issue", "create", "-R", REPO, "-t", "ok", "--body-file", file], "body-file:2"],
      [["pr", "review", "1", "-R", REPO, "--approve", "-F", "-"], "body-file:1"],
      [["release", "create", "v1", "-R", REPO, "--notes", BANNED_PATH], "notes:1"],
      [["api", `repos/${REPO}/issues`, "-f", `body=${BANNED_PATH}`], "field.body:1"],
      [["api", "-X", "PATCH", `repos/${REPO}/issues/1`, "-F", `title=@${file}`], "field.title:2"],
      [["api", `repos/${REPO}/issues/1/comments`, "--input", input], "input.body:1"],
    ];
    for (const [args, where] of cases) {
      const verdict = decideGhText(args, fx.root, fx.config, options);
      expect(verdict.verdict, args.join(" ")).toBe("deny");
      expect(verdict.reason).toContain(where);
    }
    expect(decideGhText(["api", `repos/${REPO}/issues`], fx.root, fx.config, options).verdict).toBe(
      "allow",
    );
    expect(
      decideGhText(["issue", "view", "1", "-R", REPO], fx.root, fx.config, options).verdict,
    ).toBe("allow");
  });

  it("denies every reviewer-proven bypass on a public or unknown target", () => {
    const fx = makeFixture();
    const options = { env: fx.env("public") };
    const notes = NodePath.join(fx.root, "notes.md");
    NodeFS.writeFileSync(notes, `ok\n${BANNED_PATH}\n`);
    const nested = NodePath.join(fx.root, "nested.json");
    NodeFS.writeFileSync(
      nested,
      JSON.stringify({
        query: "mutation($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }",
        variables: { i: { subjectId: "I_1", body: BANNED_PATH } },
      }),
    );
    const b64 = Buffer.from(`# Notes\n${BANNED_PATH}\n`).toString("base64");
    const mutation = `query=mutation { addComment(input: {subjectId: "I_1", body: "${BANNED_PATH}"}) { clientMutationId } }`;
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["api", "graphql", "-f", mutation], "field.query:1"],
      [
        ["api", "graphql", "-f", "query=mutation($b: String!) { x }", "-f", `b=${BANNED_PATH}`],
        "field.b:1",
      ],
      [["api", "graphql", "--input", nested], "input.variables.i.body:1"],
      [
        ["api", "gists", "-f", `files[a.md][content]=${BANNED_PATH}`],
        "field.files[a.md][content]:1",
      ],
      [
        [
          "api",
          "-X",
          "PUT",
          `repos/${REPO}/contents/a.md`,
          "-f",
          "message=add",
          "-f",
          `content=${b64}`,
        ],
        "field.content(base64):2",
      ],
      [
        ["api", "-X", "PATCH", `repos/${REPO}/labels/x`, "-f", `description=${BANNED_PATH}`],
        "field.description:1",
      ],
      [["pr", "merge", "1", "-R", REPO, "--squash", "--body", BANNED_PATH], "body:1"],
      [["pr", "merge", "1", "-R", REPO, "--subject", `Fix ${BANNED_HOST}`], "subject:1"],
      [["repo", "edit", REPO, "--description", BANNED_PATH], "description:1"],
      [["label", "create", "bug", "-R", REPO, "-d", BANNED_PATH], "desc:1"],
      [["gist", "create", "-d", BANNED_PATH], "desc:1"],
      [["gist", "create", notes], "file:2"],
      [["release", "create", "v1", "-R", REPO, "--notes-file", notes], "notes-file:2"],
      [["issue", "create", "-R", REPO, "-t", "ok", `-F${notes}`], "body-file:2"],
      [["issue", "comment", "1", "-R", REPO, `-b${BANNED_PATH}`], "body:1"],
      [["agent-task", "create", "-R", REPO, `Fix ${BANNED_PATH}`], "arg:1"],
    ];
    for (const [args, where] of cases) {
      const verdict = decideGhText(args, fx.root, fx.config, options);
      expect(verdict.verdict, args.join(" ")).toBe("deny");
      expect(verdict.reason, args.join(" ")).toContain(where);
      expect(verdict.reason).not.toMatch(/widget/);
    }
  });

  it("refuses text the guard cannot read and editor mode, but allows --web", () => {
    const fx = makeFixture();
    const options = { env: fx.env("public") };
    const fifo = NodePath.join(fx.root, "body.fifo");
    NodeChildProcess.execFileSync("mkfifo", [fifo]);
    const big = NodePath.join(fx.root, "big.md");
    NodeFS.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const refused: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["issue", "create", "-R", REPO, "-t", "ok", "--body-file", fifo], "cannot read"],
      [["issue", "create", "-R", REPO, "-t", "ok", "--body-file", big], "cannot read"],
      [
        ["issue", "create", "-R", REPO, "-t", "ok", "-F", NodePath.join(fx.root, "nope.md")],
        "cannot read",
      ],
      [["pr", "comment", "1", "-R", REPO, "--body-file", "-"], "cannot read body-file (stdin)"],
      [["api", "graphql", "-F", "query=@-"], "cannot read field.query (stdin)"],
      [["api", "graphql", "--input", fifo], "cannot read input"],
      [["issue", "create", "-R", REPO, "-t", "ok", "-e"], "editor mode"],
      [["pr", "comment", "1", "-R", REPO, "--editor"], "editor mode"],
      [["gist", "edit", "abc123"], "editor mode"],
    ];
    for (const [args, why] of refused) {
      const verdict = decideGhText(args, fx.root, fx.config, options);
      expect(verdict.verdict, args.join(" ")).toBe("deny");
      expect(verdict.reason, args.join(" ")).toContain(why);
    }
    const allowed: ReadonlyArray<ReadonlyArray<string>> = [
      ["issue", "create", "-R", REPO, "-t", "ok", "--web"],
      ["pr", "merge", "1", "-R", REPO, "--squash", "--delete-branch"],
      ["pr", "merge", "1", "-R", REPO, "--body", "Neutral summary."],
      [
        "api",
        "graphql",
        "-f",
        'query=mutation { addComment(input: {body: "neutral"}) { clientMutationId } }',
      ],
      ["repo", "view", "example-org/private-app"],
    ];
    for (const args of allowed) {
      expect(decideGhText(args, fx.root, fx.config, options).verdict, args.join(" ")).toBe("allow");
    }
    const privateOptions = { env: fx.env("private") };
    for (const args of [
      ["pr", "merge", "1", "-R", "example-org/private-app", "--body", BANNED_PATH],
      ["repo", "edit", "example-org/private-app", "--description", BANNED_PATH],
      ["issue", "create", "-R", "example-org/private-app", "-t", "ok", "-e"],
    ]) {
      expect(decideGhText(args, fx.root, fx.config, privateOptions).verdict, args.join(" ")).toBe(
        "allow",
      );
    }
  });

  it("treats a call as public when any candidate target is public", () => {
    const fx = makeFixture();
    const map = JSON.stringify({
      "example-org/pub": "public",
      "example-org/private-app": "private",
    });
    const options = {
      env: fx.env("", { FAKE_GH_VISIBILITY_MAP: map, GH_REPO: "example-org/private-app" }),
    };
    const denied: ReadonlyArray<ReadonlyArray<string>> = [
      ["repo", "edit", "--description", BANNED_PATH, "example-org/pub"],
      ["repo", "create", "--public", "-d", BANNED_PATH, "example-org/newpub"],
      [
        "pr",
        "comment",
        "https://github.com/example-org/pub/pull/1",
        "-R",
        "example-org/private-app",
        "-b",
        BANNED_PATH,
      ],
    ];
    for (const args of denied) {
      const verdict = decideGhText(args, fx.root, fx.config, options);
      expect(verdict.verdict, args.join(" ")).toBe("deny");
      expect(verdict.reason).not.toContain("private-app");
    }
    for (const args of [
      ["repo", "edit", "example-org/private-app", "--description", BANNED_PATH],
      ["repo", "create", "--private", "-d", BANNED_PATH, "example-org/newpriv"],
      ["pr", "comment", "1", "-b", BANNED_PATH],
    ]) {
      expect(decideGhText(args, fx.root, fx.config, options).verdict, args.join(" ")).toBe("allow");
    }
  });

  it("scans base64 under any key and positional files by contents and basename only", () => {
    const fx = makeFixture();
    const options = { env: fx.env("public") };
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const commit = NodePath.join(fx.root, "commit.json");
    NodeFS.writeFileSync(
      commit,
      JSON.stringify({
        query:
          "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
        variables: {
          i: {
            fileChanges: { additions: [{ path: "a.md", contents: b64(`# A\n${BANNED_PATH}\n`) }] },
          },
        },
      }),
    );
    const banned = NodePath.join(fx.root, "notes.txt");
    NodeFS.writeFileSync(banned, `ok\n${BANNED_PATH}\n`);
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [
        ["api", "graphql", "--input", commit],
        "input.variables.i.fileChanges.additions.0.contents(base64):2",
      ],
      [
        [
          "api",
          "graphql",
          "-f",
          "query=mutation { x }",
          "-f",
          `c=${b64(`see ${BANNED_PATH} now`).replace(/=+$/, "")}`,
        ],
        "field.c(base64):1",
      ],
      [["gist", "edit", "abc123", "-d", "x", banned], "file:2"],
      [["release", "upload", "v1", "-R", REPO, banned], "file:2"],
    ];
    for (const [args, where] of cases) {
      const verdict = decideGhText(args, fx.root, fx.config, options);
      expect(verdict.verdict, args.join(" ")).toBe("deny");
      expect(verdict.reason, args.join(" ")).toContain(where);
    }
    const distDir = NodePath.join(fx.root, "data", "Dev", "widget-lab");
    NodeFS.mkdirSync(distDir, { recursive: true });
    const dist = NodePath.join(distDir, "dist.tgz");
    NodeFS.writeFileSync(dist, "clean archive bytes");
    expect(
      decideGhText(["release", "create", "v1", "-R", REPO, dist], fx.root, fx.config, options)
        .verdict,
    ).toBe("allow");
    const bigBinary = NodePath.join(distDir, "app.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x41);
    bytes.write(`see ${BANNED_PATH}`, 4096);
    bytes[16] = 0;
    NodeFS.writeFileSync(bigBinary, bytes);
    expect(
      decideGhText(["release", "upload", "v1", "-R", REPO, bigBinary], fx.root, fx.config, options)
        .verdict,
    ).toBe("deny");
    const cleanBinary = NodePath.join(distDir, "clean.bin");
    const clean = Buffer.alloc(2 * 1024 * 1024, 0x41);
    clean[16] = 0;
    NodeFS.writeFileSync(cleanBinary, clean);
    expect(
      decideGhText(
        ["release", "upload", "v1", "-R", REPO, cleanBinary],
        fx.root,
        fx.config,
        options,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGhText(["gist", "create", "--public", cleanBinary], fx.root, fx.config, options)
        .verdict,
    ).toBe("deny");
    const realPath = NodePath.join(fx.root, BANNED_HOST, "x");
    NodeFS.mkdirSync(NodePath.dirname(realPath), { recursive: true });
    NodeFS.writeFileSync(realPath, "clean");
    expect(
      decideGhText(
        ["issue", "create", "-R", REPO, "--title", realPath, "--body", "ok"],
        fx.root,
        fx.config,
        options,
      ).verdict,
    ).toBe("deny");
    const privateOnly = { env: fx.env("private") };
    expect(
      decideGhText(
        [
          "gist",
          "create",
          "--public",
          "-d",
          `see https://github.com/example-org/secret ${BANNED_HOST}`,
        ],
        fx.root,
        fx.config,
        privateOnly,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGhText(
        ["release", "upload", "v1", "-R", REPO, "--clobber", cleanBinary],
        fx.root,
        fx.config,
        options,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGhText(
        ["gist", "create", "--public", "-d", BANNED_HOST],
        fx.root,
        fx.config,
        privateOnly,
      ).verdict,
    ).toBe("deny");
    const bigText = NodePath.join(distDir, "notes.txt");
    NodeFS.writeFileSync(bigText, "a".repeat(2 * 1024 * 1024));
    expect(
      decideGhText(["release", "upload", "v1", "-R", REPO, bigText], fx.root, fx.config, options)
        .verdict,
    ).toBe("deny");
    expect(
      decideGhText(
        ["release", "create", "v1", "-R", REPO, BANNED_PATH],
        fx.root,
        fx.config,
        options,
      ).verdict,
    ).toBe("deny");
  });

  it("reports the text-guard capability", async () => {
    const out: string[] = [];
    const code = await runHostGuardCli(["capabilities"], {
      cwd: process.cwd(),
      env: {},
      out: (text) => out.push(text),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n").split("\n")).toContain("text-guard");
  });

  it("refuses a banned public comment through the PreToolUse hook and allows a clean one", async () => {
    const fx = makeFixture();
    const hook = async (command: string, visibility: string) => {
      const errors: string[] = [];
      const code = await runHostGuardCli(["hook"], {
        cwd: fx.root,
        env: fx.env(visibility),
        stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: fx.root }),
        configPath: fx.configPath,
        socketPath: "",
        testMode: true,
        out: () => {},
        err: (text) => errors.push(text),
      });
      return { code, errors: errors.join("\n") };
    };
    const banned = await hook(
      `gh issue comment 1 -R ${REPO} --body "see ${BANNED_PATH}"`,
      "public",
    );
    expect(banned.code).toBe(REFUSED_EXIT_CODE);
    expect(banned.errors).toContain("data-layout body:1");
    expect(banned.errors).not.toMatch(/widget/);
    expect((await hook(`gh issue comment 1 -R ${REPO} --body "neutral"`, "public")).code).toBe(0);
    const graphql = await hook(
      `gh api graphql -f query='mutation { addComment(input: {subjectId: "I_1", body: "${BANNED_PATH}"}) { clientMutationId } }'`,
      "public",
    );
    expect(graphql.code).toBe(REFUSED_EXIT_CODE);
    expect(graphql.errors).toContain("field.query:1");
    expect((await hook(`gh pr comment 1 -R ${REPO} --body-file -`, "public")).code).toBe(
      REFUSED_EXIT_CODE,
    );
    for (const forge of [
      `glab mr create -t ok -d "${BANNED_PATH}"`,
      `tea issues create --description "${BANNED_PATH}"`,
    ]) {
      const res = await hook(forge, "public");
      expect(res.code, forge).toBe(REFUSED_EXIT_CODE);
      expect(res.errors).not.toMatch(/widget/);
    }
    expect((await hook(`glab mr create -t ok -d "neutral"`, "public")).code).toBe(0);
  });

  it("gh-run stamps the neutral form on a public repo and the titled form on a private one", async () => {
    const agentEnv = {
      CLAUDECODE: "1",
      CLAUDE_SESSION_ID: SESSION,
      T3CODE_THREAD_ID: THREAD,
      MARSCODE_AGENT_NAME: "Fix Login Bug",
    };
    const run = async (visibility: string) => {
      const fx = makeFixture();
      const code = await runHostGuardCli(
        ["gh-run", "--real-gh", fx.fakeGh, "--", ...comment("Done.")],
        {
          cwd: fx.root,
          env: fx.env(visibility, agentEnv),
          configPath: fx.configPath,
          socketPath: "",
          allowEnvThreadId: true,
          testMode: true,
          out: () => {},
          err: () => {},
        },
      );
      expect(code).toBe(0);
      const recorded = JSON.parse(NodeFS.readFileSync(fx.recordPath, "utf8")) as {
        args: string[];
      };
      return recorded.args.at(-1)!;
    };
    const neutral = await run("public");
    expect(neutral).toBe(
      [
        "Done.",
        "",
        `Co-authored-by: MarsCode Agent <${THREAD}@agents.local>`,
        `Agent Session: ${SESSION}`,
        `Agent Thread: ${THREAD}`,
      ].join("\n"),
    );
    expect(await run("")).toBe(neutral);
    const titled = await run("private");
    expect(titled).toContain("Fix Login Bug");
    expect(titled).toContain(`Agent Thread: ${THREAD}`);
  });
});
