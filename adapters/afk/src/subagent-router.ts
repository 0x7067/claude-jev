#!/usr/bin/env node

import { readStdinJson } from "./shared/stdin.ts";
import { writeOutput } from "./shared/stdout.ts";
import { jevAsk } from "./shared/jev-client.ts";
import { subagentBundle, BRIEF_PARTS } from "./shared/questions.ts";
import { asNoul, asChoice } from "./shared/jev-client.ts";
import type { PreToolUseOutput } from "./shared/stdout.ts";

const MIN_CONFIDENCE = 0.75;

const BRIEF_MISSING = 0.25;

interface PreToolUseEvent {
  tool_name?: string;
  tool_input?: {
    prompt?: string;
    model?: string;
    agent_type?: string;
  };
  session_id?: string;
  cwd?: string;
}

async function main(): Promise<void> {
  const event = await readStdinJson<PreToolUseEvent>();
  const inp = event.tool_input ?? {};

  if (inp.model) return;

  const briefText = (inp.prompt ?? "").slice(0, 8000);

  if (!briefText.trim()) return;

  const state = [
    `Agent type: ${inp.agent_type ?? "general"}`,
    `Task: ${briefText}`,
  ].join("\n\n");

  const answers = await jevAsk(state, subagentBundle(true));

  const tierA = asChoice(answers["model_tier"]);

  const tierChoice = tierA?.choice;
  const tierConf = tierA?.confidence ?? 0;

  const briefWrites = asNoul(answers["brief_writes"])?.noul ?? 0;

  const out: PreToolUseOutput = {
    hookSpecificOutput: { hookEventName: "PreToolUse" },
  };

  if (tierChoice && tierConf >= MIN_CONFIDENCE) {
    out.hookSpecificOutput!.additionalContext =
      `[jev] recommended model tier: ${tierChoice} for this delegation`;
  }

  if (briefWrites >= MIN_CONFIDENCE) {
    const missing: string[] = [];

    for (const key of BRIEF_PARTS.keys()) {
      const noul = asNoul(answers[key])?.noul ?? 1;

      if (noul <= BRIEF_MISSING) missing.push(key);
    }

    if (missing.length > 0) {
      const listed = missing.map((k) => BRIEF_PARTS.get(k)!).join("; ");

      const qualityNote =
        `[jev] brief quality: missing ${listed}. ` +
        `The subagent cannot see this conversation — add the missing parts to the prompt.`;

      const existing = out.hookSpecificOutput!.additionalContext;
      out.hookSpecificOutput!.additionalContext = existing
        ? `${existing}\n${qualityNote}`
        : qualityNote;
    }
  }

  const hasContent = out.hookSpecificOutput?.additionalContext;

  if (hasContent) {
    writeOutput(out);
  }
}

try {
  await main();
} catch {
}
