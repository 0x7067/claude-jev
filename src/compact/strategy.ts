import fs from "node:fs";
import { DEFAULT_BACKEND, type Answers, type DecisionBackend } from "../../adapters/afk/src/shared/jev-client.ts";
import {
  isJsonObject,
  isJsonArray,
  isString,
  isNumber,
  parseJsonObject,
  type Json,
  type JsonValue,
} from "../../adapters/afk/src/shared/json.ts";
import { type Block, type Kept, type Row, type Stats, type Verdict } from "./types.ts";

export type { Block, Kept, Row, Stats, Verdict };

export const KEEP_THRESHOLD = 0.5;

export const MAX_BLOCKS = 150;

export const RESCUE_BLOCKS = 150;

const ASK_TIMEOUT_MS = 4000;

export const PIN_TAIL = 4;

const CHUNK = 20;

const BLOCKS_PER_CHUNK = CHUNK / 2;

export const DIRECTIVE_CHARS = 500;

const HEADER_CHARS = 1500;

const MAX_WORKERS = 16;

const BLOCK_CHARS = 1200;

const KEEP_CHARS = 1500;

const HEAD_CHARS = 400;

const TAIL_CHARS = 150;

const HEAD_SLACK = 200;

const TARGET_CHARS = 16000;

const TAIL_LINES = 5000;

const META_PREFIXES = [
  "<command-",
  "<local-command",
  "<system-reminder",
  "<caveat",
  "<bash-",
  "<task-notification",
];

const SOURCE_OK = ["typed", "queued", "suggestion_accepted"];

const ACK = /^(ok|yes|no|thanks|continue)\.?$/i;

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: string;
  message?: Json;
}

export function blockText(content: JsonValue | undefined): string {
  if (isString(content)) return content;

  const parts: string[] = [];

  for (const b of isJsonArray(content) ? content : []) {
    if (!isJsonObject(b)) continue;

    const t = b["type"];

    if (t === "text") {
      parts.push(isString(b["text"]) ? b["text"] : "");
    } else if (t === "tool_use") {
      parts.push(
        `[tool_use ${isString(b["name"]) ? b["name"] : "?"}] ${JSON.stringify(b["input"] ?? {}).slice(0, 400)}`
      );
    } else if (t === "tool_result") {
      let c: JsonValue | undefined = b["content"];

      if (isJsonArray(c)) {
        c = c
          .map((x) => (isJsonObject(x) && isString(x["text"]) ? x["text"] : ""))
          .join("\n");
      }

      parts.push(`[tool_result] ${String(c ?? "").slice(0, 800)}`);
    }
  }

  return parts.join("\n");
}

export function judgeable(role: string, text: string): string | null {
  if (!text || META_PREFIXES.some((p) => text.startsWith(p))) return null;

  if (role === "user" && ACK.test(text)) return null;

  return text;
}

export function injected(d: TranscriptEntry, strictSource: boolean): boolean {
  if (d.isMeta) return true;

  if (strictSource && d.type === "user") {
    const src = d.promptSource;

    if (src !== undefined && src !== null && !SOURCE_OK.includes(src)) return true;
  }

  return false;
}

export function compactionMarker(d: TranscriptEntry, text: string): boolean {
  if (d.isMeta && text.startsWith("Base directory for this skill:")) {
    return text
      .split("\n")[0]!
      .trimEnd()
      .replace(/\/+$/, "")
      .endsWith("skills/compact");
  }

  return text.startsWith("<command-") && text.slice(0, 200).includes("claude-jev:compact");
}

function roleOf(d: TranscriptEntry, fallback: string): string {
  const role = d.message?.["role"];

  return isString(role) ? role : (d.type ?? fallback);
}

export function transcriptEntry(data: Json): TranscriptEntry {
  return {
    type: isString(data["type"]) ? data["type"] : undefined,
    isSidechain: data["isSidechain"] === true,
    isMeta: data["isMeta"] === true,
    promptSource: isString(data["promptSource"]) ? data["promptSource"] : undefined,
    message: isJsonObject(data["message"]) ? data["message"] : undefined,
  };
}

export function visibleText(
  d: TranscriptEntry,
  text?: string | null,
  strictSource = false
): string | null {
  if (d.isSidechain || (d.type !== "user" && d.type !== "assistant")) return null;

  if (injected(d, strictSource)) return null;
  const role = roleOf(d, "");
  const body = text === undefined || text === null ? blockText(d.message?.["content"]).trim() : text;

  return judgeable(role, body);
}

