/**
 * Request classification (primary turn vs. sub-agent) for Claude-shaped
 * /v1/messages bodies.
 *
 * The wrapper needs to know whether a given stream's `end_turn` should end the
 * USER-facing turn (the primary) or be neutralized (a sub-agent: Task/research/
 * Explore, web search, or any disguised agent). This is the hardened,
 * multi-signal replacement for the old single-`Agent`-tool heuristic — layered,
 * first-decisive-layer-wins, biased to never mis-suppress the primary (which
 * would hang) while still catching every sub-agent form. Pure + unit-testable.
 */

export type RequestType = "normal" | "compaction" | "tool_followup" | "auxiliary" | "subagent";

export type ClassifyState = {
  // True once any request this run advertised a primary "spawner" tool (the
  // Task/Agent tool that launches sub-agents). Gates the by-absence sub-agent
  // layer so a deny-listed-Agent run keeps its primary turn-end instead of
  // hanging.
  primarySpawnerSeen: boolean;
};

export type ClassifyOptions = {
  // Tool names that mark the PRIMARY turn (matched case-insensitively, exact).
  // A conservative structural matcher additionally catches renamed/"disguised"
  // spawner tools by shape. Defaults to DEFAULT_SPAWNER_TOOL_NAMES.
  spawnerToolNames?: readonly string[];
  // System-prompt substrings that POSITIVELY mark a sub-agent request. OFF by
  // default — enable only once a live capture confirms a stable marker.
  subagentSystemMarkers?: readonly string[];
};

export const DEFAULT_SPAWNER_TOOL_NAMES: readonly string[] = ["Agent", "Task", "TaskCreate"];

function isSpawnerTool(tool: Record<string, unknown>, names: readonly string[]): boolean {
  const name = typeof tool?.name === "string" ? tool.name : "";
  if (!name) {
    return false; // server tools (type-only, e.g. web_search) never spawn agents
  }
  const lower = name.toLowerCase();
  if (names.some((n) => n.toLowerCase() === lower)) {
    return true;
  }
  // Conservative shape match for renamed spawners on the primary turn. Kept
  // tight so a sub-agent's ordinary tool can't be mistaken for a spawner.
  if (/^(agent|task)$/i.test(name)) {
    return true;
  }
  if (/^(dispatch|launch|spawn|create|run)_?(sub_?)?agent$/i.test(name)) {
    return true;
  }
  if (/^task(create|run|spawn|launch|dispatch)$/i.test(name)) {
    return true;
  }
  return false;
}

function isWebSearchTool(tool: Record<string, unknown>): boolean {
  const type = typeof tool?.type === "string" ? tool.type : "";
  if (type.includes("web_search")) {
    return true;
  }
  const name = typeof tool?.name === "string" ? tool.name : "";
  return name.toLowerCase() === "web_search";
}

function systemPromptText(parsed: Record<string, unknown>): string {
  const sys = parsed.system;
  if (typeof sys === "string") {
    return sys;
  }
  if (Array.isArray(sys)) {
    return (sys as Record<string, unknown>[])
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

export function classifyRequest(
  body: string,
  state: ClassifyState,
  opts?: ClassifyOptions,
): RequestType {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return "normal";
  }
  if (!parsed || typeof parsed !== "object") {
    return "normal";
  }

  const spawnerNames = opts?.spawnerToolNames ?? DEFAULT_SPAWNER_TOOL_NAMES;
  const toolList: Record<string, unknown>[] = Array.isArray(parsed.tools)
    ? (parsed.tools as Record<string, unknown>[])
    : [];
  const hasTools = toolList.length > 0;
  const msgs: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
  const lastMsg = msgs[msgs.length - 1] as Record<string, unknown> | undefined;

  let requestType: RequestType = "normal";

  if (lastMsg) {
    if (lastMsg.role === "tool") {
      requestType = "tool_followup";
    } else if (Array.isArray(lastMsg.content)) {
      const hasToolResult = (lastMsg.content as Record<string, unknown>[]).some(
        (b) => typeof b?.type === "string" && (b.type as string).endsWith("_result"),
      );
      if (hasToolResult) {
        requestType = "tool_followup";
      }
    }
    if (requestType === "normal" && lastMsg.role === "user") {
      const lastContent =
        typeof lastMsg.content === "string"
          ? lastMsg.content
          : Array.isArray(lastMsg.content)
            ? (lastMsg.content as Record<string, unknown>[])
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("")
            : "";
      if (
        lastContent.includes("summary should include the following sections") &&
        (lastContent.includes("continuation summary") || lastContent.includes("detailed summary"))
      ) {
        requestType = "compaction";
      }
    }
  }

  if (requestType === "normal" && !hasTools) {
    requestType = "auxiliary";
  }

  if (requestType === "normal" || requestType === "tool_followup") {
    // 5a — positive PRIMARY signal: carries a spawner tool → stays primary.
    if (toolList.some((t) => isSpawnerTool(t, spawnerNames))) {
      state.primarySpawnerSeen = true;
      return requestType;
    }
    // 5b — positive SUB-AGENT fingerprint (guarded; only if markers supplied).
    const markers = opts?.subagentSystemMarkers ?? [];
    if (markers.length > 0) {
      const sys = systemPromptText(parsed);
      if (sys && markers.some((m) => sys.includes(m))) {
        return "subagent";
      }
    }
    // 5c — web-search sub-agent: tiny dedicated stream, no spawner.
    if (toolList.some((t) => isWebSearchTool(t)) && toolList.length <= 3) {
      return "subagent";
    }
    // 5d — by-absence Task sub-agent, gated on a spawner having been seen.
    if (state.primarySpawnerSeen) {
      return "subagent";
    }
  }

  return requestType;
}
