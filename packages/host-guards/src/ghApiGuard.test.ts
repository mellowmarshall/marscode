// @effect-diagnostics nodeBuiltinImport:off - Direct tests for ghApiGuard {branch} placeholder refusals.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideGhApiCall } from "./ghApiGuard.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import { decideGh } from "./mergeGuard.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function makeConfig(): { readonly config: HostGuardsConfig; readonly cwd: string } {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-ghapi-"));
  tempDirs.push(root);
  const cwd = NodePath.join(root, "work");
  NodeFS.mkdirSync(cwd);
  const configPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(root, "src"),
      dataRoot: NodePath.join(root, "data"),
      stateDir: NodePath.join(root, "state"),
      realGit: "/usr/bin/git",
      realGh: "/usr/bin/gh",
    }),
    "utf8",
  );
  return { config: loadHostConfig({ configPath }), cwd };
}

function verdict(args: ReadonlyArray<string>, queued = false): string {
  const { config, cwd } = makeConfig();
  return decideGhApiCall(["api", ...args], cwd, config, queued, {}).verdict;
}

function expectAll(cases: ReadonlyArray<ReadonlyArray<string>>, want: string, queued = false) {
  for (const args of cases) expect(verdict(args, queued), args.join(" ")).toBe(want);
}

describe("ghApiGuard {branch} placeholders", () => {
  it("blocks {branch} in branches/{branch}/protection", () => {
    expect(verdict(["-X", "PUT", "repos/example-org/demo-app/branches/{branch}/protection"])).toBe(
      "deny",
    );
    expect(
      verdict([
        "-X",
        "DELETE",
        "repos/example-org/demo-app/branches/{branch}/protection/required_status_checks",
      ]),
    ).toBe("deny");
    // Branch protection is repo administration, so even a feature branch needs the owner.
    expect(verdict(["-X", "PUT", "repos/example-org/demo-app/branches/feat-x/protection"])).toBe(
      "deny",
    );
  });

  it("blocks a {branch} placeholder in the contents/ branch field", () => {
    const put = ["-X", "PUT", "repos/example-org/demo-app/contents/README.md"];
    expect(verdict([...put, "-f", "branch={branch}", "-f", "message=m"])).toBe("deny");
    expect(verdict([...put, "-F", "branch={branch}"])).toBe("deny");
    expect(
      verdict([
        "-X",
        "DELETE",
        "repos/example-org/demo-app/contents/README.md",
        "-f",
        "branch={branch}",
      ]),
    ).toBe("deny");
    // Contents writes are not an everyday write, so they need the owner on any branch.
    expect(verdict([...put, "-f", "branch=feat/x", "-f", "message=m"])).toBe("deny");
  });
});

const REPO = "repos/example-org/demo-app";

describe("ghApiGuard parses flags the way gh does", () => {
  it("reads every short flag of a bundle, so -iXDELETE is a DELETE", () => {
    expectAll(
      [
        ["-iXDELETE", REPO],
        ["-iX", "DELETE", REPO],
        ["-iX=DELETE", REPO],
        ["-Xdelete", REPO],
        ["--method=DELETE", REPO],
        ["-iXPUT", `${REPO}/pulls/1/merge`],
        ["-iX", "PUT", `${REPO}/branches/feat-x/protection`],
        ["-iXPATCH", REPO, "-f", "visibility=public"],
        ["-if", "visibility=public", "-XPATCH", REPO],
        // gh has no prefix matching: an unknown flag cannot be read, so it is refused.
        ["--meth", "DELETE", REPO],
        ["-X", "POST", `${REPO}/issues`, "-H", "X-HTTP-Method-Override: DELETE"],
        ["-iZ", REPO],
      ],
      "deny",
    );
    expectAll(
      [
        ["-i", REPO],
        ["-iq", ".name", REPO],
        ["--paginate", "--slurp", REPO],
      ],
      "allow",
    );
  });

  it("applies the allowlist to repositories/<id> paths and nested repo paths", () => {
    expectAll(
      [
        ["-X", "DELETE", "repositories/123"],
        ["-iXDELETE", "repositories/123"],
        ["-X", "PATCH", "repositories/123", "-f", "visibility=public"],
        ["-X", "PUT", "repositories/123/pulls/1/merge"],
        ["-X", "PUT", "repositories/123/branches/feat-x/protection"],
        ["-X", "POST", "repositories/123/pulls", "-f", "base=main"],
        ["-X", "PATCH", "repositories/123/git/refs/heads/main", "-f", "sha=abc"],
        ["-X", "POST", "https://api.github.com/repositories/123/merges"],
        ["-X", "PUT", "user/installations/1/repositories/123"],
        ["-X", "PUT", "teams/1/repos/example-org/demo-app"],
        ["-X", "DELETE", "Repos/example-org/demo-app"],
      ],
      "deny",
    );
    expectAll(
      [
        ["repositories/123"],
        ["-X", "POST", "repositories/123/issues", "-f", "title=t"],
        ["-X", "POST", "repositories/123/issues/4/comments", "-f", "body=b"],
      ],
      "allow",
    );
    // The queue may merge, by id too, and nothing wider.
    expect(verdict(["-X", "PUT", "repositories/123/pulls/1/merge"], true)).toBe("allow");
    expect(verdict(["-X", "DELETE", "repositories/123"], true)).toBe("deny");
  });

  it("reads the ref of POST git/refs from the body: no tags, no base branches", () => {
    const { config, cwd } = makeConfig();
    const input = NodePath.join(cwd, "ref.json");
    NodeFS.writeFileSync(input, JSON.stringify({ ref: "refs/heads/main", sha: "abc" }));
    const create = [`${REPO}/git/refs`, "-f", "sha=abc"];
    expectAll(
      [
        [...create, "-f", "ref=refs/tags/v1.0.0"],
        [...create, "-f", "ref=refs/heads/main"],
        [...create, "-f", "ref=refs/heads/{branch}"],
        [...create, "-f", "ref=main"],
        [...create],
        [...create, "-F", "ref=@-"],
        ["-X", "POST", "repositories/123/git/refs", "-f", "ref=refs/tags/v1"],
      ],
      "deny",
    );
    expect(
      decideGhApiCall(["api", `${REPO}/git/refs`, "--input", input], cwd, config, false, {})
        .verdict,
    ).toBe("deny");
    expectAll(
      [
        [...create, "-f", "ref=refs/tags/v1"],
        [...create, "-f", "ref=refs/heads/master"],
      ],
      "deny",
      true,
    );
    expectAll(
      [
        [...create, "-f", "ref=refs/heads/feat/x"],
        ["-X", "POST", "repositories/123/git/refs", "-f", "ref=refs/heads/feat/x", "-f", "sha=abc"],
      ],
      "allow",
    );
  });
});

