/**
 * Pure helpers for parsing the passthrough argv. Mittens is a drop-in for agent
 * CLIs, so it must emit in the SAME wire format the caller asked for via
 * `--output-format`. Keeping this pure makes the dual-mode contract (buffered
 * vs streaming) unit-testable without Bun or the target CLI binary.
 */
import { isAdapterId, type AdapterId } from "../adapters/index.js";

export type ClaudeOutputFormat = "text" | "json" | "stream-json";

const OUTPUT_FORMATS: ReadonlySet<string> = new Set(["text", "json", "stream-json"]);

/** `claude -p`'s default output format when `--output-format` is absent. */
export const DEFAULT_OUTPUT_FORMAT: ClaudeOutputFormat = "text";

function isOutputFormat(value: string | undefined): value is ClaudeOutputFormat {
  return value !== undefined && OUTPUT_FORMATS.has(value);
}

/**
 * Resolve the requested output format from the passthrough claude args,
 * supporting both `--output-format <fmt>` and `--output-format=<fmt>`. Unknown
 * values are ignored; the last valid occurrence wins (matching how claude
 * resolves a repeated flag). Returns the default ("text") when unset.
 */
export function parseClaudeOutputFormat(args: readonly string[]): ClaudeOutputFormat {
  let format: ClaudeOutputFormat = DEFAULT_OUTPUT_FORMAT;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--output-format") {
      const next = args[i + 1];
      if (isOutputFormat(next)) {
        format = next;
      }
      i += 1; // consume the value
    } else if (arg?.startsWith("--output-format=")) {
      const value = arg.slice("--output-format=".length);
      if (isOutputFormat(value)) {
        format = value;
      }
    }
  }
  return format;
}

/**
 * True when the caller wants incremental `stream-json` JSONL (Mittens' native
 * tap-and-forward mode). The other formats ("text"/"json") are buffered: emit a
 * single final record once the turn completes.
 */
export function wantsStreaming(args: readonly string[]): boolean {
  return parseClaudeOutputFormat(args) === "stream-json";
}

// Print-mode flags that MUST NOT reach the interactive `claude` the engine
// spawns. The billing-pool trick depends on claude running interactively (the
// TTY spoof keeps it there); `-p`/`--print` would force the metered print path,
// and the I/O-format flags are print-mode-only — Mittens has already consumed
// `--output-format` to pick its own output mode, and re-emits stream-json
// regardless, so forwarding them to interactive claude is at best a no-op and
// at worst an arg-parse error.
const STRIPPED_VALUELESS_FLAGS: ReadonlySet<string> = new Set(["-p", "--print"]);
const STRIPPED_VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  "--output-format",
  "--input-format",
]);

/**
 * Remove the print-mode flags from the passthrough argv before it reaches the
 * interactive `claude`. Handles both `--flag value` and `--flag=value`. Every
 * other argument — including the positional prompt — passes through untouched
 * and in order, so Mittens stays a faithful drop-in for the rest of the surface.
 */
/**
 * Extract the --adapter=<id> flag from the argv. Returns "claude" as default.
 * Also returns the remaining args with the adapter flag stripped.
 */
export function parseAdapter(args: readonly string[]): { adapter: AdapterId; rest: string[] } {
  let adapter: AdapterId = "claude";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--adapter=")) {
      const value = arg.slice("--adapter=".length);
      if (isAdapterId(value)) adapter = value;
      continue;
    }
    if (arg === "--adapter") {
      const next = args[i + 1];
      if (next && isAdapterId(next)) adapter = next;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  return { adapter, rest };
}

export function stripPrintModeFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (STRIPPED_VALUELESS_FLAGS.has(arg)) {
      continue;
    }
    if (STRIPPED_VALUE_TAKING_FLAGS.has(arg)) {
      i += 1; // also drop the value that follows
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1 && STRIPPED_VALUE_TAKING_FLAGS.has(arg.slice(0, eq))) {
      continue;
    }
    out.push(arg);
  }
  return out;
}
