import { describe, expect, it } from "vitest";
import { parseAdapter, parseClaudeOutputFormat, stripPrintModeFlags, wantsStreaming } from "./cli-args.js";

describe("parseClaudeOutputFormat", () => {
  it("defaults to text when --output-format is absent", () => {
    expect(parseClaudeOutputFormat(["-p", "hello"])).toBe("text");
    expect(parseClaudeOutputFormat([])).toBe("text");
  });

  it("reads `--output-format <fmt>`", () => {
    expect(parseClaudeOutputFormat(["--output-format", "json"])).toBe("json");
    expect(parseClaudeOutputFormat(["-p", "--output-format", "stream-json", "hi"])).toBe(
      "stream-json",
    );
  });

  it("reads `--output-format=<fmt>`", () => {
    expect(parseClaudeOutputFormat(["--output-format=stream-json"])).toBe("stream-json");
  });

  it("ignores unknown formats and keeps the default", () => {
    expect(parseClaudeOutputFormat(["--output-format", "yaml"])).toBe("text");
  });

  it("does not treat the format value as another flag occurrence", () => {
    // The value after --output-format is consumed, not re-scanned.
    expect(parseClaudeOutputFormat(["--output-format", "--output-format"])).toBe("text");
  });

  it("last valid occurrence wins", () => {
    expect(
      parseClaudeOutputFormat(["--output-format", "json", "--output-format=stream-json"]),
    ).toBe("stream-json");
  });
});

describe("wantsStreaming", () => {
  it("is true only for stream-json", () => {
    expect(wantsStreaming(["--output-format", "stream-json"])).toBe(true);
    expect(wantsStreaming(["--output-format", "json"])).toBe(false);
    expect(wantsStreaming(["-p", "hello"])).toBe(false);
  });
});

describe("parseAdapter", () => {
  it("defaults to claude when --adapter is absent", () => {
    const { adapter, rest } = parseAdapter(["--model", "opus", "hello"]);
    expect(adapter).toBe("claude");
    expect(rest).toEqual(["--model", "opus", "hello"]);
  });

  it("parses --adapter=cursor (equals form)", () => {
    const { adapter, rest } = parseAdapter(["--adapter=cursor", "hello"]);
    expect(adapter).toBe("cursor");
    expect(rest).toEqual(["hello"]);
  });

  it("parses --adapter cursor (space form)", () => {
    const { adapter, rest } = parseAdapter(["--adapter", "cursor", "hello"]);
    expect(adapter).toBe("cursor");
    expect(rest).toEqual(["hello"]);
  });

  it("ignores unknown adapter values and keeps claude", () => {
    const { adapter } = parseAdapter(["--adapter=unknown"]);
    expect(adapter).toBe("claude");
  });

  it("strips the adapter flag from the rest", () => {
    const { rest } = parseAdapter(["--adapter=antigravity", "--model", "gpt-5", "hello"]);
    expect(rest).toEqual(["--model", "gpt-5", "hello"]);
  });
});

describe("stripPrintModeFlags", () => {
  it("removes -p / --print so claude stays interactive", () => {
    expect(stripPrintModeFlags(["-p", "hello"])).toEqual(["hello"]);
    expect(stripPrintModeFlags(["--print", "hello"])).toEqual(["hello"]);
  });

  it("removes --output-format and its value (space form)", () => {
    expect(stripPrintModeFlags(["-p", "--output-format", "json", "hi"])).toEqual(["hi"]);
  });

  it("removes --output-format=<fmt> (equals form)", () => {
    expect(stripPrintModeFlags(["--output-format=stream-json", "hi"])).toEqual(["hi"]);
  });

  it("removes --input-format too", () => {
    expect(stripPrintModeFlags(["--input-format", "text", "hi"])).toEqual(["hi"]);
  });

  it("preserves the prompt and all non-print flags in order", () => {
    expect(
      stripPrintModeFlags(["-p", "--model", "opus", "--output-format", "json", "do the thing"]),
    ).toEqual(["--model", "opus", "do the thing"]);
  });

  it("leaves a prompt that merely looks like a flag untouched", () => {
    // The positional prompt is never a known print flag, so it survives.
    expect(stripPrintModeFlags(["--resume", "abc", "explain -p mode"])).toEqual([
      "--resume",
      "abc",
      "explain -p mode",
    ]);
  });
});
