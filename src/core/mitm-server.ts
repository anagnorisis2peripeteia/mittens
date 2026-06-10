/* oxlint-disable no-underscore-dangle -- `_reqId` / `_requestType` are
   intentional namespace markers on proxy-internal JSON events that flow
   between this server and wrapper.ts, distinguishing proxy-added fields
   from upstream Anthropic API fields. */
/**
 * Two-stage MITM proxy for intercepting Claude CLI's API stream.
 *
 * Stage 1 — HTTP CONNECT proxy: receives CONNECT api.anthropic.com:443 from
 * claude.exe (via HTTPS_PROXY env var) and redirects the tunnel to Stage 2.
 *
 * Stage 2 — Bun TLS server: terminates TLS using our CA-signed leaf cert
 * (trusted by claude via NODE_EXTRA_CA_CERTS), reads plaintext SSE, fires
 * every parsed event to registered handlers, then forwards the unmodified
 * stream upstream.
 *
 * Trust boundary: the CONNECT proxy fails closed. Only `api.anthropic.com`
 * is MITM'd (decrypted); other Anthropic-owned hosts (e.g. statsig.anthropic.com)
 * are tunneled through unchanged WITHOUT decryption; any non-Anthropic CONNECT
 * target is refused with 403. This keeps the loopback proxy from acting as a
 * general open forward proxy while it is alive — it only ever carries the
 * spawned claude process's Anthropic traffic.
 */
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import type { CertPaths } from "./cert-manager.js";
import { ensureLeafCert } from "./cert-manager.js";
import { classifyRequest, type ClassifyState, type RequestType } from "./request-classifier.js";

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

const NODE_UPSTREAM_SCRIPT = fileURLToPath(new URL("./node-upstream.cjs", import.meta.url));

function nodeHttpsRequest(url: string, opts: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<Response> {
  const parsed = new URL(url);
  const payload = JSON.stringify({
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
  });

  return new Promise((resolve) => {
    const child = spawnChild("node", [NODE_UPSTREAM_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    child.stdin!.write(payload);
    child.stdin!.end();

    let headerResolved = false;
    let buf = Buffer.alloc(0);
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    child.stdout!.on("data", (chunk: Buffer) => {
      if (streamController) {
        streamController.enqueue(new Uint8Array(chunk));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const str = buf.toString();
      // eslint-disable-next-line no-console
      if (!headerResolved) console.warn(`[node-relay] stdout chunk ${chunk.length}b, buf total ${buf.length}b, starts="${str.slice(0,20)}"`);

      if (str.startsWith("SSE_HEADER:")) {
        const nlIdx = str.indexOf("\n");
        if (nlIdx < 0) return;
        headerResolved = true;
        const headerLine = str.slice("SSE_HEADER:".length, nlIdx);
        const hdr = JSON.parse(headerLine);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(hdr.headers ?? {})) {
          if (typeof value === "string") responseHeaders.set(key, value);
        }
        const rest = buf.slice(Buffer.byteLength(str.slice(0, nlIdx + 1)));
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            if (rest.length > 0) controller.enqueue(new Uint8Array(rest));
          },
        });
        resolve(new Response(stream, { status: hdr.status ?? 200, headers: responseHeaders }));
      }
    });

    child.on("exit", () => {
      if (streamController) {
        try { streamController.close(); } catch {}
        return;
      }
      if (headerResolved) return;
      headerResolved = true;
      const raw = buf.toString();
      try {
        const result = JSON.parse(raw);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(result.headers ?? {})) {
          if (typeof value === "string") responseHeaders.set(key, value);
        }
        resolve(new Response(result.body ?? "", {
          status: result.status ?? 502,
          headers: responseHeaders,
        }));
      } catch {
        resolve(new Response("Bad Gateway", { status: 502 }));
      }
    });

    child.on("error", (e) => {
      // eslint-disable-next-line no-console
      console.warn("[node-relay] child error:", e);
      if (streamController) {
        try { streamController.close(); } catch {}
      } else if (!headerResolved) {
        headerResolved = true;
        resolve(new Response("Bad Gateway", { status: 502 }));
      }
    });
  });
}

