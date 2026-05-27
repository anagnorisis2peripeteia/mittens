export type { AdapterId, AdapterMode, CliAdapter, MitmTarget, AdapterStreamFormat, SessionConfig, SessionMode, BundleMcpMode, ModelConfig, SystemPromptConfig } from "./types.js";
export { claudeAdapter } from "./claude.js";
export { codexAdapter } from "./codex.js";
export { geminiAdapter } from "./gemini.js";
export { cursorAdapter } from "./cursor.js";
export { antigravityAdapter } from "./antigravity.js";

import type { AdapterId, CliAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import { cursorAdapter } from "./cursor.js";
import { antigravityAdapter } from "./antigravity.js";

const ADAPTERS: Record<AdapterId, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  cursor: cursorAdapter,
  antigravity: antigravityAdapter,
};

export function getAdapter(id: AdapterId): CliAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Unknown adapter: ${id}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

export function listAdapters(): CliAdapter[] {
  return Object.values(ADAPTERS);
}

export function isAdapterId(value: string): value is AdapterId {
  return value in ADAPTERS;
}
