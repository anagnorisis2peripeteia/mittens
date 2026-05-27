import { describe, expect, it } from "vitest";
import { parseResultRecord, renderEngineLine } from "./output.js";

const INIT = JSON.stringify({ type: "init", session_id: "s1" });
const EVENT = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } });
const RESULT = JSON.stringify({
  type: "result",
  session_id: "s1",
  result: "the answer",
  is_error: false,
  stop_reason: "end_turn",
});
const ERROR_RESULT = JSON.stringify({
  type: "result",
  subtype: "error",
  result: "",
  is_error: true,
  error: "rate_limit_error: slow down",
});

describe("parseResultRecord", () => {
  it("returns null for non-result lines and junk", () => {
    expect(parseResultRecord(INIT)).toBeNull();
    expect(parseResultRecord(EVENT)).toBeNull();
    expect(parseResultRecord("")).toBeNull();
    expect(parseResultRecord("not json")).toBeNull();
  });

  it("parses the terminal result record", () => {
    const r = parseResultRecord(RESULT);
    expect(r?.isError).toBe(false);
    expect(r?.text).toBe("the answer");
  });

  it("falls back to the error field for text on the error path", () => {
    const r = parseResultRecord(ERROR_RESULT);
    expect(r?.isError).toBe(true);
    expect(r?.text).toBe("rate_limit_error: slow down");
  });
});

describe("renderEngineLine — stream-json", () => {
  it("forwards every line verbatim, newline-normalised", () => {
    expect(renderEngineLine("stream-json", INIT)).toBe(`${INIT}\n`);
    expect(renderEngineLine("stream-json", EVENT)).toBe(`${EVENT}\n`);
    expect(renderEngineLine("stream-json", `${RESULT}\n`)).toBe(`${RESULT}\n`);
  });

  it("suppresses blank lines", () => {
    expect(renderEngineLine("stream-json", "")).toBe("");
    expect(renderEngineLine("stream-json", "\n")).toBe("");
  });
});

describe("renderEngineLine — json", () => {
  it("suppresses intermediates and emits only the result record", () => {
    expect(renderEngineLine("json", INIT)).toBe("");
    expect(renderEngineLine("json", EVENT)).toBe("");
    expect(renderEngineLine("json", RESULT)).toBe(`${RESULT}\n`);
  });
});

describe("renderEngineLine — text", () => {
  it("suppresses intermediates and emits only the result's plain text", () => {
    expect(renderEngineLine("text", INIT)).toBe("");
    expect(renderEngineLine("text", EVENT)).toBe("");
    expect(renderEngineLine("text", RESULT)).toBe("the answer\n");
  });

  it("emits the error message as text on the error path", () => {
    expect(renderEngineLine("text", ERROR_RESULT)).toBe("rate_limit_error: slow down\n");
  });
});
