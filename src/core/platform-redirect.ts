/**
 * Cross-platform port 443 redirect for gRPC adapters.
 *
 * Some CLIs (Cursor, Antigravity) use gRPC transports that ignore
 * HTTPS_PROXY. For these, the only interception path is redirecting
 * their outbound :443 traffic at the kernel level to our local TLS
 * terminator.
 *
 * Three strategies:
 *   Linux:   iptables OUTPUT REDIRECT + ip6tables REJECT
 *   macOS:   pf anchor with rdr rule
 *   Windows: delegate to WSL iptables (runs TLS terminator inside WSL)
 *
 * Usage:
 *   const redirect = await setupRedirect({ targetPort: 8443, platform: "linux" });
 *   // ... do work ...
 *   await redirect.cleanup();
 */
import { execSync, execFileSync } from "node:child_process";

export type RedirectPlatform = "linux" | "darwin" | "win32";

export interface RedirectOptions {
  /** Local port the TLS terminator is listening on. */
  targetPort: number;
  /** Override auto-detected platform. */
  platform?: RedirectPlatform;
  /** For Linux: specific destination IPs to redirect (if empty, redirects ALL :443). */
  destIPs?: string[];
  /** For Windows/WSL: distro name. Default "Ubuntu". */
  wslDistro?: string;
  /** Bind address for the proxy when running in WSL. Default "0.0.0.0". */
  wslBindAddress?: string;
}

export interface RedirectHandle {
  platform: RedirectPlatform;
  cleanup: () => Promise<void>;
}

function detectPlatform(): RedirectPlatform {
  return process.platform as RedirectPlatform;
}

function exec(cmd: string, opts?: { stdio?: "pipe" | "inherit" }): string {
  return execSync(cmd, { encoding: "utf8", stdio: opts?.stdio ?? "pipe" }).trim();
}

// ── Linux: iptables ──

function setupLinuxRedirect(opts: RedirectOptions): RedirectHandle {
  const { targetPort, destIPs } = opts;
  const rules: string[] = [];

  if (destIPs && destIPs.length > 0) {
    for (const ip of destIPs) {
      const rule = `-t nat -A OUTPUT -d ${ip} -p tcp --dport 443 -j REDIRECT --to-port ${targetPort}`;
      exec(`sudo iptables ${rule}`);
      rules.push(rule);
    }
  } else {
    const rule = `-t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port ${targetPort}`;
    exec(`sudo iptables ${rule}`);
    rules.push(rule);
  }

  // Block IPv6 :443 so the CLI can't bypass via AAAA records
  exec("sudo ip6tables -A OUTPUT -p tcp --dport 443 -j REJECT");

  return {
    platform: "linux",
    async cleanup() {
      for (const rule of rules) {
        try { exec(`sudo iptables ${rule.replace("-A", "-D")}`); } catch {}
      }
      try { exec("sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT"); } catch {}
    },
  };
}

// ── macOS: pf ──

function getDefaultInterface(): string {
  try {
    const raw = exec("route -n get default 2>/dev/null | grep interface");
    const match = raw.match(/interface:\s*(\S+)/);
    return match?.[1] ?? "en0";
  } catch {
    return "en0";
  }
}

