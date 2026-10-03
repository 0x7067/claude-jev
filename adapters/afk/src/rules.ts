#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStdinJson } from "./shared/stdin.ts";
import { writeOutput, type PreToolUseOutput } from "./shared/stdout.ts";
import {
  asNoul,
  DEFAULT_TIMEOUT_MS,
  jevAsk,
  type Answers,
  type NoulQuestion,
  type Questions,
} from "./shared/jev-client.ts";
import {
  loadRules,
  globMatch,
  isSubjectRelevant,
  type Rule,
} from "./shared/rule-parser.ts";
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
  type CheckResult,
} from "./shared/check-log.ts";
import { editTargets, type EditTarget, type EditToolInput } from "./shared/edit-targets.ts";

const ACT = 0.80;

const FLAG = 0.50;

const MAX_BLOCKS = 2;

const MAX_STATE_CHARS = 8000;

const BUDGET_MS = 12000;

const MAX_PARALLEL = 8;

const MIN_CALL_MS = 500;

interface PreToolUseEvent {
  tool_name?: string;
  tool_input?: EditToolInput;
  session_id?: string;
  cwd?: string;
}

function editsFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, "_");

  return path.join(os.tmpdir(), `jev-afk-${safe}-edits.jsonl`);
}

function appendEdits(sessionId: string, targets: EditTarget[]): void {
  try {
    const lines = targets
      .map((t) => JSON.stringify({ rel: t.rel, hunk: t.hunk.slice(0, 2000) }) + "\n")
      .join("");

    fs.appendFileSync(editsFilePath(sessionId), lines);
  } catch {
  }
}

function ruleQuestion(rule: Rule): NoulQuestion {
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

function verdict(answer: Answers[string] | undefined): number {
  const p = asNoul(answer)?.noul;

  return p === undefined ? 0 : Math.min(1, Math.max(0, p));
}

interface Assessment {
  target: EditTarget;
  ctx: CheckContext;
  hits: CheckHit[];
  tally: Omit<CheckResult, "blocked">;
}

interface Acting {
  target: EditTarget;
  hits: CheckHit[];
}

interface Verdict {
  block?: string;
  flag?: string;
}

function ruleKeys(relevant: Rule[]): Map<Rule, string> {
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
  }

  return qkeyMap;
}

async function assess(
  target: EditTarget,
  rules: Rule[],
  ctx: CheckContext,
  deadline: number
): Promise<Assessment | null> {
  const { hunk, rel } = target;

  const inScope = rules.filter(
    (r) =>
      r.when === "edit" &&
      (r.scope.length === 0 || globMatch(rel, r.scope))
  );

  if (inScope.length === 0) {
    logSkip(ctx, "none-in-scope", rules.length);

    return null;
  }

  const relevant = inScope.filter((r) =>
    isSubjectRelevant(hunk, r.subject, rel)
  );

  if (relevant.length === 0) {
    logSkip(ctx, "none-relevant", rules.length);

    return null;
  }

  const qkeyMap = ruleKeys(relevant);
  const questions: Questions = {};

  for (const r of relevant) {
    questions[qkeyMap.get(r) ?? slugify(r.text)] = ruleQuestion(r);
  }

  const stateText = [
    `File: ${rel}`,
    `The edit:\n${hunk.slice(0, MAX_STATE_CHARS)}`,
  ].join("\n\n");

  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, deadline - performance.now());

  if (timeoutMs < MIN_CALL_MS) {
    logCheckError(ctx, "hook budget spent before this file was judged", 0);

    return null;
  }

  let answers: Answers;
  const t0 = performance.now();

  try {
    answers = await jevAsk(stateText, questions, timeoutMs);
  } catch (e) {
    logCheckError(ctx, String(e), Math.round(performance.now() - t0));

    return null;
  }

  const ms = Math.round(performance.now() - t0);
  const logKeys = loggedRuleKeys(relevant);
  const hits: CheckHit[] = [];

  for (const r of relevant) {
    const key = qkeyMap.get(r) ?? slugify(r.text);
    const prob = verdict(answers[key]);
    const logKey = logKeys.get(r) ?? r.id;

    if (prob >= FLAG) {
      hits.push({ rule: r, logKey, prob, band: prob >= ACT ? "act" : "flag" });
    }
  }

  const tally = {
    nRules: rules.length,
    nScopedOut: rules.length - inScope.length,
    nIrrelevant: inScope.length - relevant.length,
    probs: probsByRule(relevant, (r) => qkeyMap.get(r), (k) => verdict(answers[k])),
    hits,
    ms,
  };

  return { target, ctx, hits, tally };
}

async function assessAll(
  targets: EditTarget[],
  rules: Rule[],
  ctxFor: (t: EditTarget) => CheckContext,
  deadline: number
): Promise<Assessment[]> {
  const out: Assessment[] = [];

  for (let i = 0; i < targets.length; i += MAX_PARALLEL) {
    const wave = targets.slice(i, i + MAX_PARALLEL);

    const settled = await Promise.allSettled(
      wave.map((t) => assess(t, rules, ctxFor(t), deadline))
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) out.push(r.value);
    }
  }

  return out;
}

