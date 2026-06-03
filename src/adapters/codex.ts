/**
 * OpenAI Codex CLI adapter.
 *
 * Uses `codex exec --json` in stdout-pipe mode rather than MITM. The
 * exec --json JSONL stream includes visible commentary (agent_message
 * items where the model explains its reasoning), which the MITM
 * WebSocket path encrypts. This gives richer output — intermediate
 * reasoning surfaces as thinking_delta instead of [encrypted reasoning].
 *
 * Session management: Codex uses thread IDs for session continuity.
 * `codex exec resume --last` resumes the most recent session.
 */
import type { CliAdapter } from "./types.js";
import { normalizeCodexExecEvent } from "./codex-normalizer.js";

export const codexAdapter: CliAdapter = {
  id: "codex",
  name: "Codex",
  binary: "codex",
  binaryEnvVar: "MITTENS_CODEX_BINARY",
  mode: "stdout",
  streamFormat: "ndjson",
  needsTtySpoof: false,
  stripFlags: [],
  valuelessFlags: new Set(),
  sessionIdFlags: [],
  inputMode: "stdin",

  injectFlags: ["exec", "--json", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox"],

  session: {
    mode: "none",
    sessionIdFields: ["thread_id"],
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
    return normalizeCodexExecEvent(evt);
  },
};
