/**
 * Cursor Agent -> Claude stream-json normalizer.
 *
 * Transforms Cursor Agent CLI stream-json events into Claude's stream-json
 * JSONL format so downstream consumers see a uniform wire format.
 *
 * Cursor format:
 *   system/init -> init + message_start
 *   thinking/delta -> content_block_start (thinking) + content_block_delta (thinking_delta)
 *   thinking/completed -> content_block_stop
 *   assistant message -> content_block_start (text) + content_block_delta (text_delta) + content_block_stop
 *   tool_call/started -> content_block_start (tool_use)
 *   tool_call/completed -> content_block_stop
 *   result/success -> message_delta + result
 */

let contentBlockIndex = 0;
let inThinkingBlock = false;

export function normalizeCursorEvent(line: string): string[] {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }

  const type = evt.type as string;
  const subtype = evt.subtype as string | undefined;
  const lines: string[] = [];

  switch (type) {
    case "system": {
      if (subtype !== "init") break;
      lines.push(JSON.stringify({
        type: "init",
        session_id: evt.session_id ?? "",
      }));
      lines.push(JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { model: evt.model ?? "cursor", role: "assistant", content: [] },
        },
      }));
      contentBlockIndex = 0;
      inThinkingBlock = false;
      break;
    }

    case "thinking": {
      if (subtype === "delta") {
        const text = evt.text as string ?? "";
        if (!inThinkingBlock) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "thinking", thinking: "" },
            },
          }));
          inThinkingBlock = true;
        }
        if (text) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "thinking_delta", thinking: text },
            },
          }));
        }
      } else if (subtype === "completed") {
        if (inThinkingBlock) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_stop", index: contentBlockIndex },
          }));
          contentBlockIndex++;
          inThinkingBlock = false;
        }
      }
      break;
    }

    case "assistant": {
      const msg = evt.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) break;

      for (const part of content) {
        if (part.type === "text" && typeof part.text === "string") {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            },
          }));
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "text_delta", text: part.text },
            },
          }));
          lines.push(JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_stop", index: contentBlockIndex },
          }));
          contentBlockIndex++;
        }
      }
      break;
    }

    case "tool_call": {
      if (subtype === "started") {
        const tc = evt.tool_call as Record<string, unknown> | undefined;
        const callId = evt.call_id as string ?? "";
        let toolName = "";
        let toolInput = {};
        if (tc) {
          const key = Object.keys(tc)[0];
          if (key) {
            toolName = key.replace(/Call$/, "");
            const inner = tc[key] as Record<string, unknown> | undefined;
            toolInput = inner?.args ?? {};
          }
        }
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: callId,
              name: toolName,
              input: toolInput,
            },
          },
        }));
      } else if (subtype === "completed") {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      }
      break;
    }

    case "result": {
      const usage = evt.usage as Record<string, unknown> | undefined;
      lines.push(JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: usage?.inputTokens ?? 0,
            output_tokens: usage?.outputTokens ?? 0,
          },
        },
      }));
      lines.push(JSON.stringify({
        type: "result",
        result: evt.result ?? "",
        session_id: evt.session_id ?? "",
        is_error: evt.is_error === true,
      }));
      break;
    }

    case "user":
      break;
  }

  return lines;
}

export function createCursorNormalizer(): {
  pushLine: (line: string) => string[];
  reset: () => void;
} {
  return {
    pushLine(line) {
      return normalizeCursorEvent(line);
    },
    reset() {
      contentBlockIndex = 0;
      inThinkingBlock = false;
    },
  };
}