export type MitmProxyHandle = {
  connectPort: number;
  tlsPort: number;
  /** HTTP/2 TLS terminator port (for gRPC clients via kernel redirect). */
  h2Port: number;
  onEvent: (handler: (evt: Record<string, unknown>) => void) => void;
  stop: () => Promise<void>;
};

const DEFAULT_UPSTREAM_HOST = "api.anthropic.com";
const DEFAULT_UPSTREAM_PORT = 443;

export type MitmTargetConfig = {
  host: string;
  port?: number;
  passthroughSuffixes?: string[];
  /** Bind address for the CONNECT proxy. Default "127.0.0.1"; use "0.0.0.0" for WSL. */
  bindAddress?: string;
  /** Route MITM traffic to the HTTP/2 TLS terminator (for gRPC clients). Default: false (HTTP/1.1). */
  useH2?: boolean;
  /** MITM ALL allowed hosts (not just the primary target). Requires SNI-based dynamic certs. */
  mitmAll?: boolean;
  /** Per-adapter PRIMARY spawner tool names, forwarded to the request classifier
   *  so a renamed/disguised spawner is still recognized as the primary turn. */
  spawnerToolNames?: readonly string[];
  /** Per-adapter sub-agent system-prompt markers (enables the by-presence
   *  sub-agent layer in the classifier). */
  subagentSystemMarkers?: readonly string[];
};

export function isAllowedConnectHost(host: string, target?: MitmTargetConfig): boolean {
  const normalized = host.trim().toLowerCase();
  const mitmHost = (target?.host ?? DEFAULT_UPSTREAM_HOST).toLowerCase();
  if (normalized === mitmHost) return true;
  const domain = mitmHost.split(".").slice(-2).join(".");
  if (normalized.endsWith(`.${domain}`)) return true;
  const suffixes = target?.passthroughSuffixes ?? [];
  return suffixes.some(s => normalized === s || normalized.endsWith(s));
}

export function isApiConnectHost(host: string, target?: MitmTargetConfig): boolean {
  return host.trim().toLowerCase() === (target?.host ?? DEFAULT_UPSTREAM_HOST).toLowerCase();
}

