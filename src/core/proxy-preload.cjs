const proxyPort = parseInt(process.env.MITTENS_PROXY_PORT || "0", 10);
if (proxyPort > 0) {
  const proxyUrl = "http://127.0.0.1:" + proxyPort;
  process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = proxyUrl;
  process.env.GLOBAL_AGENT_NO_PROXY = "";
  try {
    const { bootstrap } = require("global-agent");
    bootstrap();
    process.stderr.write("[mittens-preload] global-agent proxy active on port " + proxyPort + "\n");
  } catch (e) {
    process.stderr.write("[mittens-preload] global-agent failed: " + e.message + "\n");
  }
}
