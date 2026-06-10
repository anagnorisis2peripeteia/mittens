import { describe, expect, it } from "vitest";
import { classifyRequest, type ClassifyState } from "./request-classifier.js";

// classifyRequest decides whether a /v1/messages stream's `end_turn` ends the
// user-facing turn (primary) or is neutralized (sub-agent). Hardened, layered
// replacement for the old `!hasAgentTool || usesServerWebSearch` rule (which
// had no spawner-seen gate and could mis-suppress the primary into a hang).

const fresh = (): ClassifyState => ({ primarySpawnerSeen: false });
const body = (o: unknown): string => JSON.stringify(o);
const userMsg = { role: "user", content: "hi" };

describe("classifyRequest", () => {
  it("primary carrying the Agent spawner -> normal, records spawner", () => {
    const s = fresh();
    expect(classifyRequest(body({ tools: [{ name: "Agent" }, { name: "Read" }], messages: [userMsg] }), s)).toBe("normal");
    expect(s.primarySpawnerSeen).toBe(true);
  });

  it("renamed/disguised spawner (TaskCreate, dispatch_agent) -> primary", () => {
    expect(classifyRequest(body({ tools: [{ name: "TaskCreate" }], messages: [userMsg] }), fresh())).toBe("normal");
    expect(classifyRequest(body({ tools: [{ name: "dispatch_agent" }], messages: [userMsg] }), fresh())).toBe("normal");
  });

  it("Agent-less tool-bearing request after a spawner was seen -> subagent", () => {
    const s = fresh();
    classifyRequest(body({ tools: [{ name: "Agent" }], messages: [userMsg] }), s);
    expect(classifyRequest(body({ tools: [{ name: "Read" }, { name: "Grep" }, { name: "Bash" }, { name: "Glob" }], messages: [userMsg] }), s)).toBe("subagent");
  });

  it("no spawner ever seen -> stays primary (no-hang guard)", () => {
    expect(classifyRequest(body({ tools: [{ name: "Read" }, { name: "Grep" }], messages: [userMsg] }), fresh())).toBe("normal");
  });

  it("web_search sub-agent -> subagent (independent of state)", () => {
    expect(classifyRequest(body({ tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [userMsg] }), fresh())).toBe("subagent");
  });

  it("primary that itself requests web_search -> normal (bounded-count guard)", () => {
    expect(classifyRequest(body({ tools: [{ name: "Agent" }, { type: "web_search_20250305" }, { name: "Read" }, { name: "Bash" }], messages: [userMsg] }), fresh())).toBe("normal");
  });

  it("max_tokens retry of primary -> normal", () => {
    const s = fresh();
    const b = body({ tools: [{ name: "Agent" }, { name: "Read" }], messages: [userMsg] });
    classifyRequest(b, s);
    expect(classifyRequest(b, s)).toBe("normal");
  });

  it("compaction by summarize markers", () => {
    expect(classifyRequest(body({ tools: [{ name: "Read" }], messages: [{ role: "user", content: "Your summary should include the following sections. Provide a detailed summary." }] }), fresh())).toBe("compaction");
  });

  it("tool-less -> auxiliary", () => {
    expect(classifyRequest(body({ messages: [userMsg] }), fresh())).toBe("auxiliary");
  });

  it("tool_result block -> tool_followup", () => {
    expect(classifyRequest(body({ tools: [{ name: "Agent" }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }] }), fresh())).toBe("tool_followup");
  });

  it("guarded system-prompt fingerprint -> subagent when markers supplied", () => {
    expect(classifyRequest(body({ tools: [{ name: "Read" }], system: "You are a sub-agent launched to research.", messages: [userMsg] }), fresh(), { subagentSystemMarkers: ["You are a sub-agent"] })).toBe("subagent");
  });

  it("non-JSON -> normal", () => {
    expect(classifyRequest("not json", fresh())).toBe("normal");
  });
});
