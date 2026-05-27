#!/usr/bin/env bun
/**
 * Standalone `mittens` entry — the human/harness-facing front door.
 *
 * Responsibilities, kept deliberately thin:
 *   1. `--help` / `--version` / `--list-adapters` meta-commands.
 *   2. Parse `--adapter=<id>` to select the target CLI (default: claude).
 *   3. Run the engine (wrapper.ts, always-on stream-json) under the SAME Bun
 *      runtime and adapt its NDJSON to the caller's requested --output-format
 *      (text / json / stream-json) via the pure transform in output.ts.
 *
 * Re-spawning the engine as a child — rather than importing main() — keeps the
 * stdout boundary honest: the engine writes its NDJSON to its own stdout and we
 * filter it line-by-line, exactly as OpenClaw spawns the engine in production.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAdapter, parseClaudeOutputFormat, stripPrintModeFlags } from "./cli-args.js";
import { helpText, listAdaptersText, parseTopLevelIntent, versionText } from "./help.js";
import { parseResultRecord, renderEngineLine } from "./output.js";

const args = process.argv.slice(2);
const intent = parseTopLevelIntent(args);
if (intent === "help") {
  process.stdout.write(`${helpText()}\n`);
  process.exit(0);
}
if (intent === "version") {
  process.stdout.write(`${versionText()}\n`);
  process.exit(0);
}
if (intent === "list") {
  process.stdout.write(`${listAdaptersText()}\n`);
  process.exit(0);
}

const { adapter, rest: argsWithoutAdapter } = parseAdapter(args);
const format = parseClaudeOutputFormat(argsWithoutAdapter);
const engineArgs = stripPrintModeFlags(argsWithoutAdapter);
const enginePath = fileURLToPath(new URL("./wrapper.ts", import.meta.url));
const child = spawn(process.execPath, [enginePath, `--adapter=${adapter}`, ...engineArgs], {
  stdio: ["inherit", "pipe", "inherit"],
});

let sawErrorResult = false;
let buffer = "";

function handleLine(line: string): void {
  if (parseResultRecord(line)?.isError) {
    sawErrorResult = true;
  }
  const rendered = renderEngineLine(format, line);
  if (rendered) {
    process.stdout.write(rendered);
  }
}

if (child.stdout) {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

child.on("error", (err) => {
  process.stderr.write(`[mittens] failed to spawn engine: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (buffer.trim()) {
    handleLine(buffer);
    buffer = "";
  }
  if (sawErrorResult && (code === 0 || code === null)) {
    process.exit(1);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
