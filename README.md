# Mittens

MITM proxy for agent CLIs. Intercepts API traffic via a local TLS proxy, taps streaming events, and re-emits them as normalized JSONL. Works as a **standalone CLI** (drop-in `claude -p` replacement) and as an **OpenClaw plugin** (registers backends for each supported CLI).

Named for the **MITM** proxy at its heart.

## Install

```bash
# Global install (gives you `mittens` and `claude-p` commands)
bun install -g mittens

# Or run directly
bunx mittens "explain what MITM means"

# OpenClaw plugin
openclaw plugins install mittens
```

## Quick start

```bash
# Drop-in replacement for claude -p (default adapter: claude)
mittens "explain quantum computing"

# Same thing, explicit
mittens --adapter=claude "explain quantum computing"

# Streaming mode (Mittens-native)
mittens --output-format stream-json "build a web server"

# Buffered JSON (matches claude -p --output-format json)
mittens --output-format json "hello"

# Also installs as claude-p for Smithers AI compatibility
claude-p "explain quantum computing"

# List available adapters
mittens --list-adapters
```

## Supported CLIs

| Adapter | CLI | API Host | TTY Spoof | Status |
|---------|-----|----------|-----------|--------|
| `claude` | Claude Code | `api.anthropic.com` | Yes | Full |
| `cursor` | Cursor | `api2.cursor.sh` | No | Stub |
| `antigravity` | Antigravity | `api.antigravity.ai` | No | Stub |

Each adapter tells the engine which API host to intercept, what stream format to tap, and what flags to strip. Adding a new CLI is one file in `src/adapters/`.

## Why

Anthropic's June 2026 policy splits Claude Max into **interactive** and **programmatic** pools. Tools that drive Claude via `claude -p` or the Agent SDK land in the metered programmatic pool. Mittens keeps that workload on the interactive subscription pool by running `claude` in interactive mode behind the TLS proxy.

For other CLIs (Cursor, Antigravity), the MITM proxy provides the same stream-intercept capability — tapping API traffic for live event streaming, logging, or re-emission — without needing the billing-pool trick.

## How it works

```
your tool --> mittens --adapter=claude <args>
                  |
                  +-- ensureCerts()      local CA + leaf (cached ~/.mittens/proxy-certs)
                  +-- startMitmProxy()   Bun TLS on 127.0.0.1, target-host-only CONNECT
                  +-- spawn <cli>        interactive mode, HTTPS_PROXY + NODE_EXTRA_CA_CERTS
                                          --> every SSE event re-emitted as JSONL
```

- **Loopback-only.** Proxy binds `127.0.0.1`, rejects non-target CONNECT requests.
- **No request/response rewriting.** Only tees the stream.
- **Cert-spoofed.** Local CA signs a leaf for the target API host; injected via `NODE_EXTRA_CA_CERTS`.
- **Interactive-billing guard** (Claude only). Strips `-p`/`--print`/`--output-format`/`--input-format` so Claude stays on the interactive billing path. TTY spoof via `tty-spoof.cjs`.

## Compared to Smithers AI `claude-p`

[`smithersai/claude-p`](https://github.com/smithersai/claude-p) is the closest prior art: a drop-in for `claude -p` using an in-process **PTY** + **Stop hook** to capture the final message.

Mittens has the same purpose but a different mechanism (**MITM TLS proxy** instead of PTY) and adds **live streaming** — Smithers is final-message-only; Mittens re-emits every event as it arrives. Mittens also generalizes beyond Claude to any agent CLI.

Both install as `claude-p` for compatibility.

## Layout

```
src/
  adapters/               per-CLI adapter definitions
    types.ts              adapter interface (MitmTarget, CliAdapter)
    index.ts              adapter registry + getAdapter()
    claude.ts             Claude Code (full: TTY spoof, request classification)
    cursor.ts             Cursor (stub)
    antigravity.ts        Antigravity (stub)
  core/                   the engine -- runs under Bun
    cli.ts                `mittens` / `claude-p` bin entry
    wrapper.ts            engine: proxy + spawn + stream-json emission
    cli-args.ts           --adapter, --output-format parsing
    output.ts             NDJSON -> requested format transform
    help.ts               --help / --version / --list-adapters
    mitm-server.ts        Bun TLS terminator + SSE tap
    cert-manager.ts       local CA / leaf cert lifecycle
    tty-spoof.cjs         keeps Claude in interactive mode
  openclaw-plugin/        OpenClaw plugin: registers all adapters as backends
    index.ts
    openclaw.plugin.json
```

## Configuration

| Env var | Fallback | Purpose |
|---------|----------|---------|
| `MITTENS_STATE_DIR` | `OPENCLAW_STATE_DIR` -> `dirname(OPENCLAW_CONFIG_PATH)` | Root for cached MITM CA/keys |
| `OPENCLAW_HOME` | `$HOME` | Home dir for `~` expansion and default state dir |
| `MITTENS_CLAUDE_BINARY` | `OPENCLAW_INTERACTIVE_CLAUDE_BINARY` | Path to `claude` |
| `MITTENS_CURSOR_BINARY` | - | Path to `cursor` |
| `MITTENS_DEBUG=1` | `OPENCLAW_INTERACTIVE_PROXY_DEBUG=1` | Verbose proxy logs |

State dir resolution: `MITTENS_STATE_DIR` > `OPENCLAW_STATE_DIR` > `dirname(OPENCLAW_CONFIG_PATH)` > `<home>/.mittens`. Relative and `~`-prefixed paths are resolved. Certs under `<state-dir>/proxy-certs`.

## Requirements

- **Bun** on PATH (TLS terminator uses `Bun.serve`)
- Target CLI installed and authenticated (e.g. `claude auth login`)

## Status

- [x] Core engine synced with OpenClaw PR [#81851](https://github.com/openclaw/openclaw/pull/81851) final
- [x] Multi-CLI adapter architecture (Claude full, Cursor/Antigravity stubs)
- [x] Standalone CLI: `mittens` + `claude-p` bin entries
- [x] OpenClaw plugin: registers all adapters as backends
- [x] 48 tests, clean typecheck
- [ ] Wire adapter interface into engine (currently hardcoded to Anthropic)
- [ ] E2E smoke test against real CLIs
- [ ] Publish to npm

## License

MIT
