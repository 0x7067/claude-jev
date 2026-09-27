#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput, type PreToolUseOutput } from "../adapters/afk/src/shared/stdout.ts";
import {
  jevAsk,
  asNoul,
  asChoice,
  type Answers,
} from "../adapters/afk/src/shared/jev-client.ts";
import { subagentBundle, BRIEF_PARTS, TIERS, safeTier } from "../adapters/afk/src/shared/questions.ts";
import { appendLogLine, configDir, enabled, ROUTER_LOG } from "../adapters/afk/src/shared/config.ts";
import { isString, parseJsonObject, type Json } from "../adapters/afk/src/shared/json.ts";

const MIN_CONFIDENCE = 0.75;

const BRIEF_MISSING = 0.25;

const USER_RULES = "CLAUDE.md";

const INHERITING_BUILTINS = new Set(["", "general-purpose", "Explore", "Plan", "claude"]);

const MAX_AGENT_DIR_DEPTH = 12;

interface PreToolUseEvent {
  tool_input?: Json;
  session_id?: string;
  cwd?: string;
}

function userTierCriteria() {
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

function frontmatter(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;

  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }

  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

  if (!block) return out;

  for (const line of block[1]!.split(/\r?\n/)) {
    const m = /^(\w+)\s*:\s*["']?(.*?)["']?\s*$/.exec(line);

    if (m) out.set(m[1]!, m[2]!);
  }

  return out;
}

function markdownFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function agentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);

  for (let i = 0; i < MAX_AGENT_DIR_DEPTH; i++) {
    dirs.push(path.join(dir, ".claude", "agents"));
    const parent = path.dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  dirs.push(path.join(configDir(), "agents"));

  return dirs;
}

function pluginAgentFiles(scoped: string): string[] {
  const [plugin, ...rest] = scoped.split(":");
  const relative = `${path.join(...rest)}.md`;
  const cache = path.join(configDir(), "plugins", "cache");
  const out: string[] = [];

  try {
    for (const marketplace of fs.readdirSync(cache)) {
      const root = path.join(cache, marketplace, plugin!);

      for (const version of fs.readdirSync(root)) out.push(path.join(root, version, "agents", relative));
    }
  } catch {
  }

  return out;
}

function definedModel(subagentType: string, cwd: string): string | null | undefined {
  const candidates = subagentType.includes(":")
    ? pluginAgentFiles(subagentType)
    : agentDirs(cwd).flatMap(markdownFiles);

  for (const file of candidates) {
    const meta = frontmatter(file);
    const name = meta.get("name") || path.basename(file, ".md");

    if (subagentType.includes(":") ? meta.size > 0 : name === subagentType) return meta.get("model") || null;
  }

  return undefined;
}

function choosesOwnModel(subagentType: string, cwd: string): boolean {
  const envModel = process.env["CLAUDE_CODE_SUBAGENT_MODEL"];

  if (envModel && envModel !== "inherit") return true;
  const defined = definedModel(subagentType, cwd);

  if (defined === undefined) return !INHERITING_BUILTINS.has(subagentType);

  return defined !== null && defined !== "inherit";
}

function buildState(inp: Json, subagentType: string): string {
  const description = isString(inp["description"]) ? inp["description"] : "";
  const prompt = isString(inp["prompt"]) ? inp["prompt"] : "";
  const parts = [`Agent type: ${subagentType || "general"}`];

  if (description) parts.push(`Task summary: ${description}`);

  if (prompt) parts.push(`Task: ${prompt.slice(0, 8000)}`);

  return parts.join("\n\n");
}

function missingParts(answers: Answers): string[] {
  const writes = asNoul(answers["brief_writes"])?.noul ?? 0;

  if (writes < MIN_CONFIDENCE) return [];
  const missing: string[] = [];

  for (const key of BRIEF_PARTS.keys()) {
    if ((asNoul(answers[key])?.noul ?? 1) <= BRIEF_MISSING) missing.push(key);
  }

  return missing;
}

function alreadyDenied(sessionId: string | undefined, promptHead: string): boolean {
  try {
    const lines = fs.readFileSync(path.join(configDir(), ROUTER_LOG), "utf8").split("\n");

    for (const line of lines) {
      if (!line.includes('"subagent"')) continue;

      const row = parseJsonObject(line);

      if (row === null) continue;

      if (row["session_id"] === sessionId && row["brief_denied"] === true && row["prompt"] === promptHead) {
        return true;
      }
    }
  } catch {
  }

  return false;
}

function logDecision(
  event: PreToolUseEvent,
  inp: Json,
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
      prompt: isString(inp["prompt"]) ? inp["prompt"].slice(0, 200) : "",
      answers,
      model_routed: routed,
      model_explicit: explicit ?? null,
      brief_missing: missing,
      brief_denied: denied,
    };

    appendLogLine(ROUTER_LOG, JSON.stringify(row));
  } catch {
  }
}

async function main(): Promise<void> {
  if (!enabled("subagentRouter")) return;
  const event = await readStdinJson<PreToolUseEvent>();
  const inp: Json = event.tool_input ?? {};

  const modelRaw = inp["model"];
  const explicit = isString(modelRaw) && modelRaw ? modelRaw : undefined;
  const promptText = isString(inp["prompt"]) ? inp["prompt"] : "";
  const subagentType = isString(inp["subagent_type"]) ? inp["subagent_type"] : "";
  const routable = !explicit && !choosesOwnModel(subagentType, event.cwd ?? process.cwd());

  if (!promptText.trim()) return;

  const answers = await jevAsk(
    buildState(inp, subagentType),
    subagentBundle(routable, routable ? userTierCriteria() : undefined)
  );

  const tier = asChoice(answers["model_tier"]);
  const routed = safeTier(tier);

  const missing = missingParts(answers);
  const promptHead = promptText.slice(0, 200);
  const denied = missing.length > 0 && !alreadyDenied(event.session_id, promptHead);

  logDecision(event, inp, answers, routed, explicit, missing, denied);

  const listed = missing.map((k) => BRIEF_PARTS.get(k)!);

  if (denied) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `This brief changes files but does not state: ${listed.join("; ")}. ` +
          "The subagent sees none of this conversation. Add the missing parts to the prompt and spawn again.",
      },
    });

    return;
  }

  const notes: string[] = [];

  if (listed.length > 0) {
    notes.push(`[jev router] brief still missing ${listed.join(", ")} — spawned anyway (denied once already)`);
  }

  if (routed) notes.push(`[jev router] subagent → ${routed} (p=${(tier?.probabilities?.[routed] ?? 0).toFixed(2)})`);

  if (notes.length === 0) return;
  const out: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse" }, systemMessage: notes.join("\n") };

  if (routed) out.hookSpecificOutput!.updatedInput = { ...inp, model: routed };
  writeOutput(out);
}

try {
  await main();
} catch {
}
