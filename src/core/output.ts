/**
 * Adapts the engine's always-on `stream-json` NDJSON to the output format the
 * caller actually asked for, so the standalone `mittens` CLI is a true superset
 * drop-in for `claude -p`.
 *
 * The engine (wrapper.ts) emits one JSON record per line: an `init` record, any
 * number of `stream_event` records, then exactly one terminal `result` record.
 * This module is a PURE per-line transform over that NDJSON — no Bun, no I/O —
 * so the three-way format contract is unit-testable:
 *
 *   stream-json : forward every line verbatim (engine-native)
 *   json        : suppress intermediates, emit only the terminal result record
 *   text        : suppress intermediates, emit only the result's plain text
 */
import type { ClaudeOutputFormat } from "./cli-args.js";

/** Parsed view of the engine's terminal `{ "type": "result", ... }` record. */
export interface EngineResult {
  isError: boolean;
  /** The assistant's final text (text mode) — falls back to an error string. */
  text: string;
  /** The full record, re-serialized for json/stream-json modes. */
  record: Record<string, unknown>;
}

/**
 * Return the terminal result record if `rawLine` is one, else null. A line is
 * the terminal record when it parses to an object with `type === "result"`.
 */
export function parseResultRecord(rawLine: string): EngineResult | null {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "result") {
    return null;
  }
  const isError = record["is_error"] === true;
  const resultText = typeof record["result"] === "string" ? record["result"] : "";
  // On the error path the engine may leave `result` empty and carry the message
  // in `error`; surface that in text mode so a failure isn't a silent blank.
  const errorText = typeof record["error"] === "string" ? record["error"] : "";
  return {
    isError,
    text: resultText || (isError ? errorText : ""),
    record,
  };
}

/**
 * Render a single engine NDJSON line for the requested format. Returns the exact
 * bytes to write to stdout (newline-terminated), or "" to suppress the line.
 *
 * stream-json forwards everything; json/text drop all non-terminal lines and
 * only render the terminal result record (json → the record, text → its text).
 */
export function renderEngineLine(format: ClaudeOutputFormat, rawLine: string): string {
  if (format === "stream-json") {
    const trimmed = rawLine.replace(/\r?\n$/, "");
    return trimmed ? `${trimmed}\n` : "";
  }
  const result = parseResultRecord(rawLine);
  if (!result) {
    return "";
  }
  if (format === "json") {
    return `${JSON.stringify(result.record)}\n`;
  }
  // text
  return `${result.text}\n`;
}
