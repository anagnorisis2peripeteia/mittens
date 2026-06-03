/**
 * Codex exec --json -> Claude stream-json normalizer.
 *
 * Transforms `codex exec --json` JSONL events (stdout-piped) into
 * Claude's stream-json JSONL format. This path gives visible
 * commentary (intermediate agent_message items) that the MITM
 * WebSocket path encrypts.
 *
 * Codex exec --json event types:
 *   thread.started       — {thread_id}
 *   turn.started         — (no payload)
 *   item.started         — {item: {id, type: "command_execution"|"agent_message", ...}}
 *   item.completed       — {item: {id, type, text|aggregated_output, exit_code, status}}
 *   turn.completed       — {usage: {input_tokens, output_tokens, reasoning_output_tokens}}
 *
 * agent_message items are the model's visible commentary. Intermediate
 * ones (before tool calls or other items follow) surface as
 * thinking_delta. The final agent_message becomes the result text.
 */

let contentBlockIndex = 0;
let messageStarted = false;
let threadId = "";
let lastAgentMessageText = "";
let pendingAgentMessages: string[] = [];

function emitMessageStart(model: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { model, role: "assistant", content: [] },
    },
  });
}

export function normalizeCodexExecEvent(evt: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const rawLine = evt._rawLine as string | undefined;
  if (!rawLine) return [];

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawLine) as Record<string, unknown>; } catch { return []; }

  const type = parsed.type as string;

  switch (type) {
    case "thread.started": {
      threadId = (parsed.thread_id as string) ?? "";
      lines.push(JSON.stringify({ type: "init", session_id: threadId }));
      break;
    }

    case "turn.started": {
      if (!messageStarted) {
        messageStarted = true;
        lines.push(emitMessageStart("gpt-5.5"));
      }
      break;
    }

    case "item.started": {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (!item) break;

      // Flush any pending commentary as thinking before the tool call
      for (const text of pendingAgentMessages) {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "thinking_delta", thinking: text },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      }
      pendingAgentMessages = [];

      if (item.type === "command_execution") {
        const cmd = (item.command as string) ?? "";
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: (item.id as string) ?? "",
              name: "Bash",
              input: {},
            },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: cmd }) },
          },
        }));
      }
      break;
    }

    case "item.completed": {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (!item) break;

      if (item.type === "command_execution") {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      } else if (item.type === "agent_message") {
        const text = (item.text as string) ?? "";
        lastAgentMessageText = text;
        pendingAgentMessages.push(text);
      }
      break;
    }

    case "turn.completed": {
      const usage = parsed.usage as Record<string, unknown> | undefined;

      // The last agent_message is the actual result — pop it from pending
      // commentary and emit as text instead of thinking
      const resultText = lastAgentMessageText;
      if (pendingAgentMessages.length > 0) {
        pendingAgentMessages.pop();
      }

      // Flush remaining commentary as thinking
      for (const text of pendingAgentMessages) {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "thinking_delta", thinking: text },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      }
      pendingAgentMessages = [];

      // Emit result text as a text block
      if (resultText) {
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
            delta: { type: "text_delta", text: resultText },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      }

      lines.push(JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
          },
        },
      }));
      lines.push(JSON.stringify({
        type: "stream_event",
        event: { type: "message_stop" },
      }));
      break;
    }
  }

  return lines;
}

export function resetCodexExecNormalizer(): void {
  contentBlockIndex = 0;
  messageStarted = false;
  threadId = "";
  lastAgentMessageText = "";
  pendingAgentMessages = [];
}

// Legacy MITM normalizer — kept for reference but no longer used by the adapter
export function normalizeCodexEvent(evt: Record<string, unknown>): string[] {
  return normalizeCodexExecEvent(evt);
}

export function createCodexNormalizer(): {
  push: (evt: Record<string, unknown>) => string[];
  reset: () => void;
} {
  return {
    push(evt) {
      return normalizeCodexExecEvent(evt);
    },
    reset() {
      resetCodexExecNormalizer();
    },
  };
}
