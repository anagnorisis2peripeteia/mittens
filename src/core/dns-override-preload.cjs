const targetHost = process.env.MITTENS_TARGET_HOST;
const port = parseInt(process.env.MITTENS_PROXY_TLS_PORT || "0", 10);
if (targetHost && port > 0) {
  const dns = require("node:dns");
  const origLookup = dns.lookup;
  dns.lookup = function(hostname, options, callback) {
    if (hostname === targetHost) {
      const cb = typeof options === "function" ? options : callback;
      process.stderr.write("[mittens-dns] " + hostname + " -> 127.0.0.1:" + port + "\n");
      if (cb) cb(null, "127.0.0.1", 4);
      return;
    }
    return origLookup.call(this, hostname, options, callback);
  };
  // Also patch promises version
  const origResolve = dns.promises?.resolve4;
  if (dns.promises && origResolve) {
    dns.promises.resolve4 = async function(hostname) {
      if (hostname === targetHost) return ["127.0.0.1"];
      return origResolve.call(this, hostname);
    };
  }
  process.stderr.write("[mittens-dns] DNS override active for " + targetHost + "\n");
}
