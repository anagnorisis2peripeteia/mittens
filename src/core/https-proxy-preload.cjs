// Preload script that forces all HTTPS connections through an HTTP CONNECT proxy.
// Injected via NODE_OPTIONS=--require for CLIs that ignore HTTPS_PROXY env var.
// Uses Node's built-in undici ProxyAgent when available (Node 18+), falls back
// to patching the default https agent.
const proxyUrl = process.env.MITTENS_PROXY_URL;
if (proxyUrl) {
  try {
    const https = require("https");
    const http = require("http");
    const url = require("url");

    const parsed = new URL(proxyUrl);
    const proxyHost = parsed.hostname;
    const proxyPort = parseInt(parsed.port, 10);

    // Monkey-patch https.request to tunnel through the CONNECT proxy
    const origRequest = https.request;
    https.request = function patchedRequest(options, callback) {
      if (typeof options === "string") {
        options = new URL(options);
      }
      if (options instanceof URL) {
        options = {
          hostname: options.hostname,
          port: options.port || 443,
          path: options.pathname + options.search,
          method: "GET",
          headers: {},
        };
      }
      // Skip proxy for loopback
      const host = options.hostname || options.host || "localhost";
      if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
        return origRequest.call(https, options, callback);
      }

      const targetHost = host;
      const targetPort = options.port || 443;

      // Create CONNECT tunnel
      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: targetHost + ":" + targetPort,
      });

      connectReq.on("connect", function (res, socket) {
        if (res.statusCode !== 200) {
          if (callback) callback(new Error("CONNECT proxy returned " + res.statusCode));
          socket.destroy();
          return;
        }
        options.socket = socket;
        options.agent = false;
        delete options.host;
        delete options.hostname;
        delete options.port;
        const req = origRequest.call(https, options, callback);
        req.on("error", function () { socket.destroy(); });
        // Don't call req.end() — the caller does that
      });

      connectReq.on("error", function (err) {
        if (callback) callback(err);
      });

      connectReq.end();

      // Return a dummy request object that the caller can write to
      // This is hacky but works for most HTTP clients
      return connectReq;
    };

    process.stderr.write("[mittens-proxy-preload] HTTPS proxy active: " + proxyUrl + "\n");
  } catch (e) {
    process.stderr.write("[mittens-proxy-preload] failed: " + e.message + "\n");
  }
}