export async function startMitmProxy(certs: CertPaths, target?: MitmTargetConfig): Promise<MitmProxyHandle> {
  const upstreamHost = target?.host ?? DEFAULT_UPSTREAM_HOST;
  const upstreamPort = target?.port ?? DEFAULT_UPSTREAM_PORT;
  const bunRejectedHosts = new Set<string>();
  const eventHandlers: Array<(evt: Record<string, unknown>) => void> = [];
  // Monotonic per-request identifier. claude-code can hold multiple
  // /v1/messages requests in flight concurrently (a real user turn racing
  // with an aux title-gen request, for instance). The wrapper uses _reqId
  // to bind every SSE event back to its originating request so events
  // from a concurrent aux call can't leak into the active turn's
  // accumulator. Reset is unnecessary — the counter only needs to be
  // unique within a single wrapper invocation's lifetime.
  let nextReqId = 1;
  // Per-run classifier state (primary-spawner-seen), threaded into the layered
  // classifyRequest so an Agent-less request stays primary until a spawner is
  // seen — gating the by-absence sub-agent layer against mis-suppression/hangs.
  const classifyState: ClassifyState = { primarySpawnerSeen: false };
  // Track last stop_reason across requests. After "max_tokens", the next
  // request is either a higher-limit retry (same last user msg) or compaction
  // (new compaction prompt as last user msg — caught by content markers).
  // Kept for future heuristics; not used as a standalone classifier because
  // max_output_tokens_recovery also follows max_tokens and we'd misclassify
  // legitimate retries as compaction.
  let lastStopReason = "";

  function emitEvent(evt: Record<string, unknown>): void {
    for (const h of eventHandlers) {
      h(evt);
    }
    if (evt.type === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") {
        lastStopReason = delta.stop_reason;
      }
    }
  }

  // Stage 2 — Dual TLS terminators for protocol compatibility.
  // Bun.serve handles HTTP/1.1 (SSE clients like Claude/Gemini).
  // http2.createSecureServer handles HTTP/2 (gRPC clients like Cursor/Antigravity).
  // Both share the same upstream relay + event tap logic.
  const leafKey = readFileSync(certs.leafKeyPath);
  const leafCert = readFileSync(certs.leafCertPath);
  const caKey = readFileSync(certs.caKeyPath);
  const caCert = readFileSync(certs.caPath);

  // Dynamic SNI callback: generate leaf certs per-hostname on the fly
  const defaultCtx = tls.createSecureContext({ key: leafKey, cert: leafCert });
  const sniCtxCache = new Map<string, ReturnType<typeof tls.createSecureContext>>();

  function sniCallback(hostname: string, cb: (err: Error | null, ctx?: ReturnType<typeof tls.createSecureContext>) => void): void {
    const cached = sniCtxCache.get(hostname);
    if (cached) { cb(null, cached); return; }

    const leafPair = ensureLeafCert(hostname);
    if (!leafPair) { cb(null, defaultCtx); return; }

    const ctx = tls.createSecureContext({ key: leafPair.key, cert: leafPair.cert });
    sniCtxCache.set(hostname, ctx);
    cb(null, ctx);
  }

  // SNI-aware TLS front door for h2 clients.
  // Bun's http2.createSecureServer doesn't fire SNICallback, so we use
  // tls.createServer (which does) and emit decrypted sockets into a
  // plain http2.createServer via the 'connection' event.
  const h2PlainServer = http2.createServer({
    settings: { enableConnectProtocol: true },
  });

  const sniTlsServer = tls.createServer({
    key: leafKey,
    cert: leafCert,
    SNICallback: sniCallback,
    ALPNProtocols: ["h2", "http/1.1"],
  }, (tlsSocket: tls.TLSSocket) => {
    // Hand the decrypted socket to the h2 server
    h2PlainServer.emit("connection", tlsSocket);
  });

  const h2Server = sniTlsServer;

  // HTTP/1.1 TLS server (Bun.serve for SSE + WebSocket clients)
  const h1Server = Bun.serve({
    port: 0,
    hostname: target?.bindAddress ?? "127.0.0.1",
    idleTimeout: 0,
    tls: { key: leafKey.toString(), cert: leafCert.toString() },
    async fetch(req: Request, server: BunServer): Promise<Response | undefined> {
      // WebSocket upgrade
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(req.url);
        const wsReqId = nextReqId++;
        const wsHeaders: Record<string, string> = {};
        req.headers.forEach((value: string, key: string) => {
          const lower = key.toLowerCase();
          if (lower !== "upgrade" && lower !== "connection" &&
              lower !== "sec-websocket-key" && lower !== "sec-websocket-version" &&
              lower !== "sec-websocket-extensions" && lower !== "sec-websocket-protocol") {
            wsHeaders[key] = value;
          }
        });
        wsHeaders["host"] = upstreamHost;
        const upgraded = server.upgrade(req, {
          data: { upstreamUrl: `https://${upstreamHost}${url.pathname}${url.search}`, reqId: wsReqId, headers: wsHeaders },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      const url = new URL(req.url);
      const reqPath = url.pathname + url.search;
      const method = req.method;
      const bodyChunks: Buffer[] = [];
      if (req.body) {
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bodyChunks.push(Buffer.from(value));
        }
      }
      const headers: Record<string, string | string[] | undefined> = {};
      req.headers.forEach((v: string, k: string) => { headers[k] = v; });

      return new Promise<Response>((resolve) => {
        handleRequest(headers, method, reqPath, bodyChunks, (status, respHeaders, body) => {
          resolve(new Response(body as unknown as BodyInit, { status, headers: respHeaders }));
        });
      });
    },
    websocket: {
      open(ws: BunServerWebSocket) {
        const { upstreamUrl, reqId, headers } = ws.data as {
          upstreamUrl: string; reqId: number; headers: Record<string, string>;
        };
        const wsUrl = upstreamUrl.replace(/^https:/, "wss:");
        emitEvent({ type: "ws_open", _reqId: reqId, url: wsUrl });

        const upstream = new WebSocket(wsUrl, { headers } as never);
        const pendingMessages: string[] = [];
        (ws as unknown as Record<string, unknown>)._upstream = upstream;
        (ws as unknown as Record<string, unknown>)._pending = pendingMessages;

        upstream.onopen = () => {
          emitEvent({ type: "ws_upstream_open", _reqId: reqId });
          for (const msg of pendingMessages) upstream.send(msg);
          pendingMessages.length = 0;
        };
        upstream.onmessage = (event) => {
          const data = typeof event.data === "string" ? event.data : "";
          try {
            const parsed = JSON.parse(data);
            parsed._reqId = reqId;
            parsed._source = "upstream";
            emitEvent(parsed);
          } catch {
            emitEvent({ type: "ws_message", _reqId: reqId, _source: "upstream", raw: data.slice(0, 2000) });
          }
          ws.send(data);
        };
        upstream.onerror = (err) => {
          emitEvent({ type: "ws_error", _reqId: reqId, _source: "upstream", error: String(err) });
        };
        upstream.onclose = (event) => {
          emitEvent({ type: "ws_close", _reqId: reqId, _source: "upstream", code: event.code });
          ws.close(event.code, event.reason);
        };
      },
      message(ws: BunServerWebSocket, message: string | ArrayBuffer) {
        const { reqId } = ws.data as { reqId: number };
        const data = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer);
        try {
          const parsed = JSON.parse(data);
          parsed._reqId = reqId;
          parsed._source = "client";
          emitEvent(parsed);
        } catch {
          emitEvent({ type: "ws_message", _reqId: reqId, _source: "client", raw: data.slice(0, 2000) });
        }
        const upstream = (ws as unknown as Record<string, unknown>)._upstream as WebSocket | undefined;
        const pending = (ws as unknown as Record<string, unknown>)._pending as string[] | undefined;
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data);
        } else if (pending) {
          pending.push(data);
        }
      },
      close(ws: BunServerWebSocket, code: number, reason: string) {
        const { reqId } = ws.data as { reqId: number };
        emitEvent({ type: "ws_close", _reqId: reqId, _source: "client", code });
        const upstream = (ws as unknown as Record<string, unknown>)._upstream as WebSocket | undefined;
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.close(code, reason);
        }
      },
    },
  });

  // Merge both into a single logical "TLS server"
  const tlsServer = { h1: h1Server, h2: h2Server };

  // Shared request handler for both HTTP/2 streams and HTTP/1.1 requests
  async function handleRequest(
    reqHeaders: Record<string, string | string[] | undefined>,
    reqMethod: string,
    reqPath: string,
    reqBodyChunks: Buffer[],
    respond: (status: number, headers: Record<string, string>, body: Buffer | NodeJS.ReadableStream) => void,
  ): Promise<void> {
    const upstreamUrl = `https://${upstreamHost}${reqPath}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (k.startsWith(":")) continue;
      const val = Array.isArray(v) ? v[0] : v;
      if (val) headers[k] = val;
    }
    headers["host"] = upstreamHost;
    headers["accept-encoding"] = "identity";
    for (const hop of ["connection", "keep-alive", "proxy-connection", "upgrade", "te", "trailer", "transfer-encoding"]) {
      delete headers[hop];
    }

    const reqBody = reqBodyChunks.length > 0 ? Buffer.concat(reqBodyChunks).toString("utf8") : undefined;
    // Classify the outbound request so the wrapper can route the SSE stream
    // (see classifyRequest for the layered primary-vs-subagent logic). The only
    // downstream effect is which streams are tagged "subagent" (turn-end
    // suppressed) vs the user-facing "normal"/"tool_followup" turn.
    let requestType: RequestType = "normal";
    if (reqMethod === "POST" && reqBody) {
      requestType = classifyRequest(reqBody, classifyState, {
        spawnerToolNames: target?.spawnerToolNames,
        subagentSystemMarkers: target?.subagentSystemMarkers,
      });
    }

    const reqId = nextReqId++;

    if (reqMethod === "POST" && reqBody) {
      try {
        emitEvent({ type: "request", _reqId: reqId, _requestType: requestType, path: reqPath, bodyLength: reqBody.length });
      } catch {}
    }

    let upstream: Response;
    try {
      const needsNodeRelay = bunRejectedHosts.has(upstreamHost);
      if (needsNodeRelay) {
        upstream = await nodeHttpsRequest(upstreamUrl, { method: reqMethod, headers, body: reqBody });
      } else {
        upstream = await fetch(new Request(upstreamUrl, {
          method: reqMethod,
          headers,
          body: reqBody !== undefined ? reqBody : undefined,
        }));
        if (upstream.status === 403 && !upstream.headers.has("content-type") && !upstream.headers.has("server")) {
          bunRejectedHosts.add(upstreamHost);
          upstream = await nodeHttpsRequest(upstreamUrl, { method: reqMethod, headers, body: reqBody });
        }
      }
    } catch (upstreamErr) {
      console.warn("[mittens-proxy] upstream CATCH:", upstreamErr);
      respond(502, { "content-type": "text/plain" }, Buffer.from("Bad Gateway"));
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isSSE = contentType.includes("text/event-stream");
    const isApiEndpoint = reqMethod === "POST";
    const status = upstream.status;
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (kl !== "connection" && kl !== "keep-alive" && kl !== "transfer-encoding" && kl !== "trailer") {
        respHeaders[k] = v;
      }
    });

    if (!isSSE || !upstream.body || !isApiEndpoint) {
      if (isApiEndpoint && upstream.body) {
        const bodyBytes = Buffer.from(await upstream.arrayBuffer());
        const isBinary = contentType.includes("application/proto")
          || contentType.includes("application/grpc")
          || contentType.includes("application/octet-stream");
        let parsedBody: unknown;
        if (isBinary) {
          parsedBody = { _binary: true, contentLength: bodyBytes.byteLength, preview: bodyBytes.subarray(0, 256).toString("base64") };
        } else {
          const bodyText = bodyBytes.toString("utf8");
          parsedBody = bodyText;
          try { parsedBody = JSON.parse(bodyText); } catch {}
        }
        if (status >= 400) {
          emitEvent({ type: "api_error", _reqId: reqId, status, path: reqPath, body: parsedBody });
        } else {
          emitEvent({ type: "api_response", _reqId: reqId, status, path: reqPath, contentType, body: parsedBody });
        }
        respond(status, respHeaders, bodyBytes);
        return;
      }
      if (upstream.body) {
        const bodyBytes = Buffer.from(await upstream.arrayBuffer());
        respond(status, respHeaders, bodyBytes);
      } else {
        respond(status, respHeaders, Buffer.alloc(0));
      }
      return;
    }

    // SSE stream: tap every event and pass through unchanged
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let textBuf = "";
    const chunks: Buffer[] = [];

    const pump = async (): Promise<Buffer> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));

        textBuf += decoder.decode(value, { stream: true });
        const lines = textBuf.split("\n");
        textBuf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            evt._reqId = reqId;
            evt._requestType = requestType;
            emitEvent(evt);
          } catch {}
        }
      }
      return Buffer.concat(chunks);
    };

    const fullBody = await pump();
    respond(status, respHeaders, fullBody);
  }

  // HTTP/2 stream handler
  // HTTP/2 stream handler — bidirectional streaming proxy with gRPC frame tap.
  // Connects to the real upstream via a separate h2 session and pipes data
  // both directions, tapping response frames to emit events.
  h2PlainServer.on("stream", (clientStream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const method = (headers[":method"] as string) ?? "GET";
    const path = (headers[":path"] as string) ?? "/";
    const authority = (headers[":authority"] as string) ?? upstreamHost;
    const contentType = (headers["content-type"] as string) ?? "";
    const reqId = nextReqId++;
    const isGrpc = contentType.includes("application/grpc") || contentType.includes("application/connect");
    process.stderr.write(`[h2-stream] ${method} ${authority}${path} ct=${contentType.substring(0, 40)}\n`);

    // Build upstream headers — use the original :authority (client's target host)
    // so mitmAll routes each request to the correct upstream, not just upstreamHost.
    const originalAuthority = (headers[":authority"] as string) ?? upstreamHost;
    const upstreamHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k === ":scheme") continue;
      const val = Array.isArray(v) ? v[0] : v;
      if (val !== undefined) upstreamHeaders[k] = val as string;
    }

    // Connect to the REAL upstream host (not the configured MITM target)
    const upstreamSession = http2.connect(`https://${originalAuthority}`);
    const upstreamStream = upstreamSession.request(upstreamHeaders);

    // Pipe client request body -> upstream
    const reqBodyChunks: Buffer[] = [];
    clientStream.on("data", (chunk: Buffer) => {
      reqBodyChunks.push(chunk);
      upstreamStream.write(chunk);
    });
    clientStream.on("end", () => {
      // Emit request event with body size
      const totalLen = reqBodyChunks.reduce((a, c) => a + c.length, 0);
      emitEvent({ type: "request", _reqId: reqId, _requestType: "normal", path, bodyLength: totalLen, isGrpc });
      upstreamStream.end();
    });

    // Upstream response headers -> client
    upstreamStream.on("response", (respHeaders) => {
      const status = respHeaders[":status"] ?? 200;
      const fwdHeaders: Record<string, string | number> = { ":status": status as number };
      for (const [k, v] of Object.entries(respHeaders)) {
        if (k === ":status") continue;
        const val = Array.isArray(v) ? v[0] : v;
        if (val !== undefined) fwdHeaders[k] = val as string;
      }
      try { clientStream.respond(fwdHeaders); } catch {}
    });

    // Upstream response data -> client, with tap
    let grpcBuf = Buffer.alloc(0);
    upstreamStream.on("data", (chunk: Buffer) => {
      // Pass through to client immediately
      try { clientStream.write(chunk); } catch {}

      if (isGrpc) {
        // Parse gRPC frames: 5-byte header (1 compressed + 4 length) + payload
        grpcBuf = Buffer.concat([grpcBuf, chunk]);
        while (grpcBuf.length >= 5) {
          const compressed = grpcBuf[0];
          const frameLen = grpcBuf.readUInt32BE(1);
          if (grpcBuf.length < 5 + frameLen) break;
          const payload = grpcBuf.subarray(5, 5 + frameLen);
          grpcBuf = grpcBuf.subarray(5 + frameLen);

          // Try JSON first (connectrpc often uses JSON), then emit raw
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload.toString("utf8"));
          } catch {
            parsed = { _binary: true, compressed: compressed !== 0, length: frameLen, preview: payload.subarray(0, 256).toString("base64") };
          }
          emitEvent({ type: "grpc_frame", _reqId: reqId, path, body: parsed });
        }
      } else {
        // SSE or other text — parse data: lines
        const text = chunk.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            evt._reqId = reqId;
            evt._requestType = "normal";
            emitEvent(evt);
          } catch {}
        }
      }
    });

    upstreamStream.on("end", () => {
      try { clientStream.end(); } catch {}
      upstreamSession.close();
    });

    upstreamStream.on("error", (err) => {
      emitEvent({ type: "h2_error", _reqId: reqId, path, error: String(err) });
      try { clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch {}
      upstreamSession.close();
    });

    clientStream.on("error", () => {
      upstreamStream.close();
      upstreamSession.close();
    });
  });

  // Bind h2 server
  const bindAddr = target?.bindAddress ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    sniTlsServer.listen(0, bindAddr, () => resolve());
    sniTlsServer.on("error", reject);
  });
  const h2Addr = sniTlsServer.address();
  const h2Port = typeof h2Addr === "object" && h2Addr ? h2Addr.port : 0;

  // h1 server is already bound by Bun.serve (synchronous)
  const h1Port = h1Server.port;

  // Default to h1 port; adapters needing h2 get the h2 port
  const tlsPort = h1Port;

  // Stage 1 — HTTP CONNECT proxy. Bind on 0 directly for the same race-free
  // reason as the TLS server above.
  const connectServer = net.createServer((client) => {
    let headerBuf = Buffer.alloc(0);
    let tunneled = false;

    const onData = (chunk: Buffer) => {
      if (tunneled) {
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const str = headerBuf.toString("latin1");
      const headEnd = str.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        return;
      }

      client.removeListener("data", onData);

      const firstLine = str.split("\r\n")[0] ?? "";
      const connectTarget = firstLine.split(" ")[1] ?? "";
      const [host, portStr] = connectTarget.split(":");
      const targetPort = Number.parseInt(portStr, 10) || 443;

      if (!host) {
        client.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        client.destroy();
        return;
      }

      // mitmAll: intercept ALL allowed hosts (SNI provides per-host certs).
      // Otherwise only the exact target host is MITM'd; the rest are tunneled
      // through for web access (WebFetch/WebSearch).
      const isApiHost = target?.mitmAll ? isAllowedConnectHost(host, target) : isApiConnectHost(host, target);
      const localAddr = bindAddr === "0.0.0.0" ? "127.0.0.1" : bindAddr;
      const destHost = isApiHost ? localAddr : host;
      const useH2 = target?.useH2 === true && h2Port > 0;
      const destPort = isApiHost ? (useH2 ? h2Port : h1Port) : targetPort;

      const upstreamSocket = net.connect(destPort, destHost, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunneled = true;

        const leftover = headerBuf.slice(headEnd + 4);
        if (leftover.length > 0) {
          upstreamSocket.write(leftover);
        }

        // Manual data forwarding instead of .pipe() — Bun's pipe can delay
        // TLS ClientHello delivery which breaks the handshake
        client.on("data", (chunk: Buffer) => upstreamSocket.write(chunk));
        upstreamSocket.on("data", (chunk: Buffer) => client.write(chunk));
        client.on("end", () => upstreamSocket.end());
        upstreamSocket.on("end", () => client.end());
      });

      upstreamSocket.on("error", () => client.destroy());
      client.on("error", () => upstreamSocket.destroy());
    };

    client.on("data", onData);
    client.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    connectServer.listen(0, target?.bindAddress ?? "127.0.0.1", () => resolve());
    connectServer.on("error", reject);
  });
  const connectAddr = connectServer.address();
  const connectPort = typeof connectAddr === "object" && connectAddr ? connectAddr.port : 0;

  return {
    connectPort,
    tlsPort,
    h2Port,
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    async stop() {
      h1Server.stop(true);
      sniTlsServer.close();
      h2PlainServer.close();
      await new Promise<void>((resolve) => connectServer.close(() => resolve()));
    },
  };
}
