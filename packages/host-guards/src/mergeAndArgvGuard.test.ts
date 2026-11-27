// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for mergeGuard, ghApiGuard, and argvGuard.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { checkArgvSecrets } from "./argvGuard.ts";
import { redactGuardCommand } from "./commandRedact.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import { decideGh, isManualMergeDrill } from "./mergeGuard.ts";

function runGit(cwd: string, args: ReadonlyArray<string>): void {
  const res = NodeChildProcess.spawnSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function makeFakeGh(root: string): string {
  const binPath = NodePath.join(root, "fake-gh");
  NodeFS.writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "alias" ] && [ "$2" = "list" ]; then
  printf 'm:\\tpr merge -R example-org/demo-app\\n'
  printf 'm1:\\tm2\\n'
  printf 'm2:\\tpr merge -R example-org/demo-app\\n'
  printf 'cyc1:\\tcyc2\\n'
  printf 'cyc2:\\tcyc1\\n'
  printf 'shmerge:\\t!gh pr merge 1\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "not found" >&2
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );
  return binPath;
}

function setupMergeFixture(root: string): {
  readonly config: HostGuardsConfig;
  readonly repoDir: string;
} {
  const bare = NodePath.join(root, "origin.git");
  const repoDir = NodePath.join(root, "repo");
  NodeFS.mkdirSync(bare, { recursive: true });
  NodeFS.mkdirSync(repoDir, { recursive: true });
  runGit(bare, ["init", "--bare", "-b", "main"]);
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["remote", "add", "origin", bare]);
  NodeFS.mkdirSync(NodePath.join(repoDir, "scripts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repoDir, "scripts", "merge-pr.sh"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  NodeFS.writeFileSync(
    NodePath.join(repoDir, ".tree-guard.conf"),
    "ship_repo=example-org/demo-app\nmerge_drill=scripts/merge-pr.sh\n",
    "utf8",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "init"]);
  runGit(repoDir, ["push", "-u", "origin", "main"]);
  runGit(repoDir, ["remote", "set-head", "origin", "main"]);
  runGit(repoDir, ["remote", "set-url", "origin", "https://github.com/example-org/demo-app.git"]);

  const fakeGh = makeFakeGh(root);
  const cfgPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    cfgPath,
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
    config: loadHostConfig({ configPath: cfgPath }),
    repoDir,
  };
}

