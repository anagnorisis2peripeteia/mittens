# Mittens

MITM proxy for agent CLIs. Intercepts API traffic from **5 agent CLIs** via a local TLS proxy, normalises all protocols to Claude `stream-json` JSONL, and re-emits them as a unified event stream. Works as a **standalone CLI** (drop-in `claude -p` replacement) and as an **OpenClaw plugin** (registers each CLI as a backend).

Named for the **MITM** proxy at its heart.

## Supported CLIs

| Adapter | CLI | Protocol | API Host | Normaliser |
|---------|-----|----------|----------|------------|
| `claude` | Claude Code | SSE/HTTP1.1 | `api.anthropic.com` | Native (no transform) |
| `gemini` | Gemini CLI | SSE/HTTP1.1 | `cloudcode-pa.googleapis.com` | `gemini-normalizer.ts` |
| `codex` | Codex CLI | WebSocket | `chatgpt.com` | `codex-normalizer.ts` |
| `cursor` | Cursor | gRPC/HTTP2 | `agentn.global.api5.cursor.sh` | `cursor-normalizer.ts` |
| `antigravity` | Antigravity | gRPC/HTTP2 | `www.googleapis.com` | `gemini-normalizer.ts` (shared) |

All 5 CLIs proven end-to-end. Every adapter produces identical `stream-json` JSONL output regardless of the underlying protocol.

## Install

```bash
# Global install (gives you `mittens` and `claude-p` commands)
bun install -g mittens

# Or run directly
bunx mittens "explain what MITM means"

# OpenClaw plugin
openclaw plugins install clawhub:mittens
```

## Quick start

```bash
# Drop-in replacement for claude -p (default adapter: claude)
mittens "explain quantum computing"

# Use a different CLI backend
mittens --adapter=gemini "explain quantum computing"
mittens --adapter=codex "build a web server"
mittens --adapter=cursor "refactor this function"

# Streaming mode (default)
mittens --output-format stream-json "build a web server"

# Buffered JSON (matches claude -p --output-format json)
mittens --output-format json "hello"

# Also installs as claude-p for Smithers AI compatibility
claude-p "explain quantum computing"

# List available adapters
mittens --list-adapters
```

## Why

Anthropic's June 2026 policy splits Claude Max into **interactive** and **programmatic** pools. Tools that drive Claude via `claude -p` or the Agent SDK land in the metered programmatic pool. Mittens keeps that workload on the interactive subscription pool by running `claude` in interactive mode behind the TLS proxy.

For other CLIs (Gemini, Codex, Cursor, Antigravity), the MITM proxy provides the same stream-intercept capability — tapping API traffic for live event streaming, logging, or re-emission as normalised JSONL — without needing the billing-pool trick.

## How it works

```
your tool --> mittens --adapter=<cli> <args>
                  |
                  +-- ensureCerts()        local CA + per-host leaf via SNI (cached ~/.mittens/proxy-certs)
                  +-- startMitmProxy()     dual TLS terminators on 127.0.0.1:
                  |     +-- Bun.serve      HTTP/1.1 (SSE + WebSocket) for Claude/Gemini/Codex
                  |     +-- tls+http2      HTTP/2 (gRPC) for Cursor/Antigravity
                  +-- setupRedirect()      kernel port redirect (iptables/pfctl/WSL) for gRPC CLIs
                  +-- spawn <cli>          interactive mode, HTTPS_PROXY + NODE_EXTRA_CA_CERTS
                                            --> every event normalised to Claude stream-json JSONL
```

### Architecture

- **Dual TLS terminators.** `Bun.serve` handles HTTP/1.1 (SSE clients). `tls.createServer` + `http2.createServer` handles HTTP/2 (gRPC clients like Cursor). Both share the upstream relay and event tap.
- **SNI dynamic certs.** `ensureLeafCert()` generates per-hostname leaf certs on demand for multi-host interception (`mitmAll` mode).
- **Kernel-level redirect.** gRPC CLIs that ignore `HTTPS_PROXY` get their :443 traffic redirected at the OS level — `iptables` on Linux, `pfctl` on macOS, WSL iptables on Windows.
- **Loopback-only.** Proxy binds `127.0.0.1`, refuses non-target CONNECT requests.
- **No request/response rewriting.** Only tees the stream.
- **Per-CLI normalisation.** Each adapter has an optional `normalizeEvent()` that transforms native protocol events into Claude `stream-json` format.

### Key discoveries

- **Codex** uses the OpenAI Responses API over WebSocket to `chatgpt.com`. Two-phase protocol (generate:false for reasoning, generate:true for tool calls). Reasoning is server-side encrypted.
- **Gemini CLI** sends thinking tokens in plaintext SSE.
- **Cursor** uses gRPC/HTTP2 with protobuf frames. Required the dual-terminator architecture.
- **Antigravity** (Go binary) ignores `HTTPS_PROXY` for gRPC API calls; only honours it for HTTP/1.1 setup calls. Required kernel-level redirect + PTY spoofing via `socat`.

