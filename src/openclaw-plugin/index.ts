/**
 * Mittens OpenClaw plugin.
 *
 * Registers CLI backends for each supported adapter so the MITM proxy +
 * stream-json normalisation is available to OpenClaw as installable
 * providers. Each backend mirrors OpenClaw's CliBackendPlugin interface
 * with proper session resume, model selection, and MCP config injection.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { type CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import { listAdapters, type CliAdapter } from "../adapters/index.js";

function resolveWrapperPath(): string {
  const selfUrl = import.meta.url;
  const jsPath = fileURLToPath(new URL("../core/wrapper.js", selfUrl));
  if (existsSync(jsPath)) return jsPath;
  return fileURLToPath(new URL("../core/wrapper.ts", selfUrl));
}

const WRAPPER_PATH = resolveWrapperPath();
const MAX_PROMPT_ARG_CHARS = process.platform === "win32" ? 30000 : 200000;

function buildBackendForAdapter(adapter: CliAdapter): CliBackendPlugin {
  const sessionArg = adapter.session?.sessionArg;
  const sessionArgs = adapter.session?.sessionArgs;
  const sessionMode = adapter.session?.mode ?? "none";
  const sessionIdFields = adapter.session?.sessionIdFields;
  const modelArg = adapter.model?.modelArg;
  const modelAliases = adapter.model?.aliases;

  const freshArgs = [
    WRAPPER_PATH,
    `--adapter=${adapter.id}`,
    ...(adapter.baseArgs ?? []),
  ];

  const resumeArgs = adapter.session?.resumeArgs
    ? [WRAPPER_PATH, `--adapter=${adapter.id}`, ...adapter.session.resumeArgs]
    : undefined;

  const env: Record<string, string> = {};
  if (adapter.envOverrides) {
    Object.assign(env, adapter.envOverrides);
  }

  return {
    id: `mittens-${adapter.id}`,
    modelProvider: adapter.id === "claude" ? "anthropic"
      : adapter.id === "gemini" || adapter.id === "antigravity" ? "google"
      : adapter.id === "codex" ? "openai"
      : adapter.id,
    inheritUserConfigFrom: adapter.id === "claude"
      ? { backendId: "claude-cli" }
      : undefined,
    nativeToolMode: adapter.nativeToolMode ?? "always-on",
    ownsNativeCompaction: adapter.ownsNativeCompaction,
    bundleMcp: adapter.bundleMcpMode !== "none" && adapter.bundleMcpMode !== undefined,
    bundleMcpMode: adapter.bundleMcpMode !== "none" ? adapter.bundleMcpMode : undefined,
    config: {
      command: "bun",
      args: freshArgs,
      ...(resumeArgs ? { resumeArgs } : {}),
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: adapter.inputMode ?? "arg",
      maxPromptArgChars: MAX_PROMPT_ARG_CHARS,
      ...(modelArg ? { modelArg } : {}),
      ...(modelAliases ? { modelAliases } : {}),
      ...(sessionArg ? { sessionArg } : {}),
      ...(sessionArgs ? { sessionArgs } : {}),
      sessionMode,
      ...(sessionIdFields ? { sessionIdFields } : {}),
      ...(adapter.systemPrompt?.fileArg ? {
        systemPromptFileArg: adapter.systemPrompt.fileArg,
        systemPromptWhen: adapter.systemPrompt.when ?? "first",
      } : {}),
      ...(adapter.systemPrompt?.inlineArg ? {
        systemPromptArg: adapter.systemPrompt.inlineArg,
        systemPromptWhen: adapter.systemPrompt.when ?? "first",
      } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(adapter.clearEnv?.length ? { clearEnv: adapter.clearEnv } : {}),
      serialize: true,
      reliability: {
        watchdog: {
          fresh: { noOutputTimeoutMs: 120_000 },
          resume: { noOutputTimeoutMs: 60_000 },
        },
      },
    },
  };
}

export default definePluginEntry({
  id: "mittens",
  name: "Mittens",
  description: "MITM proxy backends for agent CLIs — intercept API traffic, normalise to Claude stream-json, keep interactive billing",
  register(api) {
    for (const adapter of listAdapters()) {
      api.registerCliBackend(buildBackendForAdapter(adapter));
    }
  },
});
