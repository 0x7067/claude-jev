#!/usr/bin/env node

import fs from "node:fs";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput } from "../adapters/afk/src/shared/stdout.ts";
import {
  jevAsk,
  asChoice,
  asNoul,
  asScore,
  type Answers,
} from "../adapters/afk/src/shared/jev-client.ts";
import { intentBundle } from "../adapters/afk/src/shared/questions.ts";
import { isSynthetic } from "../adapters/afk/src/shared/synthetic.ts";
import {
  isJsonObject,
  isJsonArray,
  isString,
  parseJsonObject,
  textOf,
  type Json,
} from "../adapters/afk/src/shared/json.ts";
import { appendLogLine, enabled, pluginVersion, ROUTER_LOG } from "../adapters/afk/src/shared/config.ts";

const MIN_CONFIDENCE = 0.75;

const MAX_QUIET = 0.1;

const CONTEXT_LINES = 400;

const GUIDANCE = new Map<string, string>([
  ["chat", "Answer directly from the conversation. No file reads, no commands."],
  ["lookup", "Fact-finding — one targeted search, concise answer, then stop."],
  ["fix", "Small change — locate the code, make a focused edit, run the narrowest verification."],
]);

interface PromptEvent {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
}

interface TranscriptEntry {
  isSidechain?: boolean;
  type?: string;
  message?: Json;
}

interface TailResult {
  prevUser: string;
  prevAssistant: string;
}

function conversationTail(transcriptPath: string, prompt: string): TailResult {
  let lines: string[];

  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").slice(-CONTEXT_LINES);
  } catch {
    return { prevUser: "", prevAssistant: "" };
  }

  let prevUser = "";
  let prevAssistant = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    if (prevUser && prevAssistant) break;
    const line = lines[i]!;

    if (line.length > 500_000) continue;

    const data = parseJsonObject(line);

    if (data === null) continue;

    const entry: TranscriptEntry = {
      isSidechain: data["isSidechain"] === true,
      type: isString(data["type"]) ? data["type"] : undefined,
      message: isJsonObject(data["message"]) ? data["message"] : undefined,
    };

    if (entry.isSidechain) continue;
    const content = entry.message;

    if (entry.type === "user" && !prevUser) {
      const text = textOf(content).trim();

      if (text && text !== prompt && !text.startsWith("<")) prevUser = text;
    } else if (entry.type === "assistant" && isJsonArray(content)) {
      if (!prevAssistant) prevAssistant = textOf(content).trim();
    }
  }

  return { prevUser, prevAssistant };
}

function buildState(prompt: string, prevUser: string, prevAssistant: string): string {
  if (!prevUser && !prevAssistant) return prompt;
  const parts: string[] = [];

  if (prevUser) parts.push(`Earlier user message: ${prevUser.slice(0, 300)}`);

  if (prevAssistant) parts.push(`Assistant's last reply (truncated): ${prevAssistant.slice(-600)}`);
  parts.push(`Current user message: ${prompt}`);

  return parts.join("\n\n");
}

function decide(answers: Answers): string | null {
  const intent = asChoice(answers["intent"]);
  let picked = intent?.choice;
  let conf = intent?.confidence ?? 0;
  const tools = asNoul(answers["needs_tools"])?.noul;

  if (tools !== undefined && tools <= MAX_QUIET) {
    picked = "chat";
    conf = 1 - tools;
  } else if (!picked || picked === "chat" || !GUIDANCE.has(picked) || conf < MIN_CONFIDENCE) {
    return null;
  }

  const scope = asScore(answers["scope"])?.score;
  const parts = [`[jev router] intent=${picked} conf=${conf.toFixed(2)}`];

  if (scope !== undefined) {
    parts.push(`scope=${scope < 0.5 ? "trivial" : scope < 1.5 ? "small" : "substantial"}`);
  }

  let tip = GUIDANCE.get(picked)!;

  if (picked !== "chat" && scope !== undefined) {
    if (scope < 0.5) tip += " Keep it minimal.";
    else if (scope >= 1.5) tip += " Sketch the plan in a few bullets first.";
  }

  return `${parts.join(" ")}\n${tip}`;
}

function logDecision(
  event: PromptEvent,
  answers: Answers,
  hint: string | null,
  ms: number
): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      prompt: (event.prompt ?? "").slice(0, 200),
      answers,
      hint,
      ms,
      v: pluginVersion(),
    };

    appendLogLine(ROUTER_LOG, JSON.stringify(row));
  } catch {
  }
}

async function main(): Promise<void> {
  if (!enabled("promptRouter")) return;
  const event = await readStdinJson<PromptEvent>();
  const prompt = (event.prompt ?? "").trim();

  if (prompt.length < 3 || prompt.startsWith("/") || prompt.startsWith("#")) return;

  if (isSynthetic(prompt)) return;

  let prevUser = "";
  let prevAssistant = "";

  if (event.transcript_path) {
    const tail = conversationTail(event.transcript_path, prompt);
    prevUser = tail.prevUser;
    prevAssistant = tail.prevAssistant;
  }

  const started = performance.now();
  const answers = await jevAsk(buildState(prompt, prevUser, prevAssistant), intentBundle());
  const ms = Math.round(performance.now() - started);

  const ctx = decide(answers);
  logDecision(event, answers, ctx, ms);

  if (!ctx) return;
  writeOutput({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
}

try {
  await main();
} catch {
}
