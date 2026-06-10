/**
 * Claude Code CLI adapter.
 *
 * Claude needs TTY spoofing to stay on the interactive billing path.
 * The MITM proxy intercepts api.anthropic.com, taps the SSE stream,
 * and re-emits as stream-json JSONL.
 *
 * Session/config mirrors OpenClaw's claude-cli-interactive backend.
 */
import type { CliAdapter } from "./types.js";
import { DEFAULT_SPAWNER_TOOL_NAMES } from "../core/request-classifier.js";

const ANTHROPIC_CLEAR_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD", "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export const claudeAdapter: CliAdapter = {
  id: "claude",
  name: "Claude Code",
  binary: "claude",
  binaryEnvVar: "MITTENS_CLAUDE_BINARY",
  mode: "mitm",
  hasSessionFiles: true,
  // Primary-turn spawner tools for Claude Code (the Task/Agent tool). Forwarded
  // to the shared classifier so sub-agent streams are detected robustly.
  primarySpawnerToolNames: DEFAULT_SPAWNER_TOOL_NAMES,
  target: {
    host: "api.anthropic.com",
    port: 443,
    passthroughHosts: ["statsig.anthropic.com", "sentry.anthropic.com"],
  },
  streamFormat: "sse",
  needsTtySpoof: true,
  stripFlags: ["-p", "--print", "--output-format", "--input-format"],
  valuelessFlags: new Set([
    "-p", "--print", "--verbose", "--no-profile", "--dangerously-skip-permissions",
  ]),
  sessionIdFlags: ["--session-id", "--resume"],
  inputMode: "arg",
  clearEnv: ANTHROPIC_CLEAR_ENV,

  session: {
    sessionArg: "--session-id",
    mode: "always",
    sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
    resumeArgs: [
      "--verbose", "--setting-sources", "user",
      "--allowedTools", "mcp__openclaw__*",
      "--resume", "{sessionId}",
    ],
  },

  model: {
    modelArg: "--model",
    aliases: {
      "opus": "claude-opus-4-8",
      "opus-4.8": "claude-opus-4-8",
      "opus-4.7": "claude-opus-4-7-20250626",
      "opus-4.6": "claude-opus-4-6-20250514",
      "sonnet": "claude-sonnet-4-6-20250514",
      "sonnet-4.6": "claude-sonnet-4-6-20250514",
      "haiku": "claude-haiku-4-5-20251001",
    },
    available: [
      "claude-opus-4-8", "claude-opus-4-7-20250626", "claude-opus-4-6-20250514",
      "claude-sonnet-4-6-20250514", "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-sonnet-4-6-20250514",
  },

  systemPrompt: {
    fileArg: "--append-system-prompt-file",
    when: "first",
  },

  bundleMcpMode: "claude-config-file",
  nativeToolMode: "always-on",
  ownsNativeCompaction: true,

  baseArgs: [
    "--verbose", "--setting-sources", "user",
    "--allowedTools", "mcp__openclaw__*",
  ],

  classifyRequest(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
        return undefined;
      }
      const msgs = parsed.messages;
      const last = msgs[msgs.length - 1];
      if (!last) return "normal";

      if (last.role === "tool" || (Array.isArray(last.content) &&
        last.content.some((b: Record<string, unknown>) =>
          typeof b.type === "string" && b.type.endsWith("_result")))) {
        return "tool_followup";
      }

      if (last.role === "user" && typeof last.content === "string" &&
        (last.content.includes("[COMPACTION SUMMARY]") ||
         last.content.includes("summarize the conversation"))) {
        return "compaction";
      }

      if (!parsed.tools || (Array.isArray(parsed.tools) && parsed.tools.length === 0)) {
        return "auxiliary";
      }

      return "normal";
    } catch {
      return undefined;
    }
  },

  extractApiError(body: string, status: number): string | undefined {
    if (status < 400) return undefined;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.error?.message ?? parsed.message ?? parsed.error;
        if (typeof msg === "string" && msg.trim()) return msg.trim();
      }
    } catch { /* not JSON */ }
    return `API error ${status}`;
  },
};
