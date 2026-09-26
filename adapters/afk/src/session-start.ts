#!/usr/bin/env node

/**
 * SessionStart hook — inject a rule digest at the start of every session.
 *
 * Loads instruction files (CLAUDE.md, AGENTS.md, AFK.md, rules dirs),
 * classifies rules (cached by content hash; first run calls Jev API),
 * and injects a structured summary into the session's first outbound
 * message via injectContext.
 *
 * Fail-open: exits 0 with no output on any error.
 * Env: TYPESAFE_API_KEY or OPENROUTER_API_KEY (for first-time classification;
 * cached runs need no API call).
 */

import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { loadRules } from "./shared/rule-parser.js";
import { formatDigest } from "./shared/digest.js";

interface SessionStartEvent {
  session_id?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const event = await readStdinJson<SessionStartEvent>();
  const cwd = event.cwd || process.cwd();

  const allRules = await loadRules(cwd);

  // loadRules already filters to instruction rules (not process rules)
  if (allRules.length === 0) return;

  const digest = formatDigest(allRules);

  if (!digest) return;

  writeOutput({
    hookSpecificOutput: {
      additionalContext: digest,
    },
  });
}

try {
  await main();
} catch {
  // Fail open
}
