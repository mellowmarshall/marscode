import { describe, expect, it } from "@effect/vitest";

import {
  classifySecretMessage,
  isQuietRead,
  monitorMatchRules,
  parseSearchItemsReply,
  type ObservedMessage,
} from "./secretMessages.ts";

const call = (overrides: Partial<ObservedMessage>): ObservedMessage => ({
  isMethodCall: true,
  interface: "org.freedesktop.Secret.Service",
  member: "SearchItems",
  sender: ":1.42",
  body: [],
  ...overrides,
});

const noOwnNames = new Set<string>();

describe("monitorMatchRules", () => {
  it("watches method calls on every Secret Service interface", () => {
    expect(monitorMatchRules()).toEqual([
      "type='method_call',interface='org.freedesktop.Secret.Service'",
      "type='method_call',interface='org.freedesktop.Secret.Collection'",
      "type='method_call',interface='org.freedesktop.Secret.Item'",
      "type='method_call',interface='org.freedesktop.Secret.Session'",
    ]);
  });
});

describe("classifySecretMessage", () => {
  it("ignores other interfaces, non-calls, and the monitor's own connections", () => {
    expect(
      classifySecretMessage(call({ interface: "org.freedesktop.DBus" }), noOwnNames),
    ).toBeNull();
    expect(classifySecretMessage(call({ interface: undefined }), noOwnNames)).toBeNull();
    expect(classifySecretMessage(call({ isMethodCall: false }), noOwnNames)).toBeNull();
    expect(classifySecretMessage(call({ sender: ":1.7" }), new Set([":1.7"]))).toBeNull();
  });

  it("treats OpenSession and Close as routine plumbing that still names its sender", () => {
    expect(classifySecretMessage(call({ member: "OpenSession" }), noOwnNames)).toEqual({
      kind: "routine",
      sender: ":1.42",
    });
    expect(
      classifySecretMessage(
        call({ interface: "org.freedesktop.Secret.Session", member: "Close" }),
        noOwnNames,
      ),
    ).toEqual({ kind: "routine", sender: ":1.42" });
  });

  it("keeps SearchItems and other calls for the audit log", () => {
    expect(classifySecretMessage(call({ member: "SearchItems" }), noOwnNames)).toEqual({
      kind: "audit",
      sender: ":1.42",
      interface: "org.freedesktop.Secret.Service",
      member: "SearchItems",
    });
    expect(
      classifySecretMessage(
        call({ interface: "org.freedesktop.Secret.Item", member: "Delete" }),
        noOwnNames,
      ),
    ).toMatchObject({ kind: "audit", member: "Delete" });
  });

  it("reads the item paths from GetSecrets", () => {
    expect(
      classifySecretMessage(
        call({
          member: "GetSecrets",
          body: [["/org/freedesktop/secrets/collection/login/7", 3], "/session/1"],
        }),
        noOwnNames,
      ),
    ).toEqual({
      kind: "getSecrets",
      sender: ":1.42",
      interface: "org.freedesktop.Secret.Service",
      paths: ["/org/freedesktop/secrets/collection/login/7"],
    });
    expect(
      classifySecretMessage(call({ member: "GetSecrets", body: ["not-an-array"] }), noOwnNames),
    ).toMatchObject({ kind: "getSecrets", paths: [] });
  });
});

describe("isQuietRead", () => {
  const quiet = new Set(["/collection/login/1", "/collection/login/2"]);

  it("is quiet only when every path read is a quiet item", () => {
    expect(isQuietRead(["/collection/login/1"], quiet)).toBe(true);
    expect(isQuietRead(["/collection/login/1", "/collection/login/2"], quiet)).toBe(true);
    expect(isQuietRead(["/collection/login/1", "/collection/login/9"], quiet)).toBe(false);
  });

  it("never treats a read of nothing as quiet", () => {
    expect(isQuietRead([], quiet)).toBe(false);
  });
});

describe("parseSearchItemsReply", () => {
  it("collects unlocked and locked matches", () => {
    expect([...parseSearchItemsReply([["/a", "/b"], ["/c"]])]).toEqual(["/a", "/b", "/c"]);
  });

  it("drops malformed parts", () => {
    expect([...parseSearchItemsReply(["/a", [1, "/b"]])]).toEqual(["/b"]);
  });
});
