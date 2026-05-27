import { describe, expect, it } from "vitest";
import {
  helpText,
  listAdaptersText,
  MITTENS_VERSION,
  parseTopLevelIntent,
  versionText,
} from "./help.js";

describe("parseTopLevelIntent", () => {
  it("recognises --help / -h as the first arg", () => {
    expect(parseTopLevelIntent(["--help"])).toBe("help");
    expect(parseTopLevelIntent(["-h"])).toBe("help");
  });

  it("recognises --version / -V as the first arg", () => {
    expect(parseTopLevelIntent(["--version"])).toBe("version");
    expect(parseTopLevelIntent(["-V"])).toBe("version");
  });

  it("recognises --list-adapters", () => {
    expect(parseTopLevelIntent(["--list-adapters"])).toBe("list");
  });

  it("treats no args as a run", () => {
    expect(parseTopLevelIntent([])).toBe("run");
  });

  it("does NOT hijack a meta-flag that is not the first arg", () => {
    expect(parseTopLevelIntent(["-p", "--help"])).toBe("run");
    expect(parseTopLevelIntent(["-p", "explain --version"])).toBe("run");
    expect(parseTopLevelIntent(["--output-format", "json", "-h"])).toBe("run");
  });
});

describe("versionText / helpText / listAdaptersText", () => {
  it("version line carries the package version", () => {
    expect(versionText()).toBe(`mittens ${MITTENS_VERSION}`);
  });

  it("help body documents output modes and adapters", () => {
    const help = helpText();
    expect(help).toContain("--output-format text");
    expect(help).toContain("--output-format json");
    expect(help).toContain("--output-format stream-json");
    expect(help).toContain("--adapter=");
    expect(help).toContain("USAGE:");
  });

  it("list-adapters shows all registered adapters", () => {
    const list = listAdaptersText();
    expect(list).toContain("claude");
    expect(list).toContain("cursor");
    expect(list).toContain("antigravity");
    expect(list).toContain("api.anthropic.com");
  });
});
