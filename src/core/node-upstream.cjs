// Relays an upstream HTTPS request via Node's actual TLS stack.
// Reads JSON payload from stdin (to avoid ENAMETOOLONG on large requests).
// For non-SSE: buffers response and outputs JSON to stdout.
// For SSE: outputs SSE_HEADER:<json>\n then pipes the raw stream to stdout.
const https = require("https");

let inputBuf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { inputBuf += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(inputBuf);

  const req = https.request({
    hostname: data.hostname,
    port: data.port || 443,
    path: data.path,
    method: data.method,
    headers: data.headers,
  }, (res) => {
    const ct = res.headers["content-type"] || "";
    const isSSE = ct.includes("text/event-stream");
    if (isSSE) {
      const headerJson = JSON.stringify({
        status: res.statusCode,
        headers: res.headers,
        sse: true,
      });
      process.stdout.write("SSE_HEADER:" + headerJson + "\n");
      res.pipe(process.stdout);
    } else {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        process.stdout.write(JSON.stringify({
          status: res.statusCode,
          headers: res.headers,
          body,
        }));
      });
    }
  });
  req.on("error", (e) => {
    process.stdout.write(JSON.stringify({ status: 502, headers: {}, body: e.message }));
  });
  if (data.body) req.write(data.body);
  req.end();
});
