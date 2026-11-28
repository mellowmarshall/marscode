import { describe, expect, it } from "vite-plus/test";

import { redactGuardCommand } from "./commandRedact.ts";

describe("redactGuardCommand credential shapes", () => {
  it.each([
    {
      name: "GITHUB_PAT env assignment",
      argv: ["env", "GITHUB_PAT=pat_value_111", "gh", "pr", "list"],
      secret: "pat_value_111",
      expected: ["env", "GITHUB_PAT=<redacted>", "gh", "pr", "list"],
    },
    {
      name: "npm config set registry _auth",
      argv: ["npm", "config", "set", "//registry.example.test/:_auth", "auth_value_222"],
      secret: "auth_value_222",
      expected: ["npm", "config", "set", "//registry.example.test/:_auth", "<redacted>"],
    },
    {
      name: "npm config set registry _password",
      argv: ["npm", "config", "set", "//registry.example.test/:_password", "pw_value_333"],
      secret: "pw_value_333",
      expected: ["npm", "config", "set", "//registry.example.test/:_password", "<redacted>"],
    },
    {
      name: "registry _password assignment",
      argv: ["npm", "publish", "//registry.example.test/:_password=pw_value_444"],
      secret: "pw_value_444",
      expected: ["npm", "publish", "//registry.example.test/:_password=<redacted>"],
    },
    {
      name: "registry _auth assignment",
      argv: ["npm", "publish", "//registry.example.test/:_auth=auth_value_555"],
      secret: "auth_value_555",
      expected: ["npm", "publish", "//registry.example.test/:_auth=<redacted>"],
    },
    {
      name: "git -c credential.helper with an inline password",
      argv: ["git", "-c", "credential.helper=!echo password=helper_value_666", "push"],
      secret: "helper_value_666",
      expected: ["git", "-c", "credential.helper=<redacted>", "push"],
    },
    {
      name: "git -c URL-scoped credential helper",
      argv: [
        "git",
        "-c",
        "credential.https://git.example.test.helper=!f() { echo password=helper_value_777; }; f",
        "fetch",
      ],
      secret: "helper_value_777",
      expected: ["git", "-c", "credential.https://git.example.test.helper=<redacted>", "fetch"],
    },
    {
      name: "git config credential.helper space form",
      argv: ["git", "config", "credential.helper", "!echo password=helper_value_888"],
      secret: "helper_value_888",
      expected: ["git", "config", "credential.helper", "<redacted>"],
    },
    {
      name: "git config --global URL-scoped credential helper space form",
      argv: [
        "git",
        "config",
        "--global",
        "Credential.https://git.example.test.Helper",
        "!echo password=helper_value_999",
      ],
      secret: "helper_value_999",
      expected: [
        "git",
        "config",
        "--global",
        "Credential.https://git.example.test.Helper",
        "<redacted>",
      ],
    },
    {
      name: "npm config set bare _auth",
      argv: ["npm", "config", "set", "_auth", "auth_value_aaa"],
      secret: "auth_value_aaa",
      expected: ["npm", "config", "set", "_auth", "<redacted>"],
    },
    {
      name: "npm config set bare _password",
      argv: ["npm", "config", "set", "_password", "pw_value_bbb"],
      secret: "pw_value_bbb",
      expected: ["npm", "config", "set", "_password", "<redacted>"],
    },
  ])("redacts $name", ({ argv, secret, expected }) => {
    const redacted = redactGuardCommand(argv);
    expect(redacted.join(" ")).not.toContain(secret);
    expect(redacted).toEqual(expected);
  });

  it("keeps look-alike non-secret words intact", () => {
    const argv = [
      "env",
      "PATH=/usr/bin:/bin",
      "PATCH_LEVEL=3",
      "git",
      "-c",
      "credential.useHttpPath=true",
      "-c",
      "core.pager=less",
      "push",
    ];
    expect(redactGuardCommand(argv)).toEqual(argv);
    expect(
      redactGuardCommand(["npm", "config", "set", "//registry.example.test/:username", "bot"]),
    ).toEqual(["npm", "config", "set", "//registry.example.test/:username", "bot"]);
    expect(redactGuardCommand(["git", "config", "credential.useHttpPath", "true"])).toEqual([
      "git",
      "config",
      "credential.useHttpPath",
      "true",
    ]);
    expect(redactGuardCommand(["npm", "config", "set", "my_auth", "value"])).toEqual([
      "npm",
      "config",
      "set",
      "my_auth",
      "value",
    ]);
  });
});
