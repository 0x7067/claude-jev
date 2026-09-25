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
import { loadRules, type Rule } from "./shared/rule-parser.js";

const MAX_RULES_IN_DIGEST = 40;
const MAX_DIGEST_CHARS = 3000;

interface SessionStartEvent {
  session_id?: string;
  cwd?: string;
}

function formatDigest(rules: Rule[]): string {
  const requireRules = rules.filter((r) => r.polarity === "require");
  const forbidRules = rules.filter((r) => r.polarity === "forbid");

  const lines: string[] = ["[jev rules] Active project rules:"];

  if (forbidRules.length > 0) {
    lines.push("");
    lines.push("FORBID:");
    for (const r of forbidRules.slice(0, MAX_RULES_IN_DIGEST)) {
      const scope = r.scope.length > 0 ? ` (${r.scope.join(", ")})` : "";
      lines.push(`  - ${r.text}${scope}`);
    }
  }

  if (requireRules.length > 0) {
    lines.push("");
    lines.push("REQUIRE:");
    for (const r of requireRules.slice(0, MAX_RULES_IN_DIGEST - forbidRules.length)) {
      const scope = r.scope.length > 0 ? ` (${r.scope.join(", ")})` : "";
      lines.push(`  - ${r.text}${scope}`);
    }
  }

  if (rules.length === 0) return "";

  lines.push("");
  lines.push(
    `${rules.length} rule(s) loaded. Edits violating these rules at >=0.80 confidence will be blocked.`
  );

  let digest = lines.join("\n");
  if (digest.length > MAX_DIGEST_CHARS) {
    digest = digest.slice(0, MAX_DIGEST_CHARS - 20) + "\n  ... (truncated)";
  }
  return digest;
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
