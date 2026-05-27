/**
 * Top-level CLI surface for the standalone `mittens` entry: `--help` / `--version`
 * plus the intent classifier that decides whether an invocation is a Mittens
 * meta-command or a passthrough run.
 *
 * Drop-in safety: a Mittens meta-command is recognised ONLY when the flag is the
 * FIRST argv. The target CLI itself accepts `--help`/`--version`, and a harness
 * can legitimately pass them deeper in the arg list (or as a prompt) — hijacking
 * those would break the drop-in contract.
 */
import { listAdapters } from "../adapters/index.js";

export const MITTENS_VERSION = "0.1.0";

export type TopLevelIntent = "help" | "version" | "list" | "run";

export function parseTopLevelIntent(args: readonly string[]): TopLevelIntent {
  const first = args[0];
  if (first === "--help" || first === "-h") {
    return "help";
  }
  if (first === "--version" || first === "-V") {
    return "version";
  }
  if (first === "--list-adapters") {
    return "list";
  }
  return "run";
}

export function versionText(): string {
  return `mittens ${MITTENS_VERSION}`;
}

export function listAdaptersText(): string {
  const adapters = listAdapters();
  const lines = adapters.map(a =>
    `  ${a.id.padEnd(15)} ${a.name.padEnd(20)} ${a.target?.host ?? `(${a.mode})`}`
  );
  return ["Available adapters:", "", ...lines].join("\n");
}

export function helpText(): string {
  const adapterIds = listAdapters().map(a => a.id).join(", ");
  return [
    "mittens -- MITM proxy for agent CLIs (intercept API traffic, tap streaming events)",
    "",
    "USAGE:",
    "  mittens [--adapter=claude] [cli args...]   run through the Mittens MITM proxy",
    "  mittens --list-adapters                    show available CLI adapters",
    "  mittens --help                             show this help",
    "  mittens --version                          print the Mittens version",
    "",
    `ADAPTERS: ${adapterIds}`,
    "",
    "  --adapter=<id>   select the target CLI (default: claude)",
    "",
    "All other arguments are forwarded verbatim to the target CLI.",
    "Mittens matches `claude -p`'s output for the requested --output-format:",
    "",
    "  (default) / --output-format text         single final assistant message",
    "  --output-format json                     single JSON result record",
    "  --output-format stream-json              incremental JSONL (Mittens-native)",
    "",
    "REQUIREMENTS:",
    "  bun on PATH, and the target CLI installed + authenticated.",
    "",
    "ENV (Mittens-native, OPENCLAW_* fallback):",
    "  MITTENS_STATE_DIR / MITTENS_HOME / MITTENS_CONFIG_PATH   state + cert root",
    "  MITTENS_CLAUDE_BINARY                                    path to `claude`",
    "  MITTENS_CURSOR_BINARY                                    path to `cursor`",
    "  MITTENS_DEBUG=1                                          verbose proxy logs",
  ].join("\n");
}
