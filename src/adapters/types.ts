/**
 * Adapter interface for per-CLI MITM proxy targets.
 *
 * Each adapter tells the engine:
 * - What binary to spawn and how to keep it in interactive mode
 * - Which API host(s) to intercept via the CONNECT proxy
 * - How to parse the intercepted stream into normalized events
 * - Session resume, model selection, MCP config, system prompt injection
 *
 * The engine (wrapper.ts + mitm-server.ts) handles the TLS MITM, cert
 * management, stream tap, and JSONL emission. Adapters only describe
 * the target CLI's specifics.
 *
 * Session/config fields mirror OpenClaw's CliBackendPlugin interface so
 * the Mittens plugin can register proper backends with matching semantics.
 */

export type AdapterId = "claude" | "codex" | "gemini" | "cursor" | "antigravity";

export type AdapterStreamFormat = "sse" | "ndjson";

/**
 * Engine mode for the adapter:
 * - "mitm": start HTTPS CONNECT proxy, intercept API traffic, optionally normalize
 * - "stdout": no proxy, read CLI's stdout directly (CLI provides its own stream format)
 */
export type AdapterMode = "mitm" | "stdout";

export interface MitmTarget {
  /** The API hostname to MITM (e.g. "api.anthropic.com"). */
  host: string;
  port: number;
  /** Additional hosts to tunnel through undecrypted (e.g. "statsig.anthropic.com"). */
  passthroughHosts?: string[];
  /** Route MITM traffic via HTTP/2 TLS terminator (for gRPC clients like Cursor). */
  useH2?: boolean;
  /** MITM ALL allowed hosts (not just the primary target). For CLIs that talk to multiple Google APIs. */
  mitmAll?: boolean;
  /** CLI ignores HTTPS_PROXY for API calls — need kernel-level port redirect. */
  needsKernelRedirect?: boolean;
}

// ── Session management ──

export type SessionMode = "always" | "existing" | "none";

export interface SessionConfig {
  /** How to pass a session ID to the CLI. e.g. "--session-id" */
  sessionArg?: string;
  /** Template args for session ID (supports {sessionId} placeholder). Overrides sessionArg. */
  sessionArgs?: string[];
  /** When to send session IDs: "always" (create if missing), "existing" (only reuse), "none". */
  mode: SessionMode;
  /** JSON fields in CLI output that contain the session ID. */
  sessionIdFields?: string[];
  /** Args used when resuming an existing session (supports {sessionId} placeholder). */
  resumeArgs?: string[];
}

// ── MCP config injection ──

export type BundleMcpMode = "claude-config-file" | "codex-config-overrides" | "gemini-system-settings" | "none";

// ── Model config ──

export interface ModelConfig {
  /** Flag to pass model ID to the CLI. e.g. "--model" */
  modelArg?: string;
  /** Short name -> full model ID mapping. */
  aliases?: Record<string, string>;
  /** Available model IDs this adapter can use. */
  available?: string[];
  /** Default model if none specified. */
  defaultModel?: string;
}

// ── System prompt ──

export interface SystemPromptConfig {
  /** Flag for inline system prompt. e.g. "--system" */
  inlineArg?: string;
  /** Flag for file-based system prompt. e.g. "--append-system-prompt-file" */
  fileArg?: string;
  /** When to send the system prompt: "first" (only on fresh), "always", "never". */
  when?: "first" | "always" | "never";
}

export interface CliAdapter {
  /** Unique adapter ID. */
  id: AdapterId;
  /** Human-readable name. */
  name: string;
  /** The CLI binary name (or env var override). */
  binary: string;
  /** Env var to override the binary path. */
  binaryEnvVar?: string;
  /** Engine mode: "mitm" (intercept API traffic) or "stdout" (pipe CLI stdout). */
  mode: AdapterMode;
  /** API target for the MITM proxy. Only used when mode is "mitm". */
  target?: MitmTarget;
  /** Stream format the API uses. */
  streamFormat: AdapterStreamFormat;
  /** Whether the CLI needs TTY spoofing to stay interactive. */
  needsTtySpoof: boolean;
  /** Flags to strip from passthrough argv (keeps the CLI in interactive mode). */
  stripFlags: string[];
  /** Extra flags to inject into the CLI argv (e.g. ["--output-format", "stream-json"]). */
  injectFlags?: string[];
  /** Valueless flags that don't consume the next arg. */
  valuelessFlags: Set<string>;
  /** How to detect a session ID from the argv (legacy — prefer session.sessionArg). */
  sessionIdFlags: string[];
  /**
   * Normalize a raw event (from MITM tap or stdout) into Claude stream-json
   * JSONL lines. When undefined, events are assumed to already be in Claude format.
   * For "mitm" mode: receives parsed SSE event objects.
   * For "stdout" mode: receives raw stdout lines as { _rawLine: string }.
   */
  normalizeEvent?: (evt: Record<string, unknown>) => string[];
  /**
   * Classify a request body into a type tag.
   * Returns undefined if the adapter doesn't classify requests.
   */
  classifyRequest?: (body: string) => string | undefined;
  /**
   * Check if a non-SSE response looks like an API error worth surfacing.
   * Returns the error message if so.
   */
  extractApiError?: (body: string, status: number) => string | undefined;
  /** Whether this adapter tracks Claude-style session files for kill signalling. */
  hasSessionFiles?: boolean;
  /** Env vars to set (or clear with "") when spawning the CLI. Applied after
   *  the default env construction so they override proxy/NODE_OPTIONS etc. */
  envOverrides?: Record<string, string>;
  /** Env vars to CLEAR (remove) from the child process. Auth vars that would
   *  conflict with OpenClaw's auth profile injection. */
  clearEnv?: string[];

  // ── OpenClaw-mirrored session/config fields ──

  /** Session resume configuration. */
  session?: SessionConfig;
  /** Model selection configuration. */
  model?: ModelConfig;
  /** System prompt injection configuration. */
  systemPrompt?: SystemPromptConfig;
  /** How MCP config is passed to this CLI. */
  bundleMcpMode?: BundleMcpMode;
  /** Whether this CLI supports native tool use (MCP tools, etc). */
  nativeToolMode?: "none" | "always-on";
  /** Whether this CLI handles its own context compaction. */
  ownsNativeCompaction?: boolean;
  /** How the CLI takes user input: "arg" (positional), "stdin" (piped). */
  inputMode?: "arg" | "stdin";
  /** Fresh-run args (before session/model/prompt injection). */
  baseArgs?: string[];
}
