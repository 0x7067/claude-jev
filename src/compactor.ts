#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.js";
import { jevAsk, type Answers } from "../adapters/afk/src/shared/jev-client.js";
import { configDir } from "../adapters/afk/src/shared/config.js";
import { fileURLToPath } from "node:url";

const KEEP_THRESHOLD = 0.5;
const MAX_BLOCKS = 150;
const RESCUE_BLOCKS = 150;
const ASK_TIMEOUT_MS = 4000;

const PIN_TAIL = 4;
const CHUNK = 20;

const BLOCKS_PER_CHUNK = CHUNK / 2;
const DIRECTIVE_CHARS = 500;
const HEADER_CHARS = 1500;

const MAX_WORKERS = 16;
const BLOCK_CHARS = 1200;
const KEEP_CHARS = 1500;
const HEAD_CHARS = 400;
const HEAD_SLACK = 200;

const TARGET_CHARS = 16000;

const STATS_LOG = "jev-compact-log.jsonl";
const TAIL_LINES = 5000;
export const ROWS_HEADER =
  "This session's history was compacted by Jev. Every message below " +
  "was judged still needed and kept verbatim, or as a head with an " +
  "elision note; everything else was dropped. Continue the last task " +
  "without asking the user to repeat anything.";

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

export interface Block {
  role: string;
  text: string;
  row?: Record<string, unknown>;
}

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: string;
  message?: { role?: string; content?: unknown };
}

