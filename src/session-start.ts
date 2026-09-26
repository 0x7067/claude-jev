#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.js";
import { writeOutput } from "../adapters/afk/src/shared/stdout.js";
import { loadRules } from "../adapters/afk/src/shared/rule-parser.js";
import { formatDigest } from "../adapters/afk/src/shared/digest.js";

interface SessionStartEvent {
  session_id?: string;
  cwd?: string;
  source?: string;
}

function cachePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "jev-ts-rules-cache.json");
}

async function main(): Promise<void> {
  const event = await readStdinJson<SessionStartEvent>();
  const cwd = event.cwd || process.cwd();

  const allRules = await loadRules(cwd, cachePath());
  if (allRules.length === 0) return;

  const digest = formatDigest(allRules);
  if (!digest) return;

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: digest,
    },
  });
}

try {
  await main();
} catch {
}
