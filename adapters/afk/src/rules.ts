#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { jevAsk } from "./shared/jev-client.js";
import type { Answers } from "./shared/jev-client.js";
import {
  loadRules,
  globMatch,
  isSubjectRelevant,
  type Rule,
} from "./shared/rule-parser.js";
import { slugify } from "./shared/utils.js";
import { loadState, saveState } from "./shared/state.js";

const ACT = 0.80;
const FLAG = 0.50;
const MAX_BLOCKS = 2;
const MAX_STATE_CHARS = 8000;

interface PostToolUseEvent {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: Array<{ old_string?: string; new_string?: string }>;
  };
  session_id?: string;
  cwd?: string;
}

function editsFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, "_");
  return path.join(os.tmpdir(), `jev-afk-${safe}-edits.jsonl`);
}

function appendEdit(sessionId: string, rel: string, hunk: string): void {
  try {
    const line = JSON.stringify({ rel, hunk: hunk.slice(0, 2000) }) + "\n";
    fs.appendFileSync(editsFilePath(sessionId), line);
  } catch {
  }
}

function editHunks(inp: PostToolUseEvent["tool_input"] = {}): string {
  if (Array.isArray(inp.edits)) {
    const parts: string[] = [];
    for (const e of inp.edits) {
      let hunk = "";
      if (e.old_string) hunk += `REMOVED:\n${e.old_string}\n`;
      if (e.new_string) hunk += `ADDED:\n${e.new_string}`;
      if (hunk) parts.push(hunk);
    }
    return parts.join("\n\n");
  }
  if (inp.old_string != null || inp.new_string != null) {
    let hunk = "";
    if (inp.old_string) hunk += `REMOVED:\n${inp.old_string}\n`;
    if (inp.new_string) hunk += `ADDED:\n${inp.new_string}`;
    return hunk;
  }
  return inp.content ?? "";
}

function ruleQuestion(rule: Rule): import("./shared/jev-client.js").NoulQuestion {
  if (rule.polarity === "require") {
    return {
      type: "noul",
      instructions:
        `Does this edit add or change code that this rule clearly covers, ` +
        `and do it WITHOUT what the rule requires: "${rule.text}"? ` +
        `Answer yes only when both hold and the requirement is plainly ` +
        `missing from the new code and the surrounding lines shown. ` +
        `If the rule does not apply to what changed, or the requirement ` +
        `is met even imperfectly, answer no.`,
      criteria: {
        true: "A case the rule clearly governs was added, and the required element is absent.",
        false:
          "The rule does not govern what changed, the requirement is present, " +
          "or it is a matter of degree or taste.",
      },
    };
  }
  return {
    type: "noul",
    instructions:
      `Does the ADDED or CHANGED code in this edit do what this rule forbids: ` +
      `"${rule.text}"? Judge only what the edit itself introduces, not pre-existing code.`,
    criteria: {
      true: "The new code visibly does the forbidden thing.",
      false:
        "The edit does not do it, or only removes or leaves untouched code that did.",
    },
  };
}

function verdict(answer: unknown): number {
  if (typeof answer !== "object" || answer === null) return 0;
  const p = (answer as Record<string, unknown>)["noul"];
  if (typeof p !== "number") return 0;
  return Math.min(1, Math.max(0, p));
}

async function main(): Promise<void> {
  const event = await readStdinJson<PostToolUseEvent>();
  const inp = event.tool_input ?? {};
  const cwd = event.cwd ?? process.cwd();
  const sessionId = event.session_id ?? "unknown";
  const filePath = inp.file_path ?? "";
  const rel = path.relative(cwd, filePath) || path.basename(filePath);

  const hunk = editHunks(inp).trim();
  if (!hunk) return;

  appendEdit(sessionId, rel, hunk);

  let rules: Rule[];
  try {
    rules = await loadRules(cwd);
  } catch {
    return;
  }
  if (rules.length === 0) return;

  const inScope = rules.filter(
    (r) =>
      r.when === "edit" &&
      (r.scope.length === 0 || globMatch(rel, r.scope))
  );
  if (inScope.length === 0) return;

  const relevant = inScope.filter((r) =>
    isSubjectRelevant(hunk, r.subject, rel)
  );
  if (relevant.length === 0) return;

  const questions: Record<string, import("./shared/jev-client.js").Question> = {};
  const qkeyMap = new Map<Rule, string>();
  const seen = new Set<string>();
  for (const r of relevant) {
    let key = slugify(r.text);
    let n = 2;
    while (seen.has(key)) {
      key = `${slugify(r.text)}-${n++}`;
    }
    seen.add(key);
    qkeyMap.set(r, key);
    questions[key] = ruleQuestion(r);
  }

  const stateText = [
    `File: ${rel}`,
    `The edit:\n${hunk.slice(0, MAX_STATE_CHARS)}`,
  ].join("\n\n");

  let answers: Answers;
  try {
    answers = await jevAsk(stateText, questions);
  } catch {
    return;
  }

  interface Hit {
    rule: Rule;
    prob: number;
    band: "act" | "flag";
  }
  const hits: Hit[] = [];
  for (const r of relevant) {
    const key = qkeyMap.get(r) ?? slugify(r.text);
    const prob = verdict(answers[key]);
    if (prob >= FLAG) {
      hits.push({ rule: r, prob, band: prob >= ACT ? "act" : "flag" });
    }
  }

  if (hits.length === 0) return;

  const state = loadState(sessionId);
  const acting: Hit[] = [];
  for (const h of hits) {
    const blockKey = `${h.rule.id}|${rel}`;
    if (h.band === "act" && (state.blocks[blockKey] ?? 0) < MAX_BLOCKS) {
      state.blocks[blockKey] = (state.blocks[blockKey] ?? 0) + 1;
      acting.push(h);
    }
  }
  saveState(sessionId, state);

  const flagged = hits.filter((h) => !acting.includes(h));

  if (acting.length > 0) {
    const lines = [
      "This edit appears to break a rule from this repository's instructions.",
    ];
    for (const h of acting) {
      let text = h.rule.text.replace(/\s+/g, " ");
      if (text.length > 220) text = text.slice(0, 217) + "...";
      const where = h.rule.line
        ? `${h.rule.file} line ${h.rule.line}`
        : h.rule.file;
      lines.push(
        `- [${h.rule.polarity}/${h.rule.subject}] Rule "${h.rule.id}" from ${where}: "${text}" (${h.prob.toFixed(2)})`
      );
    }
    lines.push(`Repair ${rel} now, then continue with the task.`);
    writeOutput({
      decision: "block",
      reason: lines.join("\n"),
    });
    return;
  }

  // FLAG-band hits: surface as advisory context (non-blocking)
  if (flagged.length > 0) {
    const lines = [`[jev rules] Uncertain rule match in ${rel}:`];
    for (const h of flagged) {
      let text = h.rule.text.replace(/\s+/g, " ");
      if (text.length > 200) text = text.slice(0, 197) + "...";
      lines.push(
        `  - ${h.rule.id} (${h.prob.toFixed(2)}): "${text}"`
      );
    }
    lines.push("Check these before marking the task Done.");
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as any,
        additionalContext: lines.join("\n"),
      },
    });
  }
}

try {
  await main();
} catch {
}
