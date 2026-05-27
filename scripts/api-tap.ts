#!/usr/bin/env bun
/**
 * Minimal API tap -- starts the MITM proxy for ANY target host, spawns a CLI,
 * and logs every SSE event to a JSONL file. Used for format analysis.
 *
 * Usage:
 *   bun scripts/api-tap.ts --target=chatgpt.com -- codex exec "hello"
 *   bun scripts/api-tap.ts --target=generativelanguage.googleapis.com -- gemini -p "hello"
 *   bun scripts/api-tap.ts --target=api.anthropic.com -- claude -p "hello"
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCerts } from "../src/core/cert-manager.js";
import { startMitmProxy } from "../src/core/mitm-server.js";

const args = process.argv.slice(2);
const targetIdx = args.findIndex(a => a.startsWith("--target="));
const targetHost = targetIdx >= 0 ? args[targetIdx]!.split("=")[1]! : "api.anthropic.com";
const sepIdx = args.indexOf("--");
const cliArgs = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

if (cliArgs.length === 0) {
  console.error("Usage: bun scripts/api-tap.ts --target=<host> -- <cli> [args...]");
  process.exit(1);
}

const outDir = join(process.cwd(), "tap-output");
mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = join(outDir, `tap-${targetHost.replace(/\./g, "_")}-${ts}.jsonl`);

console.error(`[tap] target: ${targetHost}`);
console.error(`[tap] cli: ${cliArgs.join(" ")}`);
console.error(`[tap] output: ${outFile}`);

const certs = ensureCerts(targetHost);
console.error("[tap] certs ready (leaf for " + targetHost + ")");

// Create combined cert bundle for non-Node CLIs (Rust, Python, etc.)
// that use SSL_CERT_FILE instead of NODE_EXTRA_CA_CERTS
const bundlePath = join(outDir, "combined-ca-bundle.pem");
const systemBundlePaths = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/cert.pem",
  "C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt",
  "C:\\Program Files\\Git\\mingw64\\ssl\\certs\\ca-bundle.crt",
];
let systemBundle = "";
for (const p of systemBundlePaths) {
  if (existsSync(p)) {
    systemBundle = readFileSync(p, "utf-8");
    break;
  }
}
if (systemBundle) {
  writeFileSync(bundlePath, systemBundle + "\n" + readFileSync(certs.caPath, "utf-8"));
  console.error("[tap] combined CA bundle created for non-Node CLIs");
}

const proxy = await startMitmProxy(certs, {
  host: targetHost,
});
console.error(`[tap] proxy on 127.0.0.1:${proxy.connectPort}`);

let eventCount = 0;
proxy.onEvent((evt: Record<string, unknown>) => {
  eventCount++;
  const line = JSON.stringify(evt);
  appendFileSync(outFile, line + "\n");
  const type = String(evt.type ?? "unknown");
  if (eventCount <= 30 || eventCount % 20 === 0) {
    console.error(`[tap] #${eventCount} ${type}`);
  }
});

writeFileSync(outFile, "");
console.error("[tap] spawning CLI...");

// Two preloads for Node CLIs:
// 1. proxy-preload.cjs — patches http/https globalAgent (legacy Node HTTP)
// 2. dns-override-preload.cjs — redirects target hostname to 127.0.0.1
//    so even fetch()-based CLIs hit our TLS server directly
const proxyPreload = new URL("../src/core/proxy-preload.cjs", import.meta.url);
const dnsPreload = new URL("../src/core/dns-override-preload.cjs", import.meta.url);
const toAbsolute = (u: URL) => u.pathname.replace(/^\/([A-Z]:)/i, "$1");

const tlsPort = proxy.tlsPort;

const child = spawn(cliArgs[0]!, cliArgs.slice(1), {
  stdio: ["inherit", "pipe", "inherit"],
  env: {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.connectPort}`,
    NODE_EXTRA_CA_CERTS: certs.caPath,
    SSL_CERT_FILE: systemBundle ? bundlePath : undefined,
    REQUESTS_CA_BUNDLE: systemBundle ? bundlePath : undefined,
    MITTENS_PROXY_PORT: String(proxy.connectPort),
    MITTENS_TARGET_HOST: targetHost,
    MITTENS_PROXY_TLS_PORT: tlsPort ? String(tlsPort) : "",
    NODE_OPTIONS: `--require "${toAbsolute(proxyPreload)}" --require "${toAbsolute(dnsPreload)}"`,
  },
});

let output = "";
child.stdout?.setEncoding("utf8");
child.stdout?.on("data", (chunk: string) => {
  output += chunk;
  process.stdout.write(chunk);
});

child.on("exit", async (code) => {
  console.error(`\n[tap] CLI exited code=${code}, ${eventCount} events captured`);
  console.error(`[tap] output: ${outFile}`);
  await proxy.stop();
  process.exit(code ?? 0);
});