describe("mergeGuard and ghApiGuard", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks gh pr merge, gh repo sync, gh api REST/GraphQL base writes, aliases, and manual merge drills", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-merge-"));
    tempDirs.push(root);
    const { config, repoDir } = setupMergeFixture(root);

    // gh pr merge on in-scope repo (via -R, PR URL, or unresolvable)
    expect(
      decideGh(["pr", "merge", "-R", "example-org/demo-app", "12"], repoDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGh(["pr", "merge", "https://github.com/example-org/demo-app/pull/12"], repoDir, config)
        .verdict,
    ).toBe("deny");
    expect(decideGh(["pr", "merge"], repoDir, config).verdict).toBe("deny");
    // Out-of-scope PR merge allowed
    expect(
      decideGh(["pr", "merge", "-R", "other-org/other-repo", "5"], repoDir, config).verdict,
    ).toBe("allow");

    // gh repo sync (with and without -b / --branch / -s flags)
    expect(decideGh(["repo", "sync", "example-org/demo-app"], repoDir, config).verdict).toBe(
      "deny",
    );
    expect(
      decideGh(["repo", "sync", "-b", "main", "example-org/demo-app"], repoDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGh(["repo", "sync", "--branch", "main", "example-org/demo-app"], repoDir, config)
        .verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["repo", "sync", "--branch=main", "-s", "other/fork", "example-org/demo-app"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(["repo", "sync", "--branch", "main", "other-org/other-repo"], repoDir, config)
        .verdict,
    ).toBe("allow");
    expect(decideGh(["repo", "sync", "other-org/other-repo"], repoDir, config).verdict).toBe(
      "allow",
    );

    // gh api REST writes (path, full URL, template {owner}/{repo})
    expect(
      decideGh(["api", "-X", "PUT", "repos/example-org/demo-app/pulls/12/merge"], repoDir, config)
        .verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "POST", "https://api.github.com/repos/example-org/demo-app/merges"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/{owner}/{repo}/git/refs/heads/main", "-f", "sha=abc"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "DELETE", "repos/example-org/demo-app/branches/main/protection"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "-X",
          "POST",
          "repos/example-org/demo-app/branches/main/rename",
          "-f",
          "new_name=legacy",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PUT", "repos/example-org/demo-app/contents/README.md", "-f", "branch=main"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // Contents write to non-base feature branch allowed, GET allowed
    expect(
      decideGh(
        [
          "api",
          "-X",
          "PUT",
          "repos/example-org/demo-app/contents/README.md",
          "-f",
          "branch=feat/1",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    expect(decideGh(["api", "repos/example-org/demo-app/pulls/12"], repoDir, config).verdict).toBe(
      "allow",
    );

    // GraphQL mutations refused (raw, unicode-escaped JSON --input, unreadable -F @- / @/dev/stdin), read query allowed
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { mergePullRequest(input:{pullRequestId:"1"}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(["api", "graphql", "-f", "query={ viewer { login } }"], repoDir, config).verdict,
    ).toBe("allow");
    expect(decideGh(["api", "graphql", "--input", "-"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["api", "graphql", "-F", "query=@-"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["api", "graphql", "-F", "query=@/dev/stdin"], repoDir, config).verdict).toBe(
      "deny",
    );
    const unicodeInputPath = NodePath.join(root, "gql-unicode.json");
    NodeFS.writeFileSync(
      unicodeInputPath,
      '{"query":"mutation { \\u006dergePullRequest(input:{pullRequestId:\\"1\\"}) { clientMutationId } }"}',
      "utf8",
    );
    expect(decideGh(["api", "graphql", "--input", unicodeInputPath], repoDir, config).verdict).toBe(
      "deny",
    );

    // Alias expansion (1-hop, 2-hop chain, alias cycle, and shell alias refusal)
    expect(decideGh(["m", "12"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["m1", "12"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["cyc1"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["shmerge"], repoDir, config).verdict).toBe("deny");

    // Manual execution of declared merge drill
    expect(isManualMergeDrill(["./scripts/merge-pr.sh", "12"], repoDir, config)).toBe(true);
    expect(isManualMergeDrill(["echo", "hello"], repoDir, config)).toBe(false);
  });

  it("enforces queue-only gh pr create and base-retargeting while allowing gh issue close", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-pr-create-"));
    tempDirs.push(root);
    const { config, repoDir } = setupMergeFixture(root);

    // Direct gh pr create refused in in-scope repo (cwd or -R), allowed out-of-scope
    expect(
      decideGh(["pr", "create", "--title", "Feat", "--body", "Details"], repoDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["pr", "create", "-R", "example-org/demo-app", "-t", "Feat", "-b", "Details"],
        root,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["pr", "create", "-R", "other-org/other-repo", "-t", "Feat", "-b", "x"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");

    // gh pr edit retargeting to base branch refused; retargeting to feature branch or editing body allowed
    expect(decideGh(["pr", "edit", "12", "-B", "main"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["pr", "edit", "12", "--base=main"], repoDir, config).verdict).toBe("deny");
    expect(decideGh(["pr", "edit", "12", "-Brefs/heads/main"], repoDir, config).verdict).toBe(
      "deny",
    );
    expect(
      decideGh(
        ["pr", "edit", "https://github.com/example-org/demo-app/pull/12", "--base", "main"],
        root,
        config,
      ).verdict,
    ).toBe("deny");
    expect(decideGh(["pr", "edit", "12", "--base", "feat/parent"], repoDir, config).verdict).toBe(
      "allow",
    );
    expect(
      decideGh(
        ["pr", "edit", "12", "--title", "Updated", "--body", "Better notes"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGh(
        ["pr", "edit", "12", "-R", "other-org/other-repo", "--base", "main"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");

    // REST PATCH repos/{owner}/{repo}/pulls/{n} modifying base to a base branch refused
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "-f", "base=main"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/{owner}/{repo}/pulls/12", "-f", "base=refs/heads/main"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    const patchBaseJson = NodePath.join(root, "patch-base.json");
    NodeFS.writeFileSync(patchBaseJson, JSON.stringify({ base: "main", title: "x" }), "utf8");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "--input", patchBaseJson],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "--input", "-"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // REST PATCH modifying only body or non-base branch allowed
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "-f", "base=feat/parent"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "-f", "body=Updated body"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");

    // GraphQL updatePullRequest modifying baseRefName to a base branch refused (inline, variable, JSON input)
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { updatePullRequest(input:{pullRequestId:"1", baseRefName:"main"}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation($b: String!) { updatePullRequest(input:{pullRequestId:"1", baseRefName:$b}) { clientMutationId } }',
          "-f",
          "b=main",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    const gqlVarJson = NodePath.join(root, "gql-retarget.json");
    NodeFS.writeFileSync(
      gqlVarJson,
      JSON.stringify({
        query:
          "mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }",
        variables: { input: { pullRequestId: "1", baseRefName: "main" } },
      }),
      "utf8",
    );
    expect(decideGh(["api", "graphql", "--input", gqlVarJson], repoDir, config).verdict).toBe(
      "deny",
    );
    // GraphQL updatePullRequest targeting a non-base branch or editing body/title allowed
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { updatePullRequest(input:{pullRequestId:"1", baseRefName:"feat/parent"}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    // B4 regressions: G1 (nested x[b] + variable default), G2 (comma before colon + safe alias),
    // G3 (comment before colon + unused zz[baseRefName]), G11 (comment before colon + safe alias)
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation($b:String="main"){updatePullRequest(input:{pullRequestId:"1",baseRefName:$b}){clientMutationId}}',
          "-f",
          "x[b]=feature",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation{a:updatePullRequest(input:{pullRequestId:"1",baseRefName:"feature"}){clientMutationId} b:updatePullRequest(input:{pullRequestId:"1",baseRefName,:"main"}){clientMutationId}}',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation{updatePullRequest(input:{pullRequestId:"1",baseRefName#c\n:"main"}){clientMutationId}}',
          "-f",
          "zz[baseRefName]=feature",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation{a:updatePullRequest(input:{pullRequestId:"1",baseRefName:"feature"}){clientMutationId} b:updatePullRequest(input:{pullRequestId:"1",baseRefName#c\n:"main"}){clientMutationId}}',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // {branch} placeholder bypass regressions (GraphQL -F variable, GraphQL nested input, REST PATCH pull base, REST git/refs)
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation($b:String!){updatePullRequest(input:{pullRequestId:"1",baseRefName:$b}){clientMutationId}}',
          "-F",
          "b={branch}",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($in:UpdatePullRequestInput!){updatePullRequest(input:$in){clientMutationId}}",
          "-F",
          "in[pullRequestId]=1",
          "-F",
          "in[baseRefName]={branch}",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/12", "-F", "base={branch}"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/{owner}/{repo}/git/refs/heads/{branch}", "-f", "sha=abc"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // Safe response selection of baseRefName without setting input.baseRefName is allowed
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation{updatePullRequest(input:{pullRequestId:"1",title:"hi"}){pullRequest{baseRefName}}}',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { updatePullRequest(input:{pullRequestId:"1", title:"New title"}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");

    // Explicitly do NOT block gh issue close or REST issue state closing
    expect(decideGh(["issue", "close", "42"], repoDir, config).verdict).toBe("allow");
    expect(
      decideGh(
        ["issue", "close", "-R", "example-org/demo-app", "42", "-r", "completed"],
        root,
        config,
      ).verdict,
    ).toBe("allow");
    expect(
      decideGh(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/issues/42", "-f", "state=closed"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
  });

  it("blocks B1-B7 bypasses: pr new, REST POST pulls, GraphQL createPullRequest/escapes/nested fields, and GH_REPO fallback", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-b1-b7-"));
    tempDirs.push(root);
    const { config, repoDir } = setupMergeFixture(root);

    // B1: gh pr new treated identically to gh pr create
    expect(
      decideGh(["pr", "new", "--title", "Feat", "--body", "Details"], repoDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGh(["pr", "new", "-R", "example-org/demo-app", "-t", "Feat"], root, config).verdict,
    ).toBe("deny");
    expect(
      decideGh(["pr", "new", "-R", "other-org/other-repo", "-t", "Feat"], repoDir, config).verdict,
    ).toBe("allow");

    // B2: REST POST repos/<in-scope>/pulls denied when !queued, allowed out-of-scope
    expect(
      decideGh(
        [
          "api",
          "-X",
          "POST",
          "repos/example-org/demo-app/pulls",
          "-f",
          "title=Direct",
          "-f",
          "head=feat/x",
          "-f",
          "base=main",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "repos/example-org/demo-app/pulls", "-f", "title=ImplicitPost"],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "POST", "repos/other-org/other-repo/pulls", "-f", "title=Ok"],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");

    // B3: GraphQL createPullRequest denied (inline and unicode-escaped JSON input)
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { createPullRequest(input:{repositoryId:"R1",baseRefName:"main",headRefName:"feat",title:"x"}) { pullRequest { id } } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    const createPrJson = NodePath.join(root, "gql-create-pr.json");
    NodeFS.writeFileSync(
      createPrJson,
      '{"query":"mutation { \\u0063reatePullRequest(input:{repositoryId:\\"R1\\"}) { clientMutationId } }"}',
      "utf8",
    );
    expect(decideGh(["api", "graphql", "--input", createPrJson], repoDir, config).verdict).toBe(
      "deny",
    );

    // B4-B5: Fail-closed GraphQL updatePullRequest touching baseRefName
    // Nested field syntax (-F / -f input[baseRefName]=...)
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }",
          "-F",
          "input[baseRefName]=main",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }",
          "-f",
          "input[baseRefName]=main",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }",
          "-f",
          "input[baseRefName]=feat/parent",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("allow");
    // GraphQL unicode escape inside string literal
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { updatePullRequest(input:{pullRequestId:"1", baseRefName:"\\u006dain"}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // GraphQL block string
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { updatePullRequest(input:{pullRequestId:"1", baseRefName:"""main"""}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    // Unresolved variable & unreadable @-
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          'query=mutation($b: String!) { updatePullRequest(input:{pullRequestId:"1", baseRefName:$b}) { clientMutationId } }',
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { clientMutationId } }",
          "-F",
          "input[baseRefName]=@-",
        ],
        repoDir,
        config,
      ).verdict,
    ).toBe("deny");

    // B6-B7: GH_REPO env fallback from out-of-scope cwd (and explicit -R precedence)
    const ghRepoEnv = { GH_REPO: "example-org/demo-app" };
    expect(
      decideGh(["pr", "create", "-t", "From env", "-b", "Body"], root, config, { env: ghRepoEnv })
        .verdict,
    ).toBe("deny");
    expect(
      decideGh(["pr", "new", "-t", "From env", "-b", "Body"], root, config, { env: ghRepoEnv })
        .verdict,
    ).toBe("deny");
    expect(
      decideGh(["pr", "edit", "3", "-B", "main"], root, config, { env: ghRepoEnv }).verdict,
    ).toBe("deny");
    expect(
      decideGh(
        ["api", "-X", "POST", "repos/{owner}/{repo}/pulls", "-f", "title=EnvPull"],
        root,
        config,
        { env: ghRepoEnv },
      ).verdict,
    ).toBe("deny");
    // Explicit -R takes precedence over GH_REPO
    expect(
      decideGh(
        ["pr", "create", "-R", "other-org/other-repo", "-t", "Other", "-b", "Body"],
        root,
        config,
        { env: ghRepoEnv },
      ).verdict,
    ).toBe("allow");
  });
});

describe("argvGuard command-line secret detection and redaction", () => {
  it("refuses and redacts credentials in curl, wget, httpie, and fly ssh", () => {
    const authHdr = checkArgvSecrets([
      "curl",
      "-H",
      "Authorization: Bearer super-secret-token",
      "https://api.example.com/v1",
    ]);
    expect(authHdr.verdict).toBe("deny");
    expect(authHdr.redactedCommand.join(" ")).not.toContain("super-secret-token");

    const userPass = checkArgvSecrets(["curl", "-u", "alice:s3cr3t", "https://api.example.com"]);
    expect(userPass.verdict).toBe("deny");
    expect(userPass.redactedCommand.join(" ")).not.toContain("s3cr3t");

    const urlCreds = checkArgvSecrets(["wget", "https://bob:pass123@example.com/file"]);
    expect(urlCreds.verdict).toBe("deny");
    expect(urlCreds.redactedCommand.join(" ")).not.toContain("pass123");

    const querySecret = checkArgvSecrets(["http", "https://api.example.com/data?api_key=tok999"]);
    expect(querySecret.verdict).toBe("deny");
    expect(querySecret.redactedCommand.join(" ")).not.toContain("tok999");

    const flyRemote = checkArgvSecrets([
      "fly",
      "ssh",
      "console",
      "-a",
      "example-api",
      "-C",
      "API_TOKEN=secretval node check.js",
    ]);
    expect(flyRemote.verdict).toBe("deny");
    expect(flyRemote.redactedCommand.join(" ")).not.toContain("secretval");

    const flyTok = checkArgvSecrets(["flyctl", "ssh", "console", "-t", "fo1_secret"]);
    expect(flyTok.verdict).toBe("deny");
    expect(flyTok.redactedCommand.join(" ")).not.toContain("fo1_secret");

    // Safe invocations pass
    expect(
      checkArgvSecrets(["curl", "-H", "@headers.txt", "https://api.example.com"]).verdict,
    ).toBe("allow");
    expect(checkArgvSecrets(["curl", "-u", "alice", "https://api.example.com"]).verdict).toBe(
      "allow",
    );
    expect(
      checkArgvSecrets(["fly", "ssh", "console", "-a", "example-api", "-C", "ls -la"]).verdict,
    ).toBe("allow");
  });

  it("redacts secrets across env assignments, git extraHeader, gh secret, npm _authToken, docker login, and mysql", () => {
    const cases: ReadonlyArray<{
      readonly argv: ReadonlyArray<string>;
      readonly secret: string;
    }> = [
      {
        argv: ["env", "AWS_SECRET_ACCESS_KEY=akia_supersecret", "cmd"],
        secret: "akia_supersecret",
      },
      { argv: ["env", "STRIPE_SECRET_KEY=sk_live_99999", "cmd"], secret: "sk_live_99999" },
      {
        argv: ["git", "-c", "http.extraHeader=Authorization: Basic dXNlcjpwYXNz", "push"],
        secret: "dXNlcjpwYXNz",
      },
      {
        argv: ["git", "-chttp.https://example.com.extraHeader=Bearer tok123", "push"],
        secret: "tok123",
      },
      {
        argv: ["gh", "secret", "set", "MY_SECRET", "--body", "gh_secret_val"],
        secret: "gh_secret_val",
      },
      {
        argv: ["gh", "secret", "set", "MY_SECRET", "-b", "gh_short_val"],
        secret: "gh_short_val",
      },
      {
        argv: ["gh", "secret", "set", "MY_SECRET", "-bgh_attached_val"],
        secret: "gh_attached_val",
      },
      {
        argv: ["npm", "publish", "--//registry.npmjs.org/:_authToken=npm_tok_abc"],
        secret: "npm_tok_abc",
      },
      {
        argv: ["npm", "config", "set", "//registry.npmjs.org/:_authToken", "npm_tok_def"],
        secret: "npm_tok_def",
      },
      {
        argv: ["docker", "login", "-u", "bot", "-p", "dock_pass_123", "ghcr.io"],
        secret: "dock_pass_123",
      },
      {
        argv: ["docker", "login", "-u", "bot", "-pdock_pass_456", "ghcr.io"],
        secret: "dock_pass_456",
      },
      {
        argv: ["mysql", "-u", "root", "-pmysql_pass_789", "appdb"],
        secret: "mysql_pass_789",
      },
    ];
    for (const tc of cases) {
      const redacted = redactGuardCommand(tc.argv).join(" ");
      expect(redacted).not.toContain(tc.secret);
    }

    // Non-secret flags like --author remain intact
    expect(redactGuardCommand(["git", "commit", "--author=alice", "-m", "hello"])).toEqual([
      "git",
      "commit",
      "--author=alice",
      "-m",
      "hello",
    ]);
  });
});
