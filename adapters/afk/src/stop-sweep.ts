#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStdinJson } from "./shared/stdin.ts";
import { writeOutput } from "./shared/stdout.ts";
import { jevAsk, asNoul } from "./shared/jev-client.ts";
import type { Answers, NoulQuestion } from "./shared/jev-client.ts";
import { isString, parseJsonObject } from "./shared/json.ts";
import { loadRules, globMatch, isSubjectRelevant, type Rule } from "./shared/rule-parser.ts";
import { slugify } from "./shared/utils.ts";
import { loadState, saveState } from "./shared/state.ts";
import {
  logCheck,
  logCheckError,
  logRulesLoadFailure,
  logSkip,
  loggedRuleKeys,
  probsByRule,
  type CheckContext,
  type CheckHit,
} from "./shared/check-log.ts";

const ACT = 0.80;

const FLAG = 0.50;

const MAX_STOP_BLOCKS = 2;

const SWEEP_BUDGET_MS = 4500;

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

      const d = parseJsonObject(line);

      if (d !== null && isString(d["rel"]) && isString(d["hunk"])) {
        records.push({ rel: d["rel"], hunk: d["hunk"] });
      }
    }

    return records;
  } catch {
    return [];
  }
}

function consumeEdits(sessionId: string): void {
  try {
    fs.rmSync(editsFilePath(sessionId), { force: true });
  } catch {
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

function verdict(answer: Answers[string] | undefined): number {
  const p = asNoul(answer)?.noul;

  return p === undefined ? 0 : Math.min(1, Math.max(0, p));
}

async function main(): Promise<void> {
  const event = await readStdinJson<StopEvent>();
  const sessionId = event.session_id;

  if (!sessionId) return;

  const cwd = event.cwd ?? process.cwd();

  const edits = loadEdits(sessionId);

  if (edits.length === 0) return;

  const ctx: CheckContext = { phase: "turn", sessionId, cwd, file: null };
  let rules: Rule[];
  const deadline = performance.now() + SWEEP_BUDGET_MS;
  const started = performance.now();

  try {
    rules = await loadRules(cwd, { afkRules: true, timeoutMs: Math.max(1, Math.round(deadline - performance.now())) });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));

    logRulesLoadFailure(ctx, error, Math.round(performance.now() - started));

    return;
  }

  const changedFiles = [...new Set(edits.map((e) => e.rel))];

  const turnRules = rules.filter(
    (r) =>
      r.when === "turn" &&
      (r.scope.length === 0 || changedFiles.some((f) => globMatch(f, r.scope)))
  );

  if (turnRules.length === 0) {
    logSkip(ctx, rules.length === 0 ? "no-rules" : "none-in-scope", rules.length);
    consumeEdits(sessionId);

    return;
  }

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

  if (Object.keys(questions).length === 0) {
    logSkip(ctx, "none-relevant", rules.length);
    consumeEdits(sessionId);

    return;
  }

  let answers: Answers;
  const t0 = performance.now();
  const jevMs = Math.max(1, Math.round(deadline - t0));

  try {
    answers = await jevAsk(stateText, questions, jevMs);
  } catch (e) {
    logCheckError(ctx, String(e), Math.round(performance.now() - t0));

    return;
  }

  const ms = Math.round(performance.now() - t0);

  consumeEdits(sessionId);

  type Hit = CheckHit;

  const asked = turnRules.filter((r) => qkeyMap.has(r));
  const logKeys = loggedRuleKeys(asked);
  const hits: Hit[] = [];

  for (const r of asked) {
    const key = qkeyMap.get(r);

    if (!key) continue;
    const prob = verdict(answers[key]);
    const logKey = logKeys.get(r) ?? r.id;

    if (prob >= FLAG) {
      hits.push({ rule: r, logKey, prob, band: prob >= ACT ? "act" : "flag" });
    }
  }

  const tally = {
    nRules: rules.length,
    nScopedOut: rules.length - turnRules.length,
    nIrrelevant: turnRules.length - asked.length,
    probs: probsByRule(asked, (r) => qkeyMap.get(r), (k) => verdict(answers[k])),
    hits,
    ms,
  };

  if (hits.length === 0) {
    logCheck(ctx, { ...tally, blocked: [] });

    return;
  }

  const state = loadState(sessionId);
  const acting: Hit[] = [];

  for (const h of hits) {
    if (h.band === "act" && state.stopBlocks < MAX_STOP_BLOCKS) {
      state.stopBlocks++;
      acting.push(h);
    }
  }

  saveState(sessionId, state);
  logCheck(ctx, { ...tally, blocked: acting.map((h) => h.logKey) });

  const flagged = hits.filter((h) => !acting.includes(h));
  const lines: string[] = [];

  if (acting.length > 0) {
    lines.push(
      "The changes in the last turn appear to break a rule from this repository's instructions."
    );

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
      `Repair ${changedFiles.join(", ")} unless the user says otherwise. Keep the fix to what the rule asks.`
    );
  }

  const uncertain = flagged.filter((h) => h.band === "flag");
  const raised = flagged.filter((h) => h.band === "act");
  const listed = (rows: Hit[]) => rows.map((h) => `${h.rule.id} ${h.prob.toFixed(2)}`).join(", ");

  if (uncertain.length > 0) {
    lines.push(`[jev rules] uncertain about ${listed(uncertain)} at end of turn`);
  }

  if (raised.length > 0) {
    lines.push(
      `[jev rules] ${listed(raised)} at end of turn omitted because this session already used its two turn blocks`
    );
  }

  if (lines.length === 0) return;

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: lines.join("\n"),
    },
  });
}

try {
  await main();
} catch {
}
