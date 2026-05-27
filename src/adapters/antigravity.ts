/**
 * Antigravity CLI adapter (Google's successor to Gemini CLI).
 *
 * Same Google backend as Gemini CLI, so shares the API normalizer.
 * Runs via gRPC/HTTP2 to www.googleapis.com, requiring kernel redirect.
 * No CLI backend exists in OpenClaw — Mittens provides the first one.
 *
 * Session model mirrors Gemini: server-side state, --resume for
 * continuation, sessionMode "existing" (only resume, never create).
 */
import type { CliAdapter } from "./types.js";
import { normalizeGeminiEvent } from "./gemini-normalizer.js";

export const antigravityAdapter: CliAdapter = {
  id: "antigravity",
  name: "Antigravity (Google)",
  binary: "agy",
  binaryEnvVar: "MITTENS_ANTIGRAVITY_BINARY",
  mode: "mitm",
  target: {
    host: "www.googleapis.com",
    port: 443,
    passthroughHosts: ["oauth2.googleapis.com", "antigravity-unleash.goog", "lh3.googleusercontent.com", "run.app"],
    useH2: true,
    mitmAll: true,
    needsKernelRedirect: true,
  },
  streamFormat: "sse",
  needsTtySpoof: true,
  stripFlags: ["-p", "--print", "--output-format"],
  valuelessFlags: new Set(["-p", "--print"]),
  sessionIdFlags: [],
  inputMode: "arg",
  envOverrides: {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  },

  session: {
    mode: "existing",
    sessionIdFields: ["session_id", "sessionId"],
    resumeArgs: [
      "--resume", "{sessionId}",
    ],
  },

  model: {
    modelArg: "--model",
    aliases: {
      "pro": "gemini-3.1-pro-preview",
      "flash": "gemini-3.1-flash-preview",
      "flash-lite": "gemini-3.1-flash-lite",
    },
    available: [
      "gemini-3.1-pro-preview", "gemini-3.1-flash-preview", "gemini-3.1-flash-lite",
    ],
    defaultModel: "gemini-3.1-flash-preview",
  },

  systemPrompt: {
    when: "never",
  },

  bundleMcpMode: "gemini-system-settings",
  nativeToolMode: "always-on",

  baseArgs: [],

  normalizeEvent(evt) {
    return normalizeGeminiEvent(evt);
  },
};