export function transcriptBlocks(transcriptPath: string): Block[] {
  let lines: string[];

  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").slice(-TAIL_LINES);
  } catch {
    return [];
  }

  const parsed: TranscriptEntry[] = [];

  for (const line of lines) {
    if (!line || line.length > 2_000_000) continue;

    const data = parseJsonObject(line);

    if (data !== null) parsed.push(transcriptEntry(data));
  }

  const strictSource = parsed.some((d) => d.promptSource === "typed");

  const blocks: Block[] = [];
  let cutAt: number | null = null;

  for (const d of parsed) {
    const raw = blockText(d.message?.["content"]).trim();

    if (raw && compactionMarker(d, raw)) {
      cutAt = blocks.length;
      continue;
    }

    const text = visibleText(d, raw, strictSource);

    if (text === null) continue;
    blocks.push({ role: roleOf(d, "assistant"), text });
  }

  return cutAt === null ? blocks : blocks.slice(0, cutAt);
}

export function sessionContext(blocks: Block[], cwd: string | null, directive: string | null): string {
  const lines: string[] = [];

  if (cwd) lines.push(`Working directory: ${cwd}`);

  if (directive) {
    lines.push(`The user asked this compaction to: ${directive}`);
    lines.push("A block that request covers counts as yes on every check below.");
  }

  const goal = blocks
    .flatMap((b) => (b.role === "user" ? [b.text.slice(0, 300)] : []))
    .join("\n")
    .slice(-HEADER_CHARS);

  if (goal.trim()) lines.push(`Most recent user requests:\n${goal}`);

  return lines.join("\n");
}

export function compactState(blocks: Block[], lo: number, hi: number, context: string): string {
  const header = [
    "Transcript of an AI coding-assistant session being compacted.",
    `Blocks are numbered by position in the session, oldest first. This request shows blocks [${lo}]..[${hi - 1}].`,
  ];

  if (context) header.push(context);

  const body = blocks
    .slice(lo, hi)
    .map((b, off) => `[${lo + off}] [${b.role}] ${b.text.slice(0, BLOCK_CHARS)}`)
    .join("\n\n");

  return header.join("\n") + "\n\n" + body;
}

export const CHECKS = {
  constraint:
    "Does block [{i}] state a requirement, restriction, or preference from the user about how the work must be done: something not to touch, a tool or approach to use, a deadline, a scope limit?",
  decision:
    "Does block [{i}] record a decision about the work together with its reason: an approach chosen, an alternative rejected, a root cause identified?",
  error:
    "Does block [{i}] contain an exact error message, failing test output, or unexpected result that the agent would have to reproduce to see again?",
  open:
    "Does block [{i}] name work still to be done: a next step, a pending task, or a question waiting for the user's answer?",
  rerunnable:
    "Does block [{i}] hold output that would come back the same on a rerun: a listing, a passing check's log, build or install output, or warnings a rebuild would print again?",
};

export const KEEP_CHECKS = ["constraint", "decision", "error", "open"] as const;

export const ASK_CHECKS = [
  "constraint",
  "decision",
  "error",
  "open",
  "rerunnable",
] as const satisfies readonly (keyof typeof CHECKS)[];

type NoulQ = { type: "noul"; instructions: string };

type Questions = Record<string, NoulQ>;

export function keepQuestions(n: number, names: readonly (keyof typeof CHECKS)[] = ASK_CHECKS) {
  const questions: Questions = {};

  for (let i = 0; i < n; i++) {
    for (const name of names) {
      questions[`${name}_${i}`] = { type: "noul", instructions: CHECKS[name].replaceAll("{i}", String(i)) };
    }
  }

  return questions;
}

export function verdicts(answers: Answers, i: number): Verdict {
  const checks: Record<string, number> = {};

  for (const name of Object.keys(CHECKS)) {
    const a = answers[`${name}_${i}`];
    const p = a && "noul" in a ? a.noul : undefined;

    if (isNumber(p)) checks[name] = p;
  }

  if (Object.keys(checks).length === 0) return { keep: null, full: null, checks };
  const keep = Math.max(...KEEP_CHECKS.map((c) => checks[c] ?? 0));
  let error = checks["error"] ?? 0;

  if ((checks["rerunnable"] ?? 0) >= KEEP_THRESHOLD) error = 0;

  return { keep, full: Math.max(checks["constraint"] ?? 0, error), checks };
}

