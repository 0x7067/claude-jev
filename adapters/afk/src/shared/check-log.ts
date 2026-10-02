import { appendLogLine, ROUTER_LOG } from "./config.ts";
import { RuleClassificationError, type Rule } from "./rule-parser.ts";

export type CheckPhase = "edit" | "turn";

export type SkipReason =
  | "no-rules"
  | "rules-unreadable"
  | "none-in-scope"
  | "none-relevant";

export type RuleProbs = Map<string, number>;

export interface CheckHit {
  rule: Rule;
  logKey: string;
  prob: number;
  band: "act" | "flag";
}

export interface CheckContext {
  phase: CheckPhase;
  sessionId: string;
  cwd: string;
  file: string | null;
}

export interface CheckResult {
  nRules: number;
  nScopedOut: number;
  nIrrelevant: number;
  probs: RuleProbs;
  hits: CheckHit[];
  blocked: string[];
  ms: number;
}

interface RowBase {
  ts: string;
  host: "afk";
  phase: CheckPhase;
  session_id: string;
  cwd: string;
  file: string | null;
}

interface ViolationRow {
  rule: string;
  file: string;
  line: number;
  prob: number;
  band: "act" | "flag";
}

interface CheckRow extends RowBase {
  kind: "rules";
  input_hash: null;
  added_head: null;
  n_rules: number;
  n_scoped_out: number;
  n_irrelevant: number;
  escalated: string[];
  comparators: Record<string, number>;
  sg: null;
  ms: number;
  probs: Record<string, number>;
  violations: ViolationRow[];
  blocked: string[];
  rule_hashes: Record<string, string>;
  user_answers: number;
}

interface SkipRow extends RowBase {
  kind: "rules-skip";
  reason: SkipReason;
  n_rules: number;
}

interface ErrorRow extends RowBase {
  kind: "rules-error";
  ms: number;
  error: string;
}

type LogRow = CheckRow | SkipRow | ErrorRow;

function round(p: number): number {
  return Math.round(p * 1000) / 1000;
}

function write(row: LogRow): void {
  try {
    appendLogLine(ROUTER_LOG, JSON.stringify(row));
  } catch {
  }
}

function base(ctx: CheckContext): RowBase {
  return {
    ts: new Date().toISOString(),
    host: "afk",
    phase: ctx.phase,
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    file: ctx.file,
  };
}

export function logCheck(ctx: CheckContext, result: CheckResult): void {
  write({
    ...base(ctx),
    kind: "rules",
    input_hash: null,
    added_head: null,
    n_rules: result.nRules,
    n_scoped_out: result.nScopedOut,
    n_irrelevant: result.nIrrelevant,
    escalated: [],
    comparators: {},
    sg: null,
    ms: result.ms,
    probs: Object.fromEntries(result.probs),
    violations: result.hits.map((h) => ({
      rule: h.logKey,
      file: h.rule.file,
      line: h.rule.line,
      prob: round(h.prob),
      band: h.band,
    })),
    blocked: result.blocked,
    rule_hashes: {},
    user_answers: 0,
  });
}

export function logSkip(ctx: CheckContext, reason: SkipReason, nRules = 0): void {
  write({ ...base(ctx), kind: "rules-skip", reason, n_rules: nRules });
}

export function logCheckError(ctx: CheckContext, message: string, ms: number): void {
  write({ ...base(ctx), kind: "rules-error", ms, error: message.slice(0, 300) });
}

export function logRulesLoadFailure(ctx: CheckContext, error: Error, ms: number): void {
  if (error instanceof RuleClassificationError) {
    logCheckError(ctx, error.message, ms);

    return;
  }

  logSkip(ctx, "rules-unreadable");
}

export function loggedRuleKeys(rules: Rule[]): Map<Rule, string> {
  const seen = new Set<string>();
  const out = new Map<Rule, string>();

  for (const r of rules) {
    let key = r.id;
    let n = 2;

    while (seen.has(key)) {
      key = `${r.id}-${n}`;
      n++;
    }

    seen.add(key);
    out.set(r, key);
  }

  return out;
}

export function probsByRule(
  rules: Rule[],
  keyOf: (r: Rule) => string | undefined,
  probOf: (key: string) => number
): RuleProbs {
  const ids = loggedRuleKeys(rules);
  const out: RuleProbs = new Map();

  for (const r of rules) {
    const key = keyOf(r);

    if (key === undefined) continue;
    const id = ids.get(r);

    if (id === undefined) continue;
    out.set(id, round(probOf(key)));
  }

  return out;
}
