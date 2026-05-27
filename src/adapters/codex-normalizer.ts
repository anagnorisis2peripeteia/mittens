/**
 * Codex -> Claude stream-json normalizer.
 *
 * Transforms OpenAI Responses API WebSocket events (as captured by the
 * MITM tap) into Claude's stream-json JSONL format so OpenClaw's CLI
 * runner pipeline can consume Codex output unchanged.
 */

let contentBlockIndex = 0;

export function normalizeCodexEvent(evt: Record<string, unknown>): string[] {
  const type = evt.type as string;
  const source = evt._source as string | undefined;
  const lines: string[] = [];

  switch (type) {
    case "response.created": {
      if (source !== "upstream") break;
      const resp = evt.response as Record<string, unknown> | undefined;
      lines.push(JSON.stringify({
        type: "init",
        session_id: resp?.id ?? "",
      }));
      const model = resp?.model ?? evt.model ?? "";
      lines.push(JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { model, role: "assistant", content: [] },
        },
      }));
      contentBlockIndex = 0;
      break;
    }

    case "response.output_item.added": {
      if (source !== "upstream") break;
      const item = evt.item as Record<string, unknown> | undefined;
      if (!item) break;

      if (item.type === "reasoning") {
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
            delta: {
              type: "thinking_delta",
              thinking: item.encrypted_content ? "[encrypted reasoning]" : "",
            },
          },
        }));
        lines.push(JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: contentBlockIndex },
        }));
        contentBlockIndex++;
      } else if (item.type === "message") {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          },
        }));
      } else if (item.type === "function_call") {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: item.call_id ?? item.id ?? "",
              name: item.name ?? "",
              input: {},
            },
          },
        }));
      }
      break;
    }

    case "response.output_text.delta": {
      if (source !== "upstream") break;
      const delta = evt.delta as string ?? "";
      if (delta) {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text: delta },
          },
        }));
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      if (source !== "upstream") break;
      const argDelta = evt.delta as string ?? "";
      if (argDelta) {
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "input_json_delta", partial_json: argDelta },
          },
        }));
      }
      break;
    }

    case "response.output_item.done": {
      if (source !== "upstream") break;
      const doneItem = evt.item as Record<string, unknown> | undefined;
      if (doneItem?.type === "reasoning") break;
      lines.push(JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: contentBlockIndex },
      }));
      contentBlockIndex++;
      break;
    }

    case "response.completed": {
      if (source !== "upstream") break;
      const resp = evt.response as Record<string, unknown> | undefined;
      const usage = resp?.usage as Record<string, unknown> | undefined;
      const output = resp?.output as Array<Record<string, unknown>> | undefined;

      let resultText = "";
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content as Array<Record<string, unknown>>) {
              if (part.type === "output_text" && typeof part.text === "string") {
                resultText += part.text;
              }
            }
          }
        }
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
        type: "result",
        result: resultText,
        session_id: resp?.id ?? "",
        is_error: false,
      }));
      break;
    }
  }

  return lines;
}

export function createCodexNormalizer(): {
  push: (evt: Record<string, unknown>) => string[];
  reset: () => void;
} {
  return {
    push(evt) {
      return normalizeCodexEvent(evt);
    },
    reset() {
      contentBlockIndex = 0;
    },
  };
}