async function askChunked(
  blocks: Block[],
  cwd: string | null,
  lo: number,
  hi: number,
  directive: string | null = null,
  decisionBackend: DecisionBackend = DEFAULT_BACKEND,
  names: readonly (keyof typeof CHECKS)[] = ASK_CHECKS
): Promise<Answers> {
  const questions = keepQuestions(hi, names);
  const context = sessionContext(blocks, cwd, directive);
  const ranges: Array<[number, number]> = [];

  for (let i = lo; i < hi; i += BLOCKS_PER_CHUNK) ranges.push([i, Math.min(i + BLOCKS_PER_CHUNK, hi)]);

  const one = async (r: [number, number]): Promise<Answers> => {
    const [clo, chi] = r;
    const q: Questions = {};

    for (let i = clo; i < chi; i++) {
      for (const name of names) q[`${name}_${i}`] = questions[`${name}_${i}`]!;
    }

    try {
      return await decisionBackend.ask(compactState(blocks, clo, chi, context), q, ASK_TIMEOUT_MS);
    } catch {
      return {};
    }
  };

  let answers: Answers = {};

  if (ranges.length <= 1) {
    answers = ranges.length === 1 ? await one(ranges[0]!) : {};
  } else {
    for (let i = 0; i < ranges.length; i += MAX_WORKERS) {
      const batch = ranges.slice(i, i + MAX_WORKERS);
      const settled = await Promise.allSettled(batch.map(one));

      for (const r of settled) {
        if (r.status === "fulfilled") answers = { ...answers, ...r.value };
      }
    }
  }

  if (Object.keys(answers).length === 0) throw new Error("every chunk failed");

  return answers;
}

export const ELISION = (n: number) =>
  `[\u2026 ${n} chars elided by jev-compact \u2014 re-read the file or re-run the command if needed]`;

function headOf(text: string, chars: number): string {
  let cut = -1;
  let idx = text.indexOf("\n\n", Math.floor(chars / 2));

  while (idx !== -1 && idx < chars) {
    cut = idx;
    idx = text.indexOf("\n\n", idx + 1);
  }

  return cut > 0 ? text.slice(0, cut) : text.slice(0, chars);
}

export function cutMarked(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const head = headOf(text, chars);

  return `${head}\n${ELISION(text.length - head.length)}`;
}

export function truncateBlock(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS + HEAD_SLACK) return text;

  const head = headOf(text, HEAD_CHARS);
  const tail = text.slice(text.length - TAIL_CHARS).replace(/^\s+/, "");

  return `${head}\n${ELISION(text.length - head.length - tail.length)}\n${tail}`;
}

export function fitKept(kept: Kept[], blocks: Block[], targetChars = TARGET_CHARS): Kept[] {
  let total = kept.reduce((sum, k) => sum + k.text.length, 0);

  if (total <= targetChars) return kept;
  const movable = kept.filter((k) => !k.pinned);

  for (const k of movable.filter((k) => k.kind === "full").sort((a, b) => a.full - b.full)) {
    if (total <= targetChars) break;
    const shorter = truncateBlock(blocks[k.i]!.text);

    if (shorter.length >= k.text.length) continue;
    total -= k.text.length - shorter.length;
    k.text = shorter;
    k.kind = "truncated";
    k.escalated = true;
  }

  for (const k of [...movable].sort((a, b) => a.keep - b.keep || a.i - b.i)) {
    if (total <= targetChars) break;
    total -= k.text.length;
    k.kind = "dropped";
  }

  return kept.filter((k) => k.kind !== "dropped");
}

const REF_CHARS = 160;

function isReadResult(blocks: Block[], i: number): boolean {
  return (
    i > 0 &&
    blockKind(blocks[i]!.text) === "tool_result" &&
    blockKind(blocks[i - 1]!.text) === "tool_use:Read"
  );
}

export function blockKind(text: string): string {
  if (text.startsWith("[tool_use")) {
    const end = text.indexOf("]");
    const name = end > 0 ? text.slice("[tool_use".length, end).trim() : "";

    return `tool_use:${name || "?"}`;
  }

  if (text.startsWith("[tool_result]")) return "tool_result";

  return "text";
}

export function blockRows(blocks: Block[], kept: Kept[], answers: Answers): Row[] {
  const final = new Map(kept.map((k) => [k.i, k]));
  const out: Row[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const k = final.get(i);
    const verdict = k === undefined ? "dropped" : k.pinned ? "pinned" : k.kind;
    const { keep, full, checks } = verdicts(answers, i);
    out.push({
      checks,
      i,
      role: b.role,
      kind: blockKind(b.text),
      chars: b.text.length,
      keep,
      full,
      verdict,
      ref: b.text.split(/\s+/).join(" ").slice(0, REF_CHARS),
    });
  }

  return out;
}

export async function judge(
  transcriptPath: string,
  cwd: string | null,
  decisionBackend: DecisionBackend = DEFAULT_BACKEND
): Promise<[string[], Stats]> {
  const [kept, stats] = await selectBlocks(
    transcriptBlocks(transcriptPath).slice(-(MAX_BLOCKS + RESCUE_BLOCKS)),
    cwd,
    null,
    decisionBackend
  );

  return [kept.map((k) => k.text), stats];
}

