/**
 * OpenAI Codex CLI adapter.
 *
 * Codex doesn't have a CLI backend in OpenClaw — Mittens provides the
 * first CLI backend path. Codex is a Rust binary that talks to
 * chatgpt.com via WebSocket. MCP config would be injected via
 * `-c mcp_servers='{...}'` (codex-config-overrides mode).
 *
 * Session management: Codex uses response IDs as session continuations.
 * The response.created event contains the response ID which can be
 * passed back via --previous-response-id for multi-turn.
 */
import type { CliAdapter } from "./types.js";
import { normalizeCodexEvent } from "./codex-normalizer.js";

export const codexAdapter: CliAdapter = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  binaryEnvVar: "MITTENS_CODEX_BINARY",
  mode: "mitm",
  target: {
    host: "chatgpt.com",
    port: 443,
    passthroughHosts: ["api.github.com", "github.com"],
  },
  streamFormat: "ndjson",
  needsTtySpoof: false,
  stripFlags: [],
  valuelessFlags: new Set(),
  sessionIdFlags: [],
  inputMode: "stdin",

  session: {
    mode: "none",
    sessionIdFields: ["id"],
  },

  model: {
    modelArg: "--model",
    aliases: {
      "gpt-5.5": "gpt-5.5",
      "5.5": "gpt-5.5",
      "gpt-5.4-mini": "gpt-5.4-mini",
      "mini": "gpt-5.4-mini",
      "spark": "gpt-5.3-codex-spark",
    },
    available: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-codex", "gpt-5.3-codex-spark"],
    defaultModel: "gpt-5.5",
  },

  systemPrompt: {
    inlineArg: "-c",
    when: "always",
  },

  bundleMcpMode: "codex-config-overrides",
  nativeToolMode: "always-on",

  baseArgs: [],

  normalizeEvent(evt) {
    return normalizeCodexEvent(evt);
  },
};
