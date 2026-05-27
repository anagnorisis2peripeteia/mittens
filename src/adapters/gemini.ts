/**
 * Google Gemini CLI adapter.
 *
 * Session/config mirrors OpenClaw's google-gemini-cli backend.
 * Gemini uses server-side session state; --resume resumes an existing
 * session. Session mode is "existing" — only resume, never create.
 * MCP config injected via GEMINI_CLI_SYSTEM_SETTINGS_PATH.
 */
import type { CliAdapter } from "./types.js";
import { normalizeGeminiEvent } from "./gemini-normalizer.js";

export const geminiAdapter: CliAdapter = {
  id: "gemini",
  name: "Gemini CLI",
  binary: "gemini",
  binaryEnvVar: "MITTENS_GEMINI_BINARY",
  mode: "mitm",
  target: {
    host: "cloudcode-pa.googleapis.com",
    port: 443,
    passthroughHosts: ["oauth2.googleapis.com"],
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
      "--skip-trust", "--resume", "{sessionId}",
      "--output-format", "json",
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

  baseArgs: ["--skip-trust", "--output-format", "json"],

  normalizeEvent(evt) {
    return normalizeGeminiEvent(evt);
  },
};
