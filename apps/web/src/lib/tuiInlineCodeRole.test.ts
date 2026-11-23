import { describe, expect, it } from "vite-plus/test";
import { classifyInlineCodeRole } from "./tuiInlineCodeRole";

describe("classifyInlineCodeRole", () => {
  it("classifies paths, commands, flags, symbols, literals, and plain text", () => {
    expect(classifyInlineCodeRole("apps/web/src/index.css")).toBe("path");
    expect(classifyInlineCodeRole("./scripts/build.ts:42:7")).toBe("path");
    expect(classifyInlineCodeRole("pnpm --filter @t3tools/web build")).toBe("cmd");
    expect(classifyInlineCodeRole("git status")).toBe("cmd");
    expect(classifyInlineCodeRole("--frozen-lockfile")).toBe("flag");
    expect(classifyInlineCodeRole("NODE_ENV=production")).toBe("flag");
    expect(classifyInlineCodeRole("TerminalOutputText")).toBe("symbol");
    expect(classifyInlineCodeRole("resolveTuiProviderKey()")).toBe("symbol");
    expect(classifyInlineCodeRole("true")).toBe("literal");
    expect(classifyInlineCodeRole("42")).toBe("literal");
    expect(classifyInlineCodeRole("hello world")).toBe("plain");
    expect(classifyInlineCodeRole("CI/CD")).toBe("plain");
    expect(classifyInlineCodeRole("React/Next")).toBe("plain");
    expect(classifyInlineCodeRole("HTTP/2")).toBe("plain");
    expect(classifyInlineCodeRole("src/index")).toBe("path");
  });
});
