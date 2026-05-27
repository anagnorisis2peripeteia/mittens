import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMittensStateDir } from "./cert-manager.js";

describe("resolveMittensStateDir", () => {
  it("returns homedir()/.mittens when no env var is set", () => {
    expect(resolveMittensStateDir({})).toBe(join(homedir(), ".mittens"));
  });

  it("returns homedir()/.mittens when env vars are empty strings", () => {
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: "" })).toBe(
      join(homedir(), ".mittens"),
    );
  });

  it("returns homedir()/.mittens when env vars are whitespace-only", () => {
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: "   " })).toBe(
      join(homedir(), ".mittens"),
    );
  });

  it("honours an absolute MITTENS_STATE_DIR override verbatim", () => {
    const abs = process.platform === "win32" ? "D:\\mittens-state" : "/var/lib/mittens-state";
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: abs })).toBe(abs);
  });

  it("expands `~` to homedir()", () => {
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: "~" })).toBe(homedir());
  });

  it("expands `~/Documents/mittens` to homedir()/Documents/mittens", () => {
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: "~/Documents/mittens" })).toBe(
      join(homedir(), "Documents/mittens"),
    );
  });

  it("resolves a relative MITTENS_STATE_DIR against cwd", () => {
    expect(resolveMittensStateDir({ MITTENS_STATE_DIR: "relative/state-dir" })).toBe(
      resolve("relative/state-dir"),
    );
  });

  it("falls back to OPENCLAW_STATE_DIR when MITTENS_STATE_DIR is unset", () => {
    const abs = process.platform === "win32" ? "D:\\openclaw-state" : "/var/lib/openclaw-state";
    expect(resolveMittensStateDir({ OPENCLAW_STATE_DIR: abs })).toBe(abs);
  });

  it("prefers MITTENS_STATE_DIR over OPENCLAW_STATE_DIR", () => {
    const mittens = process.platform === "win32" ? "D:\\mittens" : "/var/mittens";
    const openclaw = process.platform === "win32" ? "D:\\openclaw" : "/var/openclaw";
    expect(resolveMittensStateDir({
      MITTENS_STATE_DIR: mittens,
      OPENCLAW_STATE_DIR: openclaw,
    })).toBe(mittens);
  });

  it("falls back to dirname(OPENCLAW_CONFIG_PATH) when state dirs are unset", () => {
    const cfg =
      process.platform === "win32" ? "D:\\iso\\profile\\config.json5" : "/iso/profile/config.json5";
    expect(resolveMittensStateDir({ OPENCLAW_CONFIG_PATH: cfg })).toBe(dirname(cfg));
  });

  it("expands `~` in OPENCLAW_CONFIG_PATH before taking its dirname", () => {
    expect(
      resolveMittensStateDir({ OPENCLAW_CONFIG_PATH: "~/iso/profile/config.json5" }),
    ).toBe(join(homedir(), "iso/profile"));
  });

  it("prefers MITTENS_STATE_DIR over OPENCLAW_CONFIG_PATH", () => {
    const abs = process.platform === "win32" ? "D:\\mittens" : "/var/mittens";
    expect(
      resolveMittensStateDir({
        MITTENS_STATE_DIR: abs,
        OPENCLAW_CONFIG_PATH: "/iso/profile/config.json5",
      }),
    ).toBe(abs);
  });

  it("honours OPENCLAW_HOME for the default and `~` expansion", () => {
    const altHome = process.platform === "win32" ? "D:\\alt-home" : "/alt-home";
    expect(resolveMittensStateDir({ OPENCLAW_HOME: altHome })).toBe(
      join(altHome, ".mittens"),
    );
    expect(
      resolveMittensStateDir({ OPENCLAW_HOME: altHome, MITTENS_STATE_DIR: "~/s" }),
    ).toBe(join(altHome, "s"));
  });
});
