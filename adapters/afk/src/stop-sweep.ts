#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { jevAsk } from "./shared/jev-client.js";
import type { Answers, NoulQuestion } from "./shared/jev-client.js";
import { loadRules, globMatch, isSubjectRelevant, type Rule } from "./shared/rule-parser.js";
import { slugify } from "./shared/utils.js";
import { loadState, saveState } from "./shared/state.js";

const ACT = 0.80;
const FLAG = 0.50;
const MAX_STOP_BLOCKS = 2;
const MAX_TURN_CHARS = 16000;

interface StopEvent {
  session_id?: string;
  cwd?: string;
}

interface EditRecord {
  rel: string;
  hunk: string;
}

function editsFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, "_");
  return path.join(os.tmpdir(), `jev-afk-${safe}-edits.jsonl`);
}

function loadEdits(sessionId: string): EditRecord[] {
  try {
    const raw = fs.readFileSync(editsFilePath(sessionId), "utf8");
    const records: EditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as EditRecord;
        if (r.rel && r.hunk) records.push(r);
      } catch {
      }
    }
    return records;
  } catch {
    return [];
  }
}

function turnRuleQuestion(rule: Rule): NoulQuestion {
  if (rule.polarity === "require") {
    return {
      type: "noul",
      instructions:
        `Do these changes add or change code that this rule clearly covers, ` +
        `and do it WITHOUT what the rule requires: "${rule.text}"? ` +
        `Answer yes only when both hold and the requirement is plainly missing.`,
      criteria: {
        true: "A case the rule governs was added, and the required element is absent.",
        false:
          "The rule does not govern what changed, or the requirement is met.",
      },
    };
  }
  return {
    type: "noul",
    instructions:
      `Do the ADDED or CHANGED parts of these changes do what this rule forbids: ` +
      `"${rule.text}"? Judge only what was introduced, not pre-existing code.`,
    criteria: {
      true: "The new code visibly does the forbidden thing.",
      false: "The changes do not do it, or only remove code that did.",
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
  const event = await readStdinJson<StopEvent>();
  const sessionId = event.session_id ?? "unknown";
  const cwd = event.cwd ?? process.cwd();

  const edits = loadEdits(sessionId);
  if (edits.length === 0) return;

  let rules: Rule[];
  try {
    rules = await loadRules(cwd);
  } catch {
    return;
  }

  const changedFiles = [...new Set(edits.map((e) => e.rel))];
  const turnRules = rules.filter(
    (r) =>
      r.when === "turn" &&
      (r.scope.length === 0 || changedFiles.some((f) => globMatch(f, r.scope)))
  );
  if (turnRules.length === 0) return;

  const diff = edits
    .map((e) => `--- ${e.rel}\n${e.hunk}`)
    .join("\n\n")
    .slice(0, MAX_TURN_CHARS);

  const stateText = [
    `Files changed this turn: ${changedFiles.join(", ")}`,
    `The changes:\n${diff}`,
  ].join("\n\n");

  const questions: Record<string, NoulQuestion> = {};
  const qkeyMap = new Map<Rule, string>();
  const seen = new Set<string>();
  for (const r of turnRules) {
    if (!isSubjectRelevant(diff, r.subject, changedFiles.join(", "))) continue;
    let key = slugify(r.text);
    let n = 2;
    while (seen.has(key)) {
      key = `${slugify(r.text)}-${n++}`;
    }
    seen.add(key);
    qkeyMap.set(r, key);
    questions[key] = turnRuleQuestion(r);
  }

  if (Object.keys(questions).length === 0) return;

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
  for (const r of turnRules) {
    const key = qkeyMap.get(r);
    if (!key) continue;
    const prob = verdict(answers[key]);
    if (prob >= FLAG) {
      hits.push({ rule: r, prob, band: prob >= ACT ? "act" : "flag" });
    }
  }

  if (hits.length === 0) return;

  const state = loadState(sessionId);
  const acting: Hit[] = [];
  for (const h of hits) {
    if (h.band === "act" && state.stopBlocks < MAX_STOP_BLOCKS) {
      state.stopBlocks++;
      acting.push(h);
    }
  }
  saveState(sessionId, state);

  const flagged = hits.filter((h) => !acting.includes(h));

  if (flagged.length > 0) {
    const listed = flagged
      .map((h) => `${h.rule.id} ${h.prob.toFixed(2)}`)
      .join(", ");
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: `[jev rules] uncertain about ${listed} at end of turn`,
      },
    });
    return;
  }

  if (acting.length > 0) {
    const lines = [
      "The changes this turn appear to break a rule from this repository's instructions.",
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
    lines.push(
      `Repair ${changedFiles.join(", ")} before you finish. Keep the fix to what the rule asks.`
    );

    const ctx = lines.join("\n");
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: ctx,
      },
      decision: "block",
      reason: ctx,
    });
  }
}

try {
  await main();
} catch {
}
