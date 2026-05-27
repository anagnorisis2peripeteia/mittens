/**
 * Cursor Agent CLI adapter.
 *
 * Cursor Agent runs in WSL on Windows (no native Windows build).
 * Chat traffic goes to agentn.global.api5.cursor.sh via gRPC/HTTP2.
 * Requires kernel redirect (iptables DNAT) since Cursor's gRPC
 * client ignores HTTPS_PROXY.
 *
 * No CLI backend exists in OpenClaw for Cursor — Mittens provides the
 * first one. Cursor Agent has its own session/workspace model (state
 * lives in the Cursor IDE's workspace DB), but for CLI mode we use
 * its stream-json output which includes session_id.
 */
import type { CliAdapter } from "./types.js";
import { normalizeCursorEvent } from "./cursor-normalizer.js";

export const cursorAdapter: CliAdapter = {
  id: "cursor",
  name: "Cursor Agent",
  binary: "wsl",
  binaryEnvVar: "MITTENS_CURSOR_BINARY",
  mode: "mitm",
  target: {
    host: "agentn.global.api5.cursor.sh",
    port: 443,
    passthroughHosts: ["api2.cursor.sh", "repo42.cursor.sh"],
    useH2: true,
    needsKernelRedirect: true,
  },
  streamFormat: "sse",
  needsTtySpoof: true,
  stripFlags: ["-p", "--print", "--output-format"],
  valuelessFlags: new Set(["-p", "--print"]),
  sessionIdFlags: [],
  inputMode: "arg",
  injectFlags: [
    "-d", "Ubuntu", "--",
    "/root/.local/bin/cursor-agent",
  ],

  session: {
    mode: "existing",
    sessionIdFields: ["session_id", "sessionId"],
    resumeArgs: [
      "-d", "Ubuntu", "--",
      "/root/.local/bin/cursor-agent",
      "--resume", "{sessionId}",
    ],
  },

  model: {
    modelArg: "--model",
    aliases: {
      "claude-sonnet": "claude-3.5-sonnet",
      "gpt-4o": "gpt-4o",
    },
    available: ["claude-3.5-sonnet", "gpt-4o", "cursor-small"],
    defaultModel: "claude-3.5-sonnet",
  },

  systemPrompt: {
    when: "never",
  },

  bundleMcpMode: "none",
  nativeToolMode: "always-on",

  baseArgs: ["-p"],

  normalizeEvent(evt) {
    return normalizeCursorEvent(JSON.stringify(evt));
  },
};