describe("ghGraphqlGuard allows only everyday mutations", () => {
  const gql = (query: string, ...extra: string[]) => ["graphql", "-f", `query=${query}`, ...extra];
  it("refuses repository administration mutations, however they are spelled", () => {
    expectAll(
      [
        gql('mutation { archiveRepository(input: {repositoryId: "R_1"}) { clientMutationId } }'),
        gql(
          'mutation($o: ID!) { createRepository(input: {name: "x", ownerId: $o, visibility: PRIVATE}) { repository { id } } }',
          "-f",
          "o=O_managed_org_id",
        ),
        gql(
          'mutation { updateTeamsRepository(input: {repositoryId: "R_1", teamIds: ["T"], permission: ADMIN}) { clientMutationId } }',
        ),
        gql(
          'mutation { createRef(input: {repositoryId: "R_1", name: "refs/heads/x", oid: "a"}) { clientMutationId } }',
        ),
        gql(
          'mutation { createBranchProtectionRule(input: {repositoryId: "R_1", pattern: "main"}) { clientMutationId } }',
        ),
        gql(
          'mutation { updateBranchProtectionRule(input: {branchProtectionRuleId: "B"}) { clientMutationId } }',
        ),
        gql(
          'mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: "B"}) { clientMutationId } }',
        ),
        gql(
          'mutation { cloneTemplateRepository(input: {repositoryId: "R", name: "x", ownerId: "O", visibility: PRIVATE}) { clientMutationId } }',
        ),
        gql(
          'mutation { ok: addComment(input: {subjectId: "I", body: "b"}) { clientMutationId } bad: archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }',
        ),
        gql(
          'mutation Two { addComment(input: {subjectId: "I", body: "b"}) { clientMutationId } } mutation { archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }',
        ),
        gql(
          'mutation { ...F } fragment F on Mutation { archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }',
        ),
        gql('mutation { addComment(input: {subjectId: "I", body: "b"}) { clientMutationId }'),
        gql("subscription { x }"),
      ],
      "deny",
    );
    expect(
      verdict(
        gql('mutation { archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }'),
        true,
      ),
    ).toBe("deny");
    const { config, cwd } = makeConfig();
    const input = NodePath.join(cwd, "q.json");
    NodeFS.writeFileSync(
      input,
      JSON.stringify({
        query:
          'mutation { updateRepository(input: {repositoryId: "R", hasWikiEnabled: false}) { clientMutationId } }',
      }),
    );
    expect(
      decideGhApiCall(["api", "graphql", "--input", input], cwd, config, false, {}).verdict,
    ).toBe("deny");
  });

  it("allows reads and the everyday issue, PR, comment, label and review mutations", () => {
    expectAll(
      [
        gql("query { viewer { login } }"),
        gql("{ viewer { login } }"),
        gql("query { ...V } fragment V on Query { viewer { login } }"),
        gql(
          'mutation { addComment(input: {subjectId: "I", body: "mutation { archiveRepository }"}) { clientMutationId } }',
        ),
        gql(
          'mutation($b: String!) { c: addComment(input: {subjectId: "I", body: $b}) { commentEdge { node { id } } } }',
          "-f",
          "b=hi",
        ),
        gql(
          'mutation { createIssue(input: {repositoryId: "R", title: "t"}) { issue { number } } }',
        ),
        gql(
          'mutation { addLabelsToLabelable(input: {labelableId: "I", labelIds: ["L"]}) { clientMutationId } }',
        ),
        gql(
          'mutation { addPullRequestReview(input: {pullRequestId: "P", event: COMMENT, body: "b"}) { clientMutationId } }',
        ),
        gql(
          'mutation { updatePullRequest(input: {pullRequestId: "P", title: "t"}) { clientMutationId } }',
        ),
      ],
      "allow",
    );
  });
});