function ruleLine(h: CheckHit): string {
  let text = h.rule.text.replace(/\s+/g, " ");

  if (text.length > 220) text = text.slice(0, 217) + "...";

  const where = h.rule.line
    ? `${h.rule.file} line ${h.rule.line}`
    : h.rule.file;

  return `- [${h.rule.polarity}/${h.rule.subject}] Rule "${h.rule.id}" from ${where}: "${text}" (${h.prob.toFixed(2)})`;
}

function blockMessage(acting: Acting[], patch: boolean): string {
  if (!patch) {
    const only = acting[0]!;

    const lines = [
      "This edit would break a rule from this repository's instructions, so it was not applied.",
      ...only.hits.map(ruleLine),
      `Rewrite the edit to ${only.target.rel} so it follows the rule, then continue with the task.`,
    ];

    return lines.join("\n");
  }

  const lines = [
    "This patch_apply call would break a rule from this repository's instructions, so none of its files were written.",
  ];

  for (const a of acting) {
    lines.push(`In ${a.target.rel}:`);
    lines.push(...a.hits.map(ruleLine));
  }

  const files = acting.map((a) => a.target.rel).join(", ");

  lines.push(`Rewrite the change to ${files} so it follows the rule, then reapply the whole patch.`);

  return lines.join("\n");
}

function flagMessage(assessments: Assessment[]): string | undefined {
  const lines: string[] = [];

  for (const a of assessments) {
    if (a.hits.length === 0) continue;

    lines.push(`[jev rules] Uncertain rule match in ${a.target.rel}:`);

    for (const h of a.hits) {
      let text = h.rule.text.replace(/\s+/g, " ");

      if (text.length > 200) text = text.slice(0, 197) + "...";
      lines.push(
        `  - ${h.rule.id} (${h.prob.toFixed(2)}): "${text}"`
      );
    }
  }

  if (lines.length === 0) return undefined;

  lines.push("Check these before marking the task Done.");

  return lines.join("\n");
}

async function judge(
  targets: EditTarget[],
  patch: boolean,
  cwd: string,
  sessionId: string,
  started: number = performance.now()
): Promise<Verdict> {
  const ctxFor = (t: EditTarget): CheckContext => ({
    phase: "edit",
    sessionId,
    cwd,
    file: t.filePath || null,
  });

  let rules: Rule[];
  const loadStarted = performance.now();

  try {
    rules = await loadRules(cwd, { afkRules: true });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const ms = Math.round(performance.now() - loadStarted);

    for (const t of targets) logRulesLoadFailure(ctxFor(t), error, ms);

    return {};
  }

  if (rules.length === 0) {
    for (const t of targets) logSkip(ctxFor(t), "no-rules");

    return {};
  }

  const assessments = await assessAll(targets, rules, ctxFor, started + BUDGET_MS);
  const withHits = assessments.filter((a) => a.hits.length > 0);

  for (const a of assessments) {
    if (a.hits.length === 0) logCheck(a.ctx, { ...a.tally, blocked: [] });
  }

  if (withHits.length === 0) return {};

  const state = loadState(sessionId);
  const acting: Acting[] = [];

  for (const a of withHits) {
    const actingHits: CheckHit[] = [];

    for (const h of a.hits) {
      const blockKey = `${h.rule.id}|${a.target.rel}`;

      if (h.band === "act" && (state.blocks[blockKey] ?? 0) < MAX_BLOCKS) {
        state.blocks[blockKey] = (state.blocks[blockKey] ?? 0) + 1;
        actingHits.push(h);
      }
    }

    if (actingHits.length > 0) acting.push({ target: a.target, hits: actingHits });
  }

  saveState(sessionId, state);

  for (const a of withHits) {
    const mine = acting.find((x) => x.target === a.target);

    logCheck(a.ctx, { ...a.tally, blocked: mine ? mine.hits.map((h) => h.logKey) : [] });
  }

  if (acting.length > 0) return { block: blockMessage(acting, patch) };

  const flag = flagMessage(withHits);

  return flag ? { flag } : {};
}

async function main(): Promise<void> {
  const started = performance.now();
  const event = await readStdinJson<PreToolUseEvent>();
  const sessionId = event.session_id;

  if (!sessionId) return;

  const cwd = event.cwd ?? process.cwd();
  const { patch, targets } = editTargets(event.tool_name, event.tool_input ?? {}, cwd);

  if (targets.length === 0) return;

  const result = await judge(targets, patch, cwd, sessionId, started);

  if (result.block) {
    const out: PreToolUseOutput = { decision: "block", reason: result.block };

    writeOutput(out);

    return;
  }

  appendEdits(sessionId, targets);

  if (result.flag) {
    const out: PreToolUseOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.flag,
      },
    };

    writeOutput(out);
  }
}

try {
  await main();
} catch {
}
