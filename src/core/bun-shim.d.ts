// Minimal ambient declaration for the Bun runtime surface this proxy uses.
//
// The interactive proxy ships as a Bun-run source asset, so it cannot pull in
// `bun-types` without making Bun a build-time dependency of the node-only CI
// typecheck lane. Declaring just the `Bun.serve`/`Bun.file` surface keeps the
// shipped runtime inside `tsgo` validation (`pnpm tsgo:extensions:interactive-proxy`)
// while leaving the full Bun runtime to ship time. Everything else the proxy
// touches (`fetch`, `Request`, `Response`, `Headers`, `URL`, `TransformStream`,
// `TextDecoder`) resolves from the repo's DOM + node lib config.

interface BunWebSocketData {
  [key: string]: unknown;
}

interface BunServerWebSocket<T = BunWebSocketData> {
  readonly data: T;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface BunWebSocketHandler<T = BunWebSocketData> {
  open?(ws: BunServerWebSocket<T>): void;
  message?(ws: BunServerWebSocket<T>, message: string | ArrayBuffer): void;
  close?(ws: BunServerWebSocket<T>, code: number, reason: string): void;
  drain?(ws: BunServerWebSocket<T>): void;
}

interface BunServer {
  /** Bound listen port; populated synchronously once `serve` returns. */
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
  upgrade<T = BunWebSocketData>(req: Request, options?: { data?: T }): boolean;
}

interface BunServeOptions<T = BunWebSocketData> {
  port?: number;
  hostname?: string;
  idleTimeout?: number;
  tls?: {
    key: unknown;
    cert: unknown;
  };
  fetch(req: Request, server: BunServer): Response | Promise<Response> | Promise<Response | undefined> | undefined;
  websocket?: BunWebSocketHandler<T>;
}

declare const Bun: {
  serve<T = BunWebSocketData>(options: BunServeOptions<T>): BunServer;
  file(path: string): unknown;
};