describe("gh repo aliases", () => {
  it("treats gh repo ls like gh repo list", () => {
    const { config, cwd } = makeConfig();
    // GH_REPO names a managed repo, so anything but a read is refused.
    const env = { GH_REPO: "example-org/demo-app" };
    expect(decideGh(["repo", "ls", "example-org"], cwd, config, { env }).verdict).toBe("allow");
    expect(decideGh(["repo", "list", "example-org"], cwd, config, { env }).verdict).toBe("allow");
    expect(decideGh(["repo", "delete", "example-org/demo-app"], cwd, config, { env }).verdict).toBe(
      "deny",
    );
  });
});

describe("ghApiGuard reads the body gh actually sends", () => {
  it("with --input, reads body keys only from the input file (fields go in the query string)", () => {
    const { config, cwd } = makeConfig();
    const file = (name: string, body: unknown) => {
      const path = NodePath.join(cwd, name);
      NodeFS.writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
      return path;
    };
    const decide = (args: ReadonlyArray<string>) =>
      decideGhApiCall(["api", ...args], cwd, config, false, {}).verdict;
    const tag = file("tag.json", { ref: "refs/tags/v9", sha: "abc" });
    const base = file("base.json", { base: "main" });
    const fork = file("fork.json", { organization: "example-org" });
    const okRef = file("ok.json", { ref: "refs/heads/feat/ok", sha: "abc" });
    const numberBase = file("num.json", { base: 7 });
    const broken = file("broken.json", "{");
    for (const args of [
      [`${REPO}/git/refs`, "--input", tag, "-f", "ref=refs/heads/ok"],
      ["-X", "PATCH", `${REPO}/pulls/1`, "--input", base, "-f", "base=feat"],
      ["-X", "PATCH", `${REPO}/pulls/1`, "--input", numberBase],
      ["-X", "PATCH", `${REPO}/pulls/1`, "--input", broken, "-f", "base=feat"],
      ["-X", "PATCH", `${REPO}/pulls/1`, "--input", "-", "-f", "base=feat"],
      ["-X", "POST", "repos/other-org/other-repo/forks", "--input", fork, "-f", "organization=x"],
      ["-X", "POST", "repos/other-org/other-repo/forks", "--input", broken],
      [`${REPO}/git/refs`, "--input", broken, "-f", "ref=refs/heads/ok"],
    ]) {
      expect(decide(args), args.join(" ")).toBe("deny");
    }
    for (const args of [
      [`${REPO}/git/refs`, "--input", okRef, "-f", "ref=refs/tags/v9"],
      [
        "-X",
        "PATCH",
        `${REPO}/pulls/1`,
        "--input",
        file("t.json", { title: "t" }),
        "-f",
        "base=main",
      ],
      [
        "-X",
        "POST",
        "repos/other-org/other-repo/forks",
        "--input",
        file("f.json", {}),
        "-f",
        "organization=example-org",
      ],
    ]) {
      expect(decide(args), args.join(" ")).toBe("allow");
    }
  });
});

describe("ghGraphqlGuard refuses what it cannot read", () => {
  it("refuses query[] keys and undefined characters inside a mutation", () => {
    const bad = 'mutation { archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }';
    expectAll(
      [
        ["graphql", "-f", `query[]=${bad}`],
        ["graphql", "-f", `query[q]=${bad}`],
        [
          "graphql",
          "-f",
          `query=mutation { \u00a0archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }`,
        ],
        [
          "graphql",
          "-f",
          `query=mutation { \u2028archiveRepository(input: {repositoryId: "R"}) { clientMutationId } }`,
        ],
        [
          "graphql",
          "-f",
          `query=mutation { \varchiveRepository(input: {repositoryId: "R"}) { clientMutationId } }`,
        ],
      ],
      "deny",
    );
    expectAll(
      [
        [
          "graphql",
          "-f",
          'query=mutation { addComment(input: {subjectId: "I", body: "b"}) { commentEdge { node { reactions(first: 10) { totalCount } } } } }',
        ],
        ["graphql", "-f", "query=query { viewer { repositories(first: 5) { totalCount } } }"],
      ],
      "allow",
    );
  });
});
