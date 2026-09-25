#!/usr/bin/env node

import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { jevAsk } from "./shared/jev-client.js";
import { intentBundle } from "./shared/questions.js";

const MIN_CONFIDENCE = 0.75;
const MAX_QUIET = 0.10;

const GUIDANCE: Record<string, string> = {
  chat: "Answer directly from the conversation. No file reads, no commands.",
  lookup: "Fact-finding — one targeted search, concise answer, then stop.",
  fix: "Small change — locate the code, make a focused edit, run the narrowest verification.",
};

interface UserPromptEvent {
  prompt?: string;
  session_id?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const event = await readStdinJson<UserPromptEvent>();
  const prompt = (event.prompt ?? "").trim();

  if (prompt.length < 3 || prompt[0] === "/" || prompt[0] === "#") return;

  const answers = await jevAsk(prompt, intentBundle());

  const needsToolsA = answers["needs_tools"] as { noul?: number } | undefined;
  const intentA = answers["intent"] as { choice?: string; confidence?: number } | undefined;
  const scopeA = answers["scope"] as { score?: number } | undefined;

  let choice = intentA?.choice ?? "";
  let conf = intentA?.confidence ?? 0;
  const needsTools = needsToolsA?.noul ?? 1;
  const scope = scopeA?.score;

  if (needsTools <= MAX_QUIET) {
    choice = "chat";
    conf = 1.0 - needsTools;
  }

  if (!choice || !(choice in GUIDANCE) || conf < MIN_CONFIDENCE) return;

  const parts = [`[jev router] intent=${choice} conf=${conf.toFixed(2)}`];
  if (scope != null) {
    const scopeLabel =
      scope < 0.5 ? "trivial" : scope < 1.5 ? "small" : "substantial";
    parts.push(`scope=${scopeLabel}`);
  }
  const line = parts.join(" ");

  let tip = GUIDANCE[choice]!;
  if (choice !== "chat" && scope != null) {
    if (scope < 0.5) tip += " Keep it minimal.";
    else if (scope >= 1.5) tip += " Sketch the plan in a few bullets first.";
  }

  const ctx = `${line}\n${tip}`;

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ctx,
    },
  });
}

try {
  await main();
} catch {
}
