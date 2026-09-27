#!/usr/bin/env node

import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput } from "../adapters/afk/src/shared/stdout.ts";
import { loadRules } from "../adapters/afk/src/shared/rule-parser.ts";
import { formatDigest } from "../adapters/afk/src/shared/digest.ts";
import { configDir, RULES_CACHE } from "../adapters/afk/src/shared/config.ts";

interface SessionStartEvent {
  session_id?: string;
  cwd?: string;
  source?: string;
}

async function main(): Promise<void> {
  const event = await readStdinJson<SessionStartEvent>();
  const cwd = event.cwd || process.cwd();

  const allRules = await loadRules(cwd, { cachePath: path.join(configDir(), RULES_CACHE) });

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
