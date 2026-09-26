#!/usr/bin/env node

import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput } from "../adapters/afk/src/shared/stdout.ts";
import { loadRules } from "../adapters/afk/src/shared/rule-parser.ts";
import { formatDigest } from "../adapters/afk/src/shared/digest.ts";
import { configDir } from "../adapters/afk/src/shared/config.ts";

interface SessionStartEvent {
  session_id?: string;
  cwd?: string;
  source?: string;
}

function cachePath(): string {
  return path.join(configDir(), "jev-ts-rules-cache.json");
}

async function main(): Promise<void> {
  const event = await readStdinJson<SessionStartEvent>();
  const cwd = event.cwd || process.cwd();

  const allRules = await loadRules(cwd, { cachePath: cachePath() });

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
