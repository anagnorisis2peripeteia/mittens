// Preload that redirects TLS connections for a specific host to the MITM proxy.
// Injected via NODE_OPTIONS=--require for CLIs whose gRPC/HTTP2 clients ignore
// HTTPS_PROXY. Patches tls.connect at the lowest level so even @grpc/grpc-js
// and @connectrpc/connect-node are intercepted.
//
// Env vars:
//   MITTENS_TLS_REDIRECT_HOST  - the hostname to intercept (e.g. "agentn.global.api5.cursor.sh")
//   MITTENS_TLS_REDIRECT_TO    - host:port of the TLS terminator (e.g. "172.27.208.1:54321")
//   MITTENS_TLS_REDIRECT_CA    - path to CA cert file for the MITM cert chain
const redirectHost = process.env.MITTENS_TLS_REDIRECT_HOST;
const redirectTo = process.env.MITTENS_TLS_REDIRECT_TO;
const caPath = process.env.MITTENS_TLS_REDIRECT_CA;

if (redirectHost && redirectTo) {
  const [toHost, toPortStr] = redirectTo.split(":");
  const toPort = parseInt(toPortStr, 10);

  const tls = require("tls");
  const fs = require("fs");
  const origConnect = tls.connect;

  let caCert;
  if (caPath) {
    try { caCert = fs.readFileSync(caPath); } catch {}
  }

  tls.connect = function patchedConnect() {
    const args = Array.from(arguments);
    let options = args[0];

    if (typeof options === "number") {
      // tls.connect(port, host, options, callback)
      const port = options;
      const host = typeof args[1] === "string" ? args[1] : undefined;
      if (host === redirectHost || (port === 443 && !host)) {
        args[0] = toPort;
        if (typeof args[1] === "string") args[1] = toHost;
        // Inject CA and allow the redirect
        const optIdx = args.findIndex(a => typeof a === "object" && a !== null);
        if (optIdx >= 0) {
          if (caCert) args[optIdx].ca = caCert;
          args[optIdx].servername = redirectHost;
        }
        process.stderr.write("[tls-redirect] " + redirectHost + ":" + port + " -> " + toHost + ":" + toPort + "\n");
      }
    } else if (typeof options === "object" && options !== null) {
      const host = options.host || options.hostname || options.servername;
      const port = options.port || 443;
      if (host === redirectHost) {
        options.host = toHost;
        options.hostname = toHost;
        options.port = toPort;
        options.servername = redirectHost;
        if (caCert) {
          options.ca = options.ca ? [].concat(options.ca, caCert) : caCert;
        }
        // Don't reject our MITM cert
        options.rejectUnauthorized = false;
        process.stderr.write("[tls-redirect] " + host + ":" + port + " -> " + toHost + ":" + toPort + "\n");
      }
    }

    return origConnect.apply(tls, args);
  };

  // Also patch net.connect for HTTP/2 ALPN negotiation
  const net = require("net");
  const origNetConnect = net.connect;
  const origNetCreateConnection = net.createConnection;

  function patchNetConnect() {
    const args = Array.from(arguments);
    let options = args[0];
    if (typeof options === "object" && options !== null) {
      const host = options.host || options.hostname;
      if (host === redirectHost) {
        options.host = toHost;
        options.hostname = toHost;
        options.port = toPort;
      }
    }
    return origNetConnect.apply(net, args);
  }

  net.connect = patchNetConnect;
  net.createConnection = function() {
    const args = Array.from(arguments);
    let options = args[0];
    if (typeof options === "object" && options !== null) {
      const host = options.host || options.hostname;
      if (host === redirectHost) {
        options.host = toHost;
        options.hostname = toHost;
        options.port = toPort;
      }
    }
    return origNetCreateConnection.apply(net, args);
  };

  // Patch http2.connect for gRPC clients that use HTTP/2 directly
  try {
    const http2 = require("http2");
    const origH2Connect = http2.connect;
    http2.connect = function patchedH2Connect(authority) {
      const args = Array.from(arguments);
      if (typeof authority === "string") {
        const parsed = new URL(authority);
        if (parsed.hostname === redirectHost) {
          const newAuthority = parsed.protocol + "//" + toHost + ":" + toPort + parsed.pathname;
          args[0] = newAuthority;
          // Patch options (2nd arg) to set servername + CA
          let opts = args[1];
          if (!opts || typeof opts !== "object") {
            opts = {};
            args.splice(1, 0, opts);
          }
          opts.servername = redirectHost;
          opts.rejectUnauthorized = false;
          if (caCert) opts.ca = opts.ca ? [].concat(opts.ca, caCert) : caCert;
          process.stderr.write("[tls-redirect/h2] " + authority + " -> " + newAuthority + "\n");
        }
      }
      return origH2Connect.apply(http2, args);
    };
  } catch {}

  // Patch dns.lookup to redirect hostname resolution
  try {
    const dns = require("dns");
    const origLookup = dns.lookup;
    dns.lookup = function patchedLookup(hostname) {
      const args = Array.from(arguments);
      // Log ALL lookups to see what cursor-agent resolves
      if (hostname && !hostname.match(/^(localhost|127\.|::1)/)) {
        process.stderr.write("[tls-redirect/dns] lookup: " + hostname + "\n");
      }
      if (hostname === redirectHost) {
        args[0] = toHost;
        process.stderr.write("[tls-redirect/dns] REDIRECT: " + hostname + " -> " + toHost + "\n");
      }
      return origLookup.apply(dns, args);
    };
  } catch {}

  // Last resort: try to intercept via undici's global dispatcher (covers fetch + http2)
  try {
    const undici = require("undici");
    if (undici && undici.setGlobalDispatcher && undici.ProxyAgent) {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxyUrl) {
        const agent = new undici.ProxyAgent({
          uri: proxyUrl,
          requestTls: {
            servername: redirectHost,
            rejectUnauthorized: false,
            ca: caCert ? [caCert] : undefined,
          },
        });
        undici.setGlobalDispatcher(agent);
        process.stderr.write("[tls-redirect/undici] global dispatcher set to proxy: " + proxyUrl + "\n");
      }
    }
  } catch (e) {
    process.stderr.write("[tls-redirect/undici] failed: " + e.message + "\n");
  }

  process.stderr.write("[tls-redirect] armed: " + redirectHost + " -> " + redirectTo + "\n");
}
