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
export {};