function setupDarwinRedirect(opts: RedirectOptions): RedirectHandle {
  const { targetPort, destIPs } = opts;
  const iface = getDefaultInterface();

  // macOS pf `rdr` only applies on the inbound direction of an interface.
  // To intercept outbound :443 from local processes, we need two rules:
  //   1. `rdr on lo0` — redirects traffic arriving on loopback to our port
  //   2. `pass out route-to lo0` — diverts outbound :443 through loopback
  //      where the rdr rule catches it
  // This is the same pattern mitmproxy/Charles use on macOS.
  const rdrDest = destIPs?.length
    ? destIPs.map(ip => `rdr pass on lo0 proto tcp from any to ${ip} port 443 -> 127.0.0.1 port ${targetPort}`).join("\n")
    : `rdr pass on lo0 proto tcp from any to any port 443 -> 127.0.0.1 port ${targetPort}`;
  const routeRule = destIPs?.length
    ? destIPs.map(ip => `pass out on ${iface} route-to lo0 proto tcp from any to ${ip} port 443`).join("\n")
    : `pass out on ${iface} route-to lo0 proto tcp from any to any port 443`;

  const anchorRules = `${rdrDest}\n${routeRule}`;
  exec(`echo '${anchorRules}' | sudo pfctl -a mittens -f /dev/stdin`);
  // Ensure pf is enabled (idempotent)
  try { exec("sudo pfctl -e"); } catch {}

  return {
    platform: "darwin",
    async cleanup() {
      try { exec("sudo pfctl -a mittens -F all"); } catch {}
      // Disable pf if we were the ones who enabled it? No — leave it
      // enabled; other anchors (e.g. system Application Firewall) may
      // depend on it. Flushing our anchor is sufficient cleanup.
    },
  };
}

// ── Windows: WSL iptables ──

function setupWindowsRedirect(opts: RedirectOptions): RedirectHandle {
  const { targetPort, destIPs, wslDistro = "Ubuntu" } = opts;
  const rules: string[] = [];

  function wsl(cmd: string): string {
    return exec(`wsl -d ${wslDistro} -- ${cmd}`);
  }

  if (destIPs && destIPs.length > 0) {
    for (const ip of destIPs) {
      const rule = `-t nat -A OUTPUT -d ${ip} -p tcp --dport 443 -j REDIRECT --to-port ${targetPort}`;
      wsl(`sudo iptables ${rule}`);
      rules.push(rule);
    }
  } else {
    const rule = `-t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port ${targetPort}`;
    wsl(`sudo iptables ${rule}`);
    rules.push(rule);
  }

  // Block IPv6 in WSL too
  wsl("sudo ip6tables -A OUTPUT -p tcp --dport 443 -j REJECT");

  return {
    platform: "win32",
    async cleanup() {
      for (const rule of rules) {
        try { wsl(`sudo iptables ${rule.replace("-A", "-D")}`); } catch {}
      }
      try { wsl("sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT"); } catch {}
    },
  };
}

// ── Public API ──

export async function setupRedirect(opts: RedirectOptions): Promise<RedirectHandle> {
  const platform = opts.platform ?? detectPlatform();

  switch (platform) {
    case "linux":
      return setupLinuxRedirect(opts);
    case "darwin":
      return setupDarwinRedirect(opts);
    case "win32":
      return setupWindowsRedirect(opts);
    default:
      throw new Error(`Unsupported platform for port redirect: ${platform}`);
  }
}

/**
 * Resolve a hostname to its IPv4 addresses. Used to build the destIPs
 * list for targeted redirect rules (redirect only traffic to the API
 * host, not all :443).
 */
export function resolveIPv4(hostname: string, platform?: RedirectPlatform): string[] {
  const plat = platform ?? detectPlatform();
  try {
    if (plat === "win32") {
      const raw = exec(`wsl -d Ubuntu -- getent hosts ${hostname}`);
      return [...new Set(raw.split("\n").map(l => l.split(/\s+/)[0]!).filter(Boolean))];
    }
    const raw = exec(`getent hosts ${hostname}`);
    return [...new Set(raw.split("\n").map(l => l.split(/\s+/)[0]!).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Flush any stale iptables NAT rules that might be left from a previous
 * crashed session. Safe to call on startup.
 */
export function flushStaleRules(platform?: RedirectPlatform, wslDistro = "Ubuntu"): void {
  const plat = platform ?? detectPlatform();
  try {
    switch (plat) {
      case "linux":
        exec("sudo iptables -t nat -F OUTPUT");
        exec("sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT");
        break;
      case "darwin":
        exec("sudo pfctl -a mittens -F all");
        break;
      case "win32":
        exec(`wsl -d ${wslDistro} -- sudo iptables -t nat -F OUTPUT`);
        exec(`wsl -d ${wslDistro} -- sudo ip6tables -D OUTPUT -p tcp --dport 443 -j REJECT`);
        break;
    }
  } catch {}
}