export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (typeof b !== "object" || b === null) continue;
    const block = b as Record<string, unknown>;
    const t = block["type"];
    if (t === "text") {
      parts.push(String(block["text"] ?? ""));
    } else if (t === "tool_use") {
      parts.push(
        `[tool_use ${block["name"] ?? "?"}] ${JSON.stringify(block["input"] ?? {}).slice(0, 400)}`
      );
    } else if (t === "tool_result") {
      let c = block["content"];
      if (Array.isArray(c)) {
        c = c
          .map((x) => (typeof x === "object" && x !== null ? String((x as Record<string, unknown>)["text"] ?? "") : ""))
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

export function visibleText(
  d: TranscriptEntry,
  text?: string | null,
  strictSource = false
): string | null {
  if (d.isSidechain || (d.type !== "user" && d.type !== "assistant")) return null;
  if (injected(d, strictSource)) return null;
  const role = d.message?.role ?? d.type ?? "";
  const body = text === undefined || text === null ? blockText(d.message?.content).trim() : text;
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
    try {
      parsed.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      continue;
    }
  }
  const strictSource = parsed.some((d) => d.promptSource === "typed");
  const blocks: Block[] = [];
  let cutAt: number | null = null;
  for (const d of parsed) {
    const raw = blockText(d.message?.content).trim();
    if (raw && compactionMarker(d, raw)) {
      cutAt = blocks.length;
      continue;
    }
    const text = visibleText(d, raw, strictSource);
    if (text === null) continue;
    blocks.push({ role: d.message?.role ?? d.type ?? "assistant", text });
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
    .filter((b) => b.role === "user")
    .map((b) => b.text.slice(0, 300))
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

export const CHECKS: Record<string, string> = {
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
export const ASK_CHECKS = Object.keys(CHECKS) as string[];

export function keepQuestions(
  n: number,
  names: readonly string[] = ASK_CHECKS
): Record<string, { type: "noul"; instructions: string }> {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 0; i < n; i++) {
    for (const name of names) {
      questions[`${name}_${i}`] = { type: "noul", instructions: CHECKS[name]!.replaceAll("{i}", String(i)) };
    }
  }
  return questions;
}

export interface Verdict {
  keep: number | null;
  full: number | null;
  checks: Record<string, number>;
}

export function verdicts(answers: Answers, i: number): Verdict {
  const checks: Record<string, number> = {};
  for (const name of Object.keys(CHECKS)) {
    const a = answers[`${name}_${i}`];
    const p = a && "noul" in a ? a.noul : undefined;
    if (typeof p === "number") checks[name] = p;
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
  names: readonly string[] = ASK_CHECKS
): Promise<Answers> {
  const questions = keepQuestions(hi, names);
  const context = sessionContext(blocks, cwd, directive);
  const ranges: Array<[number, number]> = [];
  for (let i = lo; i < hi; i += BLOCKS_PER_CHUNK) ranges.push([i, Math.min(i + BLOCKS_PER_CHUNK, hi)]);

  const one = async (r: [number, number]): Promise<Answers> => {
    const [clo, chi] = r;
    const q: Record<string, { type: "noul"; instructions: string }> = {};
    for (let i = clo; i < chi; i++) {
      for (const name of names) q[`${name}_${i}`] = questions[`${name}_${i}`]!;
    }
    try {
      return await jevAsk(compactState(blocks, clo, chi, context), q, ASK_TIMEOUT_MS);
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

export function cutMarked(text: string, chars: number): string {
  if (text.length <= chars) return text;
  let cut = -1;
  let idx = text.indexOf("\n\n", Math.floor(chars / 2));
  while (idx !== -1 && idx < chars) {
    cut = idx;
    idx = text.indexOf("\n\n", idx + 1);
  }
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, chars);
  return `${head}\n${ELISION(text.length - head.length)}`;
}

export function truncateBlock(text: string): string {
  if (text.length <= HEAD_CHARS + HEAD_SLACK) return text;
  return cutMarked(text, HEAD_CHARS);
}

export interface Kept {
  i: number;
  text: string;
  kind: string;
  keep: number;
  full: number;
  pinned?: boolean;
  rescued?: boolean;
  escalated?: boolean;
}

export function fitKept(kept: Kept[], blocks: Block[]): Kept[] {
  let total = kept.reduce((sum, k) => sum + k.text.length, 0);
  if (total <= TARGET_CHARS) return kept;
  const movable = kept.filter((k) => !k.pinned);
  for (const k of movable.filter((k) => k.kind === "full").sort((a, b) => a.full - b.full)) {
    if (total <= TARGET_CHARS) break;
    const shorter = truncateBlock(blocks[k.i]!.text);
    if (shorter.length >= k.text.length) continue;
    total -= k.text.length - shorter.length;
    k.text = shorter;
    k.kind = "truncated";
    k.escalated = true;
  }
  for (const k of [...movable].sort((a, b) => a.keep - b.keep || a.i - b.i)) {
    if (total <= TARGET_CHARS) break;
    total -= k.text.length;
    k.kind = "dropped";
  }
  return kept.filter((k) => k.kind !== "dropped");
}

const REF_CHARS = 160;

export function blockKind(text: string): string {
  if (text.startsWith("[tool_use")) {
    const end = text.indexOf("]");
    const name = end > 0 ? text.slice("[tool_use".length, end).trim() : "";
    return `tool_use:${name || "?"}`;
  }
  if (text.startsWith("[tool_result]")) return "tool_result";
  return "text";
}

export interface Row {
  checks: Record<string, number>;
  i: number;
  role: string;
  kind: string;
  chars: number;
  keep: number | null;
  full: number | null;
  verdict: string;
  ref: string;
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
  cwd: string | null
): Promise<[string[], Record<string, unknown>]> {
  const [kept, stats] = await selectBlocks(transcriptBlocks(transcriptPath).slice(-(MAX_BLOCKS + RESCUE_BLOCKS)), cwd);
  return [kept.map((k) => k.text), stats];
}

export async function selectBlocks(
  blocks: Block[],
  cwd: string | null,
  directive: string | null = null
): Promise<[Kept[], Record<string, unknown>]> {
  if (blocks.length === 0) return [[], { judged: 0 }];
  const window = Math.max(0, blocks.length - MAX_BLOCKS);
  const rescueLo = Math.max(0, window - RESCUE_BLOCKS);
  const nJudged = Math.max(0, blocks.length - PIN_TAIL);
  const t0 = performance.now();
  let answers: Answers =
    nJudged > window
      ? await askChunked(blocks, cwd, window, nJudged, directive)
      : {};
  let rescueAnswers: Answers = {};
  if (window > rescueLo) {
    try {
      rescueAnswers = await askChunked(blocks, cwd, rescueLo, window, directive, ["constraint"]);
    } catch {
    }
  }
  answers = { ...answers, ...rescueAnswers };
  const ms = Math.round(performance.now() - t0);

  const rescued: Kept[] = [];
  for (let i = rescueLo; i < window; i++) {
    const a = rescueAnswers[`constraint_${i}`];
    const p = a && "noul" in a ? a.noul : undefined;
    if (typeof p === "number" && p >= KEEP_THRESHOLD) {
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
    if (keep === null || keep >= KEEP_THRESHOLD) {
      const kind =
        keep !== null && full !== null && full < KEEP_THRESHOLD ? "truncated" : "full";
      kept.push({
        i,
        text: kind === "truncated" ? truncateBlock(b.text) : cutMarked(b.text, KEEP_CHARS),
        kind,
        keep: keep ?? 1,
        full: full ?? 1,
      });
    }
  }

  const keptIdx = new Set(kept.map((k) => k.i));
  const paired: Kept[] = [];
  for (const k of kept) {
    const i = k.i;
    if (
      k.text.startsWith("[tool_result]") &&
      i > 0 &&
      !keptIdx.has(i - 1) &&
      blocks[i - 1]!.text.startsWith("[tool_use")
    ) {
      paired.push({
        i: i - 1,
        text: cutMarked(blocks[i - 1]!.text, KEEP_CHARS),
        kind: "full",
        keep: k.keep,
        full: k.full,
      });
      keptIdx.add(i - 1);
    }
    paired.push(k);
  }
  const final = fitKept([...rescued, ...paired], blocks);
  const stats: Record<string, unknown> = {
    judged: nJudged - window,
    rescued: rescued.length,
    pinned: blocks.length - nJudged,
    kept: final.length,
    truncated: final.filter((k) => k.kind === "truncated").length,
    escalated: final.filter((k) => k.escalated).length,
    chars_before: blocks.reduce((sum, b) => sum + b.text.length, 0),
    chars_after: final.reduce((sum, k) => sum + k.text.length, 0),
    ms,
    rows: blockRows(blocks, final, answers),
  };
  stats["est_tokens_after"] = Math.floor((stats["chars_after"] as number) / 4);
  stats["reduction"] = Math.round((1 - (stats["chars_after"] as number) / Math.max(stats["chars_before"] as number, 1)) * 1000) / 1000;
  return [final, stats];
}

interface CompactRow extends Record<string, unknown> {
  role?: string;
  text?: string;
  toolUses?: unknown;
  toolResults?: unknown;
  handle?: unknown;
}

export function rowText(row: CompactRow): string | null {
  const content: unknown[] = [{ type: "text", text: row.text ?? "" }];
  for (const u of (row.toolUses as Array<unknown>) ?? []) {
    if (typeof u !== "object" || u === null) continue;
    const use = u as Record<string, unknown>;
    content.push({ type: "tool_use", name: use["tool"] ?? "?", input: use["input"] ?? {} });
  }
  for (const r of (row.toolResults as Array<unknown>) ?? []) {
    if (typeof r !== "object" || r === null) continue;
    const res = r as Record<string, unknown>;
    content.push({ type: "tool_result", content: res["text"] });
  }
  return judgeable(row.role ?? "", blockText(content).trim());
}

function plainRow(row: CompactRow): boolean {
  return !row.toolUses && !row.toolResults;
}

function textRow(role: string, text: string): Record<string, unknown> {
  return { role, text, toolUses: [], toolResults: [] };
}

function rowsOut(blocks: Block[], kept: Kept[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [textRow("user", ROWS_HEADER)];
  for (const k of kept) {
    const block = blocks[k.i]!;
    const row = block.row as CompactRow | undefined;
    if (row && plainRow(row) && k.text === block.text) out.push(row);
    else out.push(textRow(block.role, k.text));
  }
  return out;
}

function fallback(reason: string): number {
  process.stdout.write(JSON.stringify({ fallback: reason }) + "\n");
  return 0;
}

function logStats(sessionId: string | undefined, stats: Record<string, unknown>): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      session_id: sessionId ?? null,
      source: "rows",
      ...stats,
    };
    fs.mkdirSync(path.dirname(path.join(configDir(), STATS_LOG)), { recursive: true });
    fs.appendFileSync(path.join(configDir(), STATS_LOG), JSON.stringify(row) + "\n");
  } catch {
  }
}

interface CompactEvent {
  trigger?: string;
  instructions?: string;
  cwd?: string;
  session_id?: string;
  messages?: unknown;
}

export async function rows(): Promise<number> {
  let event: CompactEvent;
  try {
    event = await readStdinJson<CompactEvent>();
  } catch (e) {
    return fallback(`unreadable event: ${String(e)}`);
  }
  if (typeof event !== "object" || event === null) return fallback("event is not an object");

  const directive = (event.instructions ?? "").trim().slice(0, DIRECTIVE_CHARS) || null;
  const incoming = (Array.isArray(event.messages) ? event.messages : []).filter(
    (r): r is CompactRow => typeof r === "object" && r !== null
  );

  const blocks: Block[] = [];
  for (let i = incoming.length - 1; i >= 0; i--) {
    if (blocks.length === MAX_BLOCKS + RESCUE_BLOCKS) break;
    const r = incoming[i]!;
    const text = rowText(r);
    if (text !== null) blocks.push({ role: r.role ?? "assistant", text, row: r });
  }
  blocks.reverse();
  if (blocks.length === 0) return fallback("no judgeable rows");

  let kept: Kept[];
  let stats: Record<string, unknown>;
  try {
    [kept, stats] = await selectBlocks(blocks, event.cwd ?? null, directive);
  } catch (e) {
    return fallback(`jev: ${String(e)}`);
  }
  stats["trigger"] = event.trigger;
  stats["rows_in"] = incoming.length;
  const out = rowsOut(blocks, kept);
  stats["rows_out"] = out.length;
  stats["passed_through"] = out.filter((r) => r["handle"] !== undefined).length;
  logStats(event.session_id, stats);
  const what = event.trigger ? `${event.trigger} compaction` : "compaction";
  process.stdout.write(
    JSON.stringify({
      messages: out,
      summary: `${what} replaced by ${out.length} rows (kept ${stats["kept"]}, ${stats["truncated"]} truncated, ${Math.round((stats["reduction"] as number) * 100)}% smaller, ${stats["ms"]} ms)`,
    }) + "\n"
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv[2] === "rows") {
    rows()
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stdout.write(JSON.stringify({ fallback: `compactor: ${String(e)}` }) + "\n");
        process.exit(0);
      });
  } else {
    process.stderr.write("usage: compactor.js rows  (reads a session.compact event on stdin)\n");
    process.exit(2);
  }
}
