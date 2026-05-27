#!/usr/bin/env bun
/**
 * Diagnostic: start the MITM proxy for a given adapter target, spawn the CLI,
 * and dump every raw event to stderr. Used to discover the wire format
 * for non-Anthropic APIs before writing normalizers.
 *
 * Usage: bun mitm-capture.ts <host> <port> -- <cli-command> [args...]
 * Example: bun mitm-capture.ts cloudcode-pa.googleapis.com 443 -- gemini -p "hello"
 */
import { ensureCerts } from "./cert-manager.js";
import { startMitmProxy } from "./mitm-server.js";
import { setupRedirect, resolveIPv4, flushStaleRules, type RedirectHandle } from "./platform-redirect.js";

const args = process.argv.slice(2);
const dashIdx = args.indexOf("--");
if (dashIdx < 2) {
  console.error("Usage: bun mitm-capture.ts <host> <port> -- <command> [args...]");
  process.exit(1);
}

const targetHost = args[0]!;
const targetPort = parseInt(args[1]!, 10);
const cliArgs = args.slice(dashIdx + 1);

console.error(`[capture] Target: ${targetHost}:${targetPort}`);
console.error(`[capture] CLI: ${cliArgs.join(" ")}`);

const certs = ensureCerts(targetHost);
console.error(`[capture] Certs ready: ${certs.caPath}`);

const isWSL = cliArgs[0] === "wsl";

// Flush any stale redirect rules from a previous crashed session
flushStaleRules(isWSL ? "win32" : undefined);

const proxy = await startMitmProxy(certs, {
  host: targetHost,
  port: targetPort,
  passthroughSuffixes: ["googleapis.com", "cursor.sh", "openai.com", "goog", "googleusercontent.com", "chatgpt.com", "run.app"],
  bindAddress: isWSL ? "0.0.0.0" : "127.0.0.1",
});

let proxyHost = "127.0.0.1";
let caPathForChild = certs.caPath;

if (isWSL) {
  try {
    const { execSync } = await import("node:child_process");
    const gwLine = execSync("wsl -d Ubuntu -- ip route show default", { encoding: "utf8" }).trim();
    const match = gwLine.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      proxyHost = match[1]!;
      console.error(`[capture] WSL detected, using Windows host IP: ${proxyHost}`);
    }
  } catch {}
  caPathForChild = certs.caPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
  console.error(`[capture] WSL CA path: ${caPathForChild}`);
}

console.error(`[capture] MITM proxy on ${proxyHost}:${proxy.connectPort}`);

// Set up kernel redirect for gRPC clients that ignore HTTPS_PROXY
let redirect: RedirectHandle | null = null;
const destIPs = resolveIPv4(targetHost, isWSL ? "win32" : undefined);
console.error(`[capture] Target IPs: ${destIPs.join(", ") || "(none)"}`);

if (destIPs.length > 0) {
  redirect = await setupRedirect({
    targetPort: proxy.tlsPort,
    platform: isWSL ? "win32" : undefined,
    destIPs,
  });
  console.error(`[capture] Redirect active: :443 -> :${proxy.tlsPort} (${redirect.platform})`);
}

let eventCount = 0;
proxy.onEvent((evt) => {
  eventCount++;
  const clone = { ...evt };
  delete clone._reqId;
  delete clone._requestType;
  delete clone._source;
  for (const [k, v] of Object.entries(clone)) {
    if (typeof v === "string" && v.length > 500) {
      (clone as Record<string, unknown>)[k] = v.slice(0, 500) + `...[${v.length} chars]`;
    }
    if (typeof v === "object" && v !== null) {
      const s = JSON.stringify(v);
      if (s.length > 500) {
        (clone as Record<string, unknown>)[k] = s.slice(0, 500) + "...[truncated]";
      }
    }
  }
  console.error(`[event ${eventCount}] ${JSON.stringify(clone)}`);
  process.stdout.write(JSON.stringify(evt) + "\n");
});

const { spawn } = await import("node:child_process");

const mitmProxyUrl = `http://${proxyHost}:${proxy.connectPort}`;
const childEnv = {
  ...process.env,
  HTTPS_PROXY: mitmProxyUrl,
  https_proxy: mitmProxyUrl,
  HTTP_PROXY: mitmProxyUrl,
  http_proxy: mitmProxyUrl,
  ALL_PROXY: mitmProxyUrl,
  NO_PROXY: "",
  no_proxy: "",
  NODE_EXTRA_CA_CERTS: caPathForChild,
  NODE_OPTIONS: `--use-system-ca`,
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  SSL_CERT_FILE: caPathForChild,
};

let child;
if (isWSL) {
  const wslDistro = cliArgs[1] === "-d" ? cliArgs[2] : "Ubuntu";
  const innerDash = cliArgs.indexOf("--");
  const innerCmd = cliArgs.slice(innerDash + 1);

  const envPrefix = [
    `HTTPS_PROXY=http://${proxyHost}:${proxy.connectPort}`,
    `NODE_EXTRA_CA_CERTS=${caPathForChild}`,
    `NODE_OPTIONS="--use-system-ca --use-env-proxy"`,
    `SSL_CERT_FILE=${caPathForChild}`,
    `NODE_TLS_REJECT_UNAUTHORIZED=0`,
  ].join(" ");
  const fullCmd = `${envPrefix} ${innerCmd.join(" ")}`;
  console.error(`[capture] WSL command: ${fullCmd}`);
  child = spawn("wsl", ["-d", wslDistro!, "--", "bash", "-c", fullCmd], {
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
} else {
  try {
    const systemCaPaths = [
      "C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt",
      "/etc/ssl/certs/ca-certificates.crt",
    ];
    for (const sysCA of systemCaPaths) {
      if (require("fs").existsSync(sysCA)) {
        const combined = require("fs").readFileSync(sysCA, "utf8") + "\n" + require("fs").readFileSync(certs.caPath, "utf8");
        const combinedPath = certs.caPath.replace("ca.crt", "combined-ca.pem");
        require("fs").writeFileSync(combinedPath, combined);
        childEnv.SSL_CERT_FILE = combinedPath;
        console.error(`[capture] Combined CA bundle: ${combinedPath}`);
        break;
      }
    }
  } catch {}

  child = spawn(cliArgs[0]!, cliArgs.slice(1), {
    env: childEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });
}

child.on("exit", async (code) => {
  console.error(`[capture] CLI exited with code ${code}, ${eventCount} events captured`);
  if (redirect) await redirect.cleanup();
  await proxy.stop();
  process.exit(code ?? 0);
});