## OpenClaw plugin

Mittens registers 5 CLI backends with OpenClaw's `CliBackendPlugin` interface. Each backend declares its session resume mechanism, model aliases, MCP config mode, and system prompt injection — so the OpenClaw gateway treats them identically to `claude-cli`.

```bash
# Switch backend in a session
/model mittens-gemini
/model mittens-codex
/model mittens-cursor
```

The plugin uses the same wrapper + normaliser chain as the standalone CLI. From the gateway's perspective, every backend is just another `claude-stream-json` JSONL pipe.

## Compared to Smithers AI `claude-p`

[`smithersai/claude-p`](https://github.com/smithersai/claude-p) is the closest prior art: a drop-in for `claude -p` using an in-process **PTY** + **Stop hook** to capture the final message.

Mittens has the same purpose but a different mechanism (**MITM TLS proxy** instead of PTY) and adds **live streaming** — Smithers is final-message-only; Mittens re-emits every event as it arrives. Mittens also generalises beyond Claude to any agent CLI.

Both install as `claude-p` for compatibility.

## Layout

```
src/
  adapters/                 per-CLI adapter definitions
    types.ts                adapter interface (MitmTarget, CliAdapter, SessionConfig, ModelConfig)
    index.ts                adapter registry + getAdapter() + listAdapters()
    claude.ts               Claude Code (SSE, TTY spoof, request classification, session files)
    gemini.ts               Gemini CLI (SSE, Google API)
    codex.ts                Codex CLI (WebSocket, OpenAI Responses API)
    cursor.ts               Cursor (gRPC/HTTP2, kernel redirect)
    antigravity.ts          Antigravity (gRPC/HTTP2, kernel redirect, PTY via socat)
    gemini-normalizer.ts    Google SSE -> Claude stream-json
    codex-normalizer.ts     OpenAI WebSocket -> Claude stream-json
    cursor-normalizer.ts    Cursor gRPC proto -> Claude stream-json
  core/                     the engine -- runs under Bun
    cli.ts                  `mittens` / `claude-p` bin entry
    wrapper.ts              engine: proxy + spawn + normalise + stream-json emission
    cli-args.ts             --adapter, --output-format parsing
    output.ts               NDJSON -> requested format transform
    help.ts                 --help / --version / --list-adapters
    mitm-server.ts          dual TLS terminators (h1 Bun.serve + h2 tls/http2) + event tap
    cert-manager.ts         local CA / per-host leaf cert lifecycle + SNI callback
    platform-redirect.ts    cross-platform kernel port redirect (iptables/pfctl/WSL)
    tty-spoof.cjs           keeps Node CLIs in interactive mode
    mitm-capture.ts         diagnostic traffic capture tool
  openclaw-plugin/          OpenClaw plugin: registers all adapters as backends
    index.ts
    openclaw.plugin.json
```

## Configuration

| Env var | Fallback | Purpose |
|---------|----------|---------|
| `MITTENS_STATE_DIR` | `OPENCLAW_STATE_DIR` -> `dirname(OPENCLAW_CONFIG_PATH)` | Root for cached MITM CA/keys |
| `OPENCLAW_HOME` | `$HOME` | Home dir for `~` expansion and default state dir |
| `MITTENS_CLAUDE_BINARY` | `OPENCLAW_INTERACTIVE_CLAUDE_BINARY` | Path to `claude` |
| `MITTENS_DEBUG=1` | `OPENCLAW_INTERACTIVE_PROXY_DEBUG=1` | Verbose proxy logs |

Each adapter also supports a `MITTENS_<ADAPTER>_BINARY` env var (e.g. `MITTENS_CURSOR_BINARY`).

State dir resolution: `MITTENS_STATE_DIR` > `OPENCLAW_STATE_DIR` > `dirname(OPENCLAW_CONFIG_PATH)` > `<home>/.mittens`. Certs under `<state-dir>/proxy-certs`.

## Requirements

- **Bun** on PATH (TLS terminator uses `Bun.serve`)
- Target CLI installed and authenticated
- **Linux/macOS/WSL**: `sudo` for kernel redirect (gRPC adapters only)
- **Windows**: WSL with iptables for Cursor/Antigravity redirect

## Status

- [x] All 5 CLI adapters implemented and proven E2E
- [x] Dual TLS terminators (h1 SSE/WebSocket + h2 gRPC)
- [x] SNI dynamic cert generation for multi-host interception
- [x] Cross-platform kernel redirect (Linux iptables, macOS pfctl, Windows WSL)
- [x] 3 normalizers (Gemini SSE, Codex WebSocket, Cursor gRPC)
- [x] OpenClaw plugin with full session/model/MCP config per adapter
- [x] Standalone CLI: `mittens` + `claude-p` bin entries
- [x] 52 tests, zero type errors

## License

MIT