function emptyStats(judged: number): Stats {
  return {
    judged,
    rescued: 0,
    pinned: 0,
    kept: 0,
    truncated: 0,
    escalated: 0,
    chars_before: 0,
    chars_after: 0,
    est_tokens_after: 0,
    reduction: 0,
    ms: 0,
    rows: [],
  };
}

function pairTarget(blocks: Block[], keptText: string, i: number): number | undefined {
  const linked = blocks[i]?.needs;

  if (linked !== undefined && linked >= 0 && linked < blocks.length && linked !== i) return linked;

  if (
    i > 0 &&
    keptText.startsWith("[tool_result]") &&
    blocks[i - 1]!.text.startsWith("[tool_use")
  ) {
    return i - 1;
  }

  return undefined;
}

export async function selectBlocks(
  blocks: Block[],
  cwd: string | null,
  directive: string | null = null,
  decisionBackend: DecisionBackend = DEFAULT_BACKEND,
  targetChars = TARGET_CHARS
): Promise<[Kept[], Stats]> {
  if (blocks.length === 0) return [[], emptyStats(0)];
  const window = Math.max(0, blocks.length - MAX_BLOCKS);
  const rescueLo = Math.max(0, window - RESCUE_BLOCKS);
  const nJudged = Math.max(0, blocks.length - PIN_TAIL);
  const t0 = performance.now();

  let answers: Answers =
    nJudged > window
      ? await askChunked(blocks, cwd, window, nJudged, directive, decisionBackend)
      : {};

  let rescueAnswers: Answers = {};

  if (window > rescueLo) {
    try {
      rescueAnswers = await askChunked(blocks, cwd, rescueLo, window, directive, decisionBackend, ["constraint"]);
    } catch {
    }
  }

  answers = { ...answers, ...rescueAnswers };
  const ms = Math.round(performance.now() - t0);

  const rescued: Kept[] = [];

  for (let i = rescueLo; i < window; i++) {
    const a = rescueAnswers[`constraint_${i}`];
    const p = a && "noul" in a ? a.noul : undefined;

    if (isNumber(p) && p >= KEEP_THRESHOLD) {
      rescued.push({
        i,
        text: cutMarked(blocks[i]!.text, KEEP_CHARS),
        kind: "full",
        keep: p,
        full: p,
        rescued: true,
      });
    }
  }

  const kept: Kept[] = [];

  for (let i = window; i < blocks.length; i++) {
    const b = blocks[i]!;

    if (i >= nJudged) {
      kept.push({ i, text: cutMarked(b.text, KEEP_CHARS), kind: "full", keep: 1, full: 1, pinned: true });
      continue;
    }

    const { keep, full } = verdicts(answers, i);
    const readKept = keep !== null && keep < KEEP_THRESHOLD && isReadResult(blocks, i);

    if (keep === null || keep >= KEEP_THRESHOLD || readKept) {
      const kind =
        keep !== null && full !== null && full < KEEP_THRESHOLD ? "truncated" : "full";

      kept.push({
        i,
        text: kind === "truncated" ? truncateBlock(b.text) : cutMarked(b.text, KEEP_CHARS),
        kind,
        keep: readKept ? 1 : keep ?? 1,
        full: full ?? 1,
      });
    }
  }

  const keptIdx = new Set(kept.map((k) => k.i));
  const paired: Kept[] = [];

  for (const k of kept) {
    const i = k.i;
    const linked = pairTarget(blocks, k.text, i);

    if (linked !== undefined && !keptIdx.has(linked)) {
      paired.push({
        i: linked,
        text: cutMarked(blocks[linked]!.text, KEEP_CHARS),
        kind: "full",
        keep: k.keep,
        full: k.full,
      });
      keptIdx.add(linked);
    }

    paired.push(k);
  }

  const final = fitKept([...rescued, ...paired], blocks, targetChars);

  const charsBefore = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const charsAfter = final.reduce((sum, k) => sum + k.text.length, 0);

  const stats: Stats = {
    judged: nJudged - window,
    rescued: rescued.length,
    pinned: blocks.length - nJudged,
    kept: final.length,
    truncated: final.filter((k) => k.kind === "truncated").length,
    escalated: final.filter((k) => k.escalated).length,
    chars_before: charsBefore,
    chars_after: charsAfter,
    est_tokens_after: Math.floor(charsAfter / 4),
    reduction: Math.round((1 - charsAfter / Math.max(charsBefore, 1)) * 1000) / 1000,
    ms,
    rows: blockRows(blocks, final, answers),
  };

  return [final, stats];
}
