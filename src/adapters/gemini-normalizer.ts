/**
 * Gemini API wire format -> Claude stream-json normalizer.
 *
 * Transforms raw MITM-intercepted Gemini API SSE events (from
 * /v1internal:streamGenerateContent) into Claude's stream-json JSONL.
 *
 * Gemini wire format (SSE data: lines parsed by mitm-server):
 *   {response:{candidates:[{content:{role:"model",parts:[{thought:true,text:"..."}]}}]}}  -- thinking
 *   {response:{candidates:[{content:{role:"model",parts:[{text:"..."}]}}]}}               -- text
 *   {response:{candidates:[{...finishReason:"STOP"}],usageMetadata:{...}}}                -- final
 *
 * Non-streaming endpoints (generateContent, loadCodeAssist, etc.) are
 * emitted as api_response events — we ignore those here.
 */

let contentBlockIndex = 0;
let inThinkingBlock = false;
let inTextBlock = false;
let messageStarted = false;

export function normalizeGeminiEvent(evt: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const evtType = evt.type as string | undefined;

  // Skip non-streaming events (request, api_response, api_error, etc.)
  if (evtType === "request" || evtType === "api_response" || evtType === "api_error") {
    return [];
  }

  // The streaming events from streamGenerateContent come through as parsed
  // SSE data objects with a top-level "response" field
  const response = evt.response as Record<string, unknown> | undefined;
  if (!response) return [];

  const candidates = response.candidates as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const candidate = candidates[0]!;
  const content = candidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  const finishReason = candidate.finishReason as string | undefined;
  const usage = response.usageMetadata as Record<string, unknown> | undefined;
  const model = response.modelVersion as string ?? "gemini";

  // Emit message_start on first streaming event
  if (!messageStarted) {
    messageStarted = true;
    lines.push(JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model, role: "assistant", content: [] },
      },
    }));
  }

  if (Array.isArray(parts)) {
    for (const part of parts) {
      const isThought = part.thought === true;
      const text = typeof part.text === "string" ? part.text : undefined;
      // thoughtSignature marks the final chunk — no user-facing content
      if (part.thoughtSignature !== undefined && !text) continue;

      if (isThought && text) {
        if (!inThinkingBlock) {
          // Close any open text block first
          if (inTextBlock) {
            lines.push(JSON.stringify({
              type: "stream_event",
              event: { type: "content_block_stop", index: contentBlockIndex },
            }));
            contentBlockIndex++;
            inTextBlock = false;
          }
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
        lines.push(JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "thinking_delta", thinking: text },
          },
        }));
      } else if (text !== undefined) {
        // Close any open thinking block first
        if (inThinkingBlock) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_stop", index: contentBlockIndex },
          }));
          contentBlockIndex++;
          inThinkingBlock = false;
        }
        if (!inTextBlock) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            },
          }));
          inTextBlock = true;
        }
        if (text) {
          lines.push(JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "text_delta", text },
            },
          }));
        }
      }
    }
  }

  // Final chunk with finishReason
  if (finishReason) {
    if (inThinkingBlock) {
      lines.push(JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: contentBlockIndex },
      }));
      contentBlockIndex++;
      inThinkingBlock = false;
    }
    if (inTextBlock) {
      lines.push(JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: contentBlockIndex },
      }));
      contentBlockIndex++;
      inTextBlock = false;
    }

    const stopReason = finishReason === "STOP" ? "end_turn"
      : finishReason === "MAX_TOKENS" ? "max_tokens"
      : "end_turn";

    lines.push(JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage?.promptTokenCount ?? 0,
          output_tokens: usage?.candidatesTokenCount ?? 0,
        },
      },
    }));
    lines.push(JSON.stringify({
      type: "stream_event",
      event: { type: "message_stop" },
    }));
  }

  return lines;
}

export function resetGeminiNormalizer(): void {
  contentBlockIndex = 0;
  inThinkingBlock = false;
  inTextBlock = false;
  messageStarted = false;
}
