#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.js";
import { writeOutput, type PreToolUseOutput } from "../adapters/afk/src/shared/stdout.js";
import {
  jevAsk,
  asNoul,
  asChoice,
  type Answers,
} from "../adapters/afk/src/shared/jev-client.js";
import { subagentBundle, BRIEF_PARTS } from "../adapters/afk/src/shared/questions.js";
import { configDir, enabled } from "../adapters/afk/src/shared/config.js";

const MIN_CONFIDENCE = 0.75;
const BRIEF_MISSING = 0.25;
const ROUTER_LOG = "jev-router-log.jsonl";
const USER_RULES = "CLAUDE.md";
const TIERS = ["haiku", "sonnet", "opus", "fable"];

interface PreToolUseEvent {
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

function userTierCriteria(): Record<string, string> {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(configDir(), USER_RULES), "utf8").split("\n");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      inside = line
        .toLowerCase()
        .split("subagents")
        .join("sub-agents")
        .includes("delegating to sub-agents");
      continue;
    }
    if (!inside) continue;
    const m = /^\s*[-*]\s*`?(\w+)`?\s*:\s*(.+\S)\s*$/.exec(line);
    if (m && TIERS.includes(m[1]!.toLowerCase())) out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

function buildState(inp: Record<string, unknown>): string {
  const subagentType = typeof inp["subagent_type"] === "string" ? inp["subagent_type"] : "";
  const description = typeof inp["description"] === "string" ? inp["description"] : "";
  const prompt = typeof inp["prompt"] === "string" ? inp["prompt"] : "";
  const parts = [`Agent type: ${subagentType || "general"}`];
  if (description) parts.push(`Task summary: ${description}`);
  if (prompt) parts.push(`Task: ${prompt.slice(0, 8000)}`);
  return parts.join("\n\n");
}

function missingParts(answers: Answers): string[] {
  const writes = asNoul(answers["brief_writes"])?.noul ?? 0;
  if (writes < MIN_CONFIDENCE) return [];
  const missing: string[] = [];
  for (const key of Object.keys(BRIEF_PARTS)) {
    if ((asNoul(answers[key])?.noul ?? 1) <= BRIEF_MISSING) missing.push(key);
  }
  return missing;
}

function alreadyDenied(sessionId: string | undefined, promptHead: string): boolean {
  try {
    const lines = fs.readFileSync(path.join(configDir(), ROUTER_LOG), "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes('"subagent"')) continue;
      let row: { session_id?: unknown; brief_denied?: unknown; prompt?: unknown };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (row.session_id === sessionId && row.brief_denied === true && row.prompt === promptHead) {
        return true;
      }
    }
  } catch {
  }
  return false;
}

function logDecision(
  event: PreToolUseEvent,
  inp: Record<string, unknown>,
  answers: Answers,
  routed: string | null,
  explicit: string | undefined,
  missing: string[],
  denied: boolean
): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      kind: "subagent",
      session_id: event.session_id,
      cwd: event.cwd,
      subagent_type: inp["subagent_type"],
      prompt:
        typeof inp["prompt"] === "string" ? (inp["prompt"] as string).slice(0, 200) : "",
      answers,
      model_routed: routed,
      model_explicit: explicit ?? null,
      brief_missing: missing,
      brief_denied: denied,
    };
    fs.appendFileSync(path.join(configDir(), ROUTER_LOG), JSON.stringify(row) + "\n");
  } catch {
  }
}

async function main(): Promise<void> {
  if (!enabled("subagentRouter")) return;
  const event = await readStdinJson<PreToolUseEvent>();
  const inp = event.tool_input ?? {};

  const explicit = typeof inp["model"] === "string" && inp["model"] ? inp["model"] : undefined;
  const promptText = typeof inp["prompt"] === "string" ? inp["prompt"] : "";
  if (!promptText.trim()) return;

  const answers = await jevAsk(
    buildState(inp),
    subagentBundle(!explicit, userTierCriteria())
  );

  const tier = asChoice(answers["model_tier"]);
  const routed =
    tier && TIERS.includes(tier.choice) && tier.confidence >= MIN_CONFIDENCE
      ? tier.choice
      : null;
  const tierConf = tier?.confidence ?? 0;

  const missing = missingParts(answers);
  const promptHead = promptText.slice(0, 200);
  const denied = missing.length > 0 && !alreadyDenied(event.session_id, promptHead);

  logDecision(event, inp, answers, routed, explicit, missing, denied);

  const out: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse" } };
  if (denied) {
    const listed = missing.map((k) => BRIEF_PARTS[k]!).join("; ");
    out.hookSpecificOutput!.permissionDecision = "deny";
    out.hookSpecificOutput!.permissionDecisionReason =
      "This brief changes files but does not state: " +
      listed +
      ". The subagent sees none of this conversation. Add the missing parts to the prompt and spawn again.";
  } else if (missing.length > 0) {
    out.systemMessage =
      "[jev router] brief still missing " +
      missing.map((k) => BRIEF_PARTS[k]!).join(", ") +
      " — spawned anyway (denied once already)";
  }
  if (routed && !denied) {
    out.hookSpecificOutput!.updatedInput = { ...inp, model: routed };
    out.systemMessage = `[jev router] subagent → ${routed} (conf=${tierConf.toFixed(2)})`;
  }
  if (Object.keys(out.hookSpecificOutput!).length > 1 || out.systemMessage) {
    writeOutput(out);
  }
}

try {
  await main();
} catch {
}
