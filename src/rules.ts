#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput, type HookOutput, type PostToolUseOutput, type StopOutput } from "../adapters/afk/src/shared/stdout.ts";
import {
  jevAsk,
  asNoul,
  type Answers,
  type NoulQuestion,
  type Question,
} from "../adapters/afk/src/shared/jev-client.ts";
import {
  loadRules,
  globMatch,
  isSubjectRelevant,
  type Rule,
} from "../adapters/afk/src/shared/rule-parser.ts";
import { addedHead, EXCLUDED_RE, isOutside } from "../adapters/afk/src/shared/hunks.ts";
import {
  isJsonObject,
  isJsonArray,
  isString,
  isNumber,
  parseJsonObject,
  textOf,
  type Json,
  type JsonValue,
} from "../adapters/afk/src/shared/json.ts";
import { comparator, which as astWhich } from "../adapters/afk/src/shared/comparators.ts";
import { appendLogLine, configDir, enabled, ROUTER_LOG, RULES_CACHE } from "../adapters/afk/src/shared/config.ts";

const ACT = 0.8;

const FLAG = 0.5;

const MAX_RULES = 40;

const MAX_STATE_CHARS = 8000;

const MAX_TASK_CHARS = 600;

const MAX_ANSWER_CHARS = 1500;

const MAX_BLOCKS = 2;

const MAX_STOP_BLOCKS = 2;

const HOOK_BUDGET = 9.0;

const ESCALATE_MIN = 3.0;

const MAX_HUNK_CHARS = 2000;

const MAX_TURN_CHARS = 16000;

const MAX_PROMPT_TAIL = 400;

const CONTEXT_LINES = 4;

const MAX_CONTEXT_CHARS = 1200;

const SIBLING_CAP = 40;

const ESCALATE = true;

const MAX_BLOCK_CHARS = 3000;

const ACT_DECISIVE = 0.7;

const ACT_NOISY = 0.85;

const CALIB_MIN_CHECKS = 20;

const CALIB_DECISIVE = 0.1;

const CALIB_NOISY = 0.25;

const STRICT_PREAMBLE =
  "This edit was already judged possibly in breach of this rule. Decide it. ";

const BLOCK_DIR = path.join(configDir(), "jev-rule-blocks");

const CALIB_FILE = path.join(configDir(), "jev-rules-calib.json");

let deadline: number | null = null;

function budgetSeconds(): number | null {
  if (deadline === null) return null;

  return Math.max(0.1, deadline - performance.now()) / 1000;
}

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Json;
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

interface SessionState {
  turn?: string;
  blocks: Record<string, number>;
  stop_blocks: number;
  hunks: string[];
  files: string[];
  partial: boolean;
  snapshots: Record<string, [string, string, string]>;
}

function emptyState(): SessionState {
  return { blocks: {}, stop_blocks: 0, hunks: [], files: [], partial: false, snapshots: {} };
}

function sessionPath(sessionId: string): string {
  const safe = (sessionId || "unknown").replace(/[^\w-]/g, "_");

  return path.join(BLOCK_DIR, `${safe}.json`);
}

function readState(sessionId: string): SessionState {
  let raw: string;

  try {
    raw = fs.readFileSync(sessionPath(sessionId), "utf8");
  } catch {
    return emptyState();
  }

  const data = parseJsonObject(raw);

  if (data === null) return emptyState();

  return { ...emptyState(), ...data };
}

function writeState(sessionId: string, state: SessionState): void {
  try {
    fs.mkdirSync(BLOCK_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(sessionId), JSON.stringify(state));
  } catch {
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function updateState<T>(sessionId: string, change: (state: SessionState) => T): T {
  fs.mkdirSync(BLOCK_DIR, { recursive: true });
  const lockPath = sessionPath(sessionId) + ".lock";
  const giveUp = performance.now() + 2000;
  let fd: number | null = null;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch {
      if (performance.now() > giveUp) break;
      sleepSync(25);
    }
  }

  try {
    const state = readState(sessionId);
    const result = change(state);
    writeState(sessionId, state);

    return result;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      } catch {
      }
    }
  }
}

function enterTurn(state: SessionState, turn: string): void {
  if (state.turn !== turn) {
    state.turn = turn;
    state.hunks = [];
    state.files = [];
    state.partial = false;
    state.snapshots = {};
  }
}

function recordHunk(state: SessionState, turn: string, rel: string, hunk: string): void {
  enterTurn(state, turn);
  const total = state.hunks.reduce((sum, h) => sum + h.length, 0);
  const room = MAX_TURN_CHARS - total;

  if (room <= 0) return;
  state.hunks.push(`--- ${rel}\n${hunk.slice(0, Math.min(MAX_HUNK_CHARS, room))}`);

  if (!state.files.includes(rel)) state.files.push(rel);
}

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  message?: Json;
  toolUseResult?: unknown;
}

function userPrompt(entry: TranscriptEntry): string {
  if (entry.type !== "user" || entry.isSidechain) return "";

  const text = textOf(entry.message).trim();

  return text.startsWith("<") || text.startsWith("/") || text.startsWith("#") ? "" : text;
}

function questionAnswers(entry: TranscriptEntry): string[] {
  if (entry.type !== "user" || entry.isSidechain) return [];
  const result = entry.toolUseResult;

  if (!isJsonObject(result)) return [];

  const answers = result["answers"];

  if (!isJsonObject(answers)) return [];

  const questions = isJsonArray(result["questions"]) ? result["questions"] : [];
  const options = new Map<string, Json[]>();

  for (const q of questions) {
    if (!isJsonObject(q)) continue;

    const opts = isJsonArray(q["options"]) ? q["options"].filter(isJsonObject) : [];
    const question = q["question"];

    options.set(isString(question) ? question : String(question), opts);
  }

  const out: string[] = [];

  for (const [question, answer] of Object.entries(answers)) {
    if (!isString(answer)) continue;
    const picked = new Set(answer.split(", "));

    const notes = (options.get(question) ?? [])
      .filter((o) => {
        const label = isString(o["label"]) ? o["label"] : String(o["label"]);

        return picked.has(label) || label === answer;
      })
      .map((o) => (isString(o["description"]) ? o["description"] : ""))
      .filter((n) => n);

    const described = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    out.push(`Q: ${question} A: ${answer}${described}`);
  }

  return out;
}

function requestWithAnswers(task: string, answers: string[]): string {
  if (answers.length === 0) return task;

  return (
    task +
    "\nThe user's answers to the agent's questions since that request:\n" +
    answers.join("\n").slice(0, MAX_ANSWER_CHARS)
  );
}

function lastUserPrompt(transcriptPath: string | undefined): [string, string, number] {
  if (!transcriptPath) return ["", "", 0];
  let lines: string[];

  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").slice(-MAX_PROMPT_TAIL);
  } catch {
    return ["", "", 0];
  }

  const answers: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;

    if (line.length > 500_000) continue;

    const data = parseJsonObject(line);

    if (data === null) continue;

    const entry: TranscriptEntry = {
      type: isString(data["type"]) ? data["type"] : undefined,
      uuid: isString(data["uuid"]) ? data["uuid"] : undefined,
      isSidechain: data["isSidechain"] === true,
      message: isJsonObject(data["message"]) ? data["message"] : undefined,
      toolUseResult: data["toolUseResult"],
    };

    const text = userPrompt(entry);

    if (text) {
      const request = requestWithAnswers(text.slice(0, MAX_TASK_CHARS), [...answers].reverse());

      return [entry.uuid ?? "", request, answers.length];
    }

    answers.push(...[...questionAnswers(entry)].reverse());
  }

  return ["", "", 0];
}

function realPath(p: string): string {
  const abs = path.resolve(p);

  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);

    return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
  }
}

function relativeTo(filePath: string, cwd: string): string {
  return path.relative(realPath(cwd), path.join(realPath(path.dirname(filePath)), path.basename(filePath)));
}

function gitSync(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 4000): string {
  const r = spawnSync("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });

  if (r.status !== 0 || r.error) throw new Error(String(r.stderr ?? r.error ?? "git failed"));

  return r.stdout;
}

function writeHunk(cwd: string, rel: string, content: string): string {
  try {
    const diff = gitSync(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", "--", rel], undefined, 5000);

    if (diff.trim()) return diff;
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd, timeout: 5000 });

    if (tracked.status === 0) return "";
  } catch {
  }

  return `NEW FILE (whole content):\n${content}`;
}

function editHunks(inp: Json, cwd?: string): string {
  if (isJsonArray(inp["edits"])) {
    const parts: string[] = [];

    for (const e of inp["edits"]) {
      if (!isJsonObject(e)) continue;

      let hunk = "";

      if (e["old_string"]) hunk += `REMOVED:\n${e["old_string"]}\n`;

      if (e["new_string"]) hunk += `ADDED:\n${e["new_string"]}`;

      if (hunk) parts.push(hunk);
    }

    return parts.filter(Boolean).join("\n\n");
  }

  if (inp["old_string"] != null || inp["new_string"] != null) {
    let hunk = "";

    if (inp["old_string"]) hunk += `REMOVED:\n${inp["old_string"]}\n`;

    if (inp["new_string"]) hunk += `ADDED:\n${inp["new_string"]}`;

    return hunk;
  }

  const content = String(inp["content"] ?? inp["new_source"] ?? "");

  if (content && cwd && isString(inp["file_path"]) && inp["file_path"]) {
    return writeHunk(cwd, relativeTo(inp["file_path"], cwd), content);
  }

  return content;
}

function needleOf(inp: Json): string {
  let fresh: unknown = inp["new_string"];

  if (fresh == null && isJsonArray(inp["edits"])) {
    for (const e of inp["edits"]) {
      if (isJsonObject(e) && e["new_string"]) {
        fresh = e["new_string"];
        break;
      }
    }
  }

  if (fresh == null) fresh = inp["content"] ?? inp["new_source"] ?? "";

  for (const line of String(fresh ?? "").split("\n")) {
    if (line.trim()) return line.trim();
  }

  return "";
}

const MODULE_EXT = [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs"];

function siblingModules(filePath: string): string {
  let entries: string[];
  const dir = path.dirname(filePath) || ".";

  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return "";
  }

  const names: string[] = [];

  for (const e of entries) {
    const full = path.join(dir, e);
    const ext = path.extname(e);
    const stem = path.basename(e, ext);
    let isDir = false;

    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      if (MODULE_EXT.some((x) => fs.existsSync(path.join(full, `index${x}`))) || fs.existsSync(path.join(full, "__init__.py"))) {
        names.push(e);
      }
    } else if (MODULE_EXT.includes(ext) && !stem.startsWith(".")) {
      names.push(stem);
    }
  }

  return [...new Set(names)].join(", ");
}

function fileContext(filePath: string, needle: string): string {
  if (!filePath || !needle) return "";
  let lines: string[];

  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return "";
  }

  const at = lines.findIndex((line) => line.includes(needle));

  if (at < 0) return "";
  const lo = Math.max(0, at - CONTEXT_LINES);

  return lines.slice(lo, at + CONTEXT_LINES + 1).join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function enclosingBlock(filePath: string, needle: string): string {
  if (!filePath || !needle) return "";
  let lines: string[];

  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return "";
  }

  const anchor = lines.findIndex((line) => line.includes(needle));

  if (anchor < 0) return "";
  const indent = (line: string) => line.length - line.trimStart().length;
  let depth = indent(lines[anchor]!);
  let start = anchor;

  for (let i = anchor - 1; i >= 0; i--) {
    if (lines[i]!.trim() && indent(lines[i]!) < depth) {
      start = i;
      depth = indent(lines[i]!);

      if (depth === 0) break;
    }
  }

  let end = lines.length;

  for (let i = anchor + 1; i < lines.length; i++) {
    if (lines[i]!.trim() && indent(lines[i]!) <= depth && i > start) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n").slice(0, MAX_BLOCK_CHARS);
}

const EDIT_FORBID_CRITERIA = {
  true: "The new code visibly does the forbidden thing.",
  false: "The edit does not do it, or only removes or leaves untouched code that did.",
};

const EDIT_REQUIRE_CRITERIA = {
  true: "A case the rule clearly governs was added, and the required element is absent.",
  false:
    "The rule does not govern what changed, the requirement is present, or it is a matter of degree or taste.",
};

function ruleQuestion(rule: Rule, strict = false): NoulQuestion {
  const pre = strict ? STRICT_PREAMBLE : "";
  const isEdit = rule.when === "edit";

  const scopeNote = isEdit
    ? "Judge only what the edit itself introduces, not pre-existing code."
    : "Judge only what these changes introduce, not pre-existing code.";

  if ((rule.polarity || "forbid") === "require") {
    const what = isEdit ? "this edit" : "these changes";

    return {
      type: "noul",
      instructions:
        pre +
        `Does ${what} add or change code that this rule clearly covers, and do it WITHOUT what the rule requires: "${rule.text}"? Answer yes only when both hold and the requirement is plainly missing from the new code and the surrounding lines shown. If the rule does not apply to what changed, or the requirement is met even imperfectly, answer no.`,
      criteria: EDIT_REQUIRE_CRITERIA,
    };
  }

  const added = isEdit
    ? "the ADDED or CHANGED code in this edit"
    : "the ADDED or CHANGED code in these changes";

  return {
    type: "noul",
    instructions: pre + `Does ${added} do what this rule forbids: "${rule.text}"? ${scopeNote}`,
    criteria: EDIT_FORBID_CRITERIA,
  };
}

function verdictOf(answer: Answers[string] | undefined): number {
  const p = asNoul(answer)?.noul;

  return isNumber(p) ? Math.min(1, Math.max(0, p)) : 0;
}

type Keyed = Rule & { _qkey?: string };

type Questions = Record<string, Question>;

export function assignQuestionKeys(rules: Keyed[]): void {
  const seen = new Set<string>();

  for (const r of rules) {
    if (r._qkey && !seen.has(r._qkey)) {
      seen.add(r._qkey);
      continue;
    }

    let key = r.id;
    let n = 2;

    while (seen.has(key)) {
      key = `${r.id}-${n}`;
      n++;
    }

    seen.add(key);
    r._qkey = key;
  }
}

async function askRules(
  stateText: string,
  rules: Keyed[],
  strict = false
): Promise<Answers> {
  if (rules.length === 0) return {};

  assignQuestionKeys(rules);
  const questions: Questions = {};

  for (const r of rules) {
    questions[probKey(r)] = ruleQuestion(r, strict);
  }

  const budget = budgetSeconds();

  return jevAsk(stateText, questions, budget === null ? undefined : Math.round(budget * 1000));
}

type Calib = Record<string, JsonValue>;

function loadCalib(): Calib {
  try {
    return parseJsonObject(fs.readFileSync(CALIB_FILE, "utf8")) ?? {};
  } catch {
    return {};
  }
}

const CALIB = loadCalib();

function actFor(rule: Keyed, act = ACT, calib: Calib = CALIB): number {
  const keyed = calib[probKey(rule)];
  const c = keyed !== undefined ? keyed : calib[rule.id];

  if (!isJsonObject(c) || act !== ACT) return act;

  const median = c["median"];
  const n = isNumber(c["n"]) ? c["n"] : 0;

  if (!isNumber(median)) return act;

  if (n >= CALIB_MIN_CHECKS && median <= CALIB_DECISIVE) return ACT_DECISIVE;

  if (median >= CALIB_NOISY) return ACT_NOISY;

  return act;
}

interface Hit {
  rule: string;
  text: string;
  file: string;
  line: number;
  polarity?: string;
  subject?: string;
  prob: number;
  band: "act" | "flag";
}

export function probKey(r: Keyed): string {
  return r._qkey ?? r.id;
}

function hitsFrom(rules: Keyed[], probs: Record<string, number>, act: number, flag: number): Hit[] {
  const hits: Hit[] = [];

  for (const r of rules) {
    const p = probs[probKey(r)] ?? 0;

    if (p >= flag) {
      hits.push({
        rule: r.id,
        text: r.text,
        file: r.file,
        line: r.line,
        polarity: r.polarity,
        subject: r.subject,
        prob: Math.round(p * 100) / 100,
        band: p >= actFor(r, act) ? "act" : "flag",
      });
    }
  }

  return hits;
}

function collectVerdicts(
  rules: Keyed[],
  answers: Answers,
  act: number,
  flag: number
): [Hit[], Record<string, number>] {
  const probs: Record<string, number> = {};

  for (const r of rules) {
    probs[probKey(r)] = Math.round(verdictOf(answers[probKey(r)]) * 1000) / 1000;
  }

  return [hitsFrom(rules, probs, act, flag), probs];
}

function scopedRules(rules: Keyed[], phase: string, files: string[]): Keyed[] {
  const hit = rules.filter(
    (r) => r.when === phase && (r.scope.length === 0 || files.some((f) => globMatch(f, r.scope)))
  );

  const tiers = new Map<string, Map<string, Rule[]>>();

  for (const r of hit) {
    const tier = `${r.scope.length === 0}|${r.file.startsWith("~/")}`;

    if (!tiers.has(tier)) tiers.set(tier, new Map());
    const byFile = tiers.get(tier)!;

    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }

  const out: Rule[] = [];

  for (const tier of [...tiers.keys()].sort()) {
    const queues = [...tiers.get(tier)!.values()];

    while (queues.length > 0 && out.length < MAX_RULES) {
      for (let i = 0; i < queues.length; i++) {
        const q = queues[i]!;

        if (q.length > 0) out.push(q.shift()!);

        if (q.length === 0) {
          queues.splice(i, 1);
          i--;
        }
      }
    }
  }

  return out.slice(0, MAX_RULES);
}

function pythonJson(value: JsonValue | null): string {
  if (isString(value)) return pyEscape(JSON.stringify(value));

  if (isNumber(value)) return JSON.stringify(value);

  if (isJsonArray(value)) return `[${value.map(pythonJson).join(", ")}]`;

  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${pyEscape(JSON.stringify(k))}: ${pythonJson(v)}`);

    return `{${entries.join(", ")}}`;
  }

  if (value === null) return "null";

  return value ? "true" : "false";
}

function pyEscape(s: string): string {
  return s.replace(/[\u0080-\uFFFF]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function inputDigest(event: HookEvent): string | null {
  try {
    return crypto
      .createHash("sha256")
      .update(pythonJson(event.tool_input ?? null))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
}

function ruleHashes(inScope: Rule[]) {
  const out: Record<string, string> = {};

  for (const r of inScope) {
    if (r.fileHash) out[r.file] = r.fileHash;
  }

  return out;
}

export function withheldNotice(
  hits: Hit[],
  acting: Hit[],
  place: string,
  held = "already raised this session — not sent to the agent"
): string | undefined {
  const uncertain = hits.filter((v) => v.band === "flag" && !acting.includes(v));
  const raised = hits.filter((v) => v.band === "act" && !acting.includes(v));
  const parts: string[] = [];
  const listed = (rows: Hit[]) => rows.map((v) => `${v.rule} ${v.prob.toFixed(2)}`).join(", ");

  if (uncertain.length > 0) {
    parts.push(`uncertain about ${listed(uncertain)} ${place} — not sent to the agent`);
  }

  if (raised.length > 0) {
    parts.push(`${listed(raised)} ${place} ${held}`);
  }

  if (parts.length === 0) return undefined;

  return `[jev rules] ${parts.join(". ")}`;
}

function cite(v: Hit): string {
  let text = v.text.split(/\s+/).join(" ");

  if (text.length > 220) text = text.slice(0, 217) + "...";
  const where = v.line ? `${v.file} line ${v.line}` : v.file;

  return `- [${v.polarity ?? "forbid"}/${v.subject ?? "other"}] Rule "${v.rule}" from ${where}: "${text}" (${v.prob.toFixed(2)})`;
}

function logDecision(
  event: HookEvent,
  answers: Answers,
  probs: Record<string, number>,
  violations: Hit[],
  nRules: number,
  nScopedOut: number,
  phase: string,
  opts: {
    inputHash?: string | null;
    blocked?: string[];
    hashes?: Record<string, string>;
    ms?: number;
    nIrrelevant?: number;
    head?: string | null;
    escalated?: string[];
    cmpChars?: Record<string, number>;
    sg?: string | null;
    userAnswers?: number;
  } = {}
): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      kind: "rules",
      phase,
      session_id: event.session_id,
      cwd: event.cwd,
      file: (event.tool_input ?? {})["file_path"],
      input_hash: opts.inputHash ?? null,
      added_head: opts.head ?? null,
      n_rules: nRules,
      n_scoped_out: nScopedOut,
      n_irrelevant: opts.nIrrelevant ?? 0,
      escalated: opts.escalated ?? [],
      comparators: opts.cmpChars ?? {},
      sg: opts.sg ?? null,
      ms: opts.ms ?? null,
      probs,
      violations: violations.map((v) => ({ rule: v.rule, file: v.file, line: v.line, prob: v.prob, band: v.band })),
      blocked: opts.blocked ?? [],
      rule_hashes: opts.hashes ?? {},
      user_answers: opts.userAnswers ?? 0,
    };

    appendLogLine(ROUTER_LOG, JSON.stringify(row));
  } catch {
  }
}

function logError(error: Error, event: HookEvent): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      kind: "rules-error",
      session_id: event.session_id,
      event: event.hook_event_name,
      path: (event.tool_input ?? {})["file_path"],
      error: String(error).slice(0, 300),
    };

    appendLogLine(ROUTER_LOG, JSON.stringify(row));
  } catch {
  }
}

async function judgeEdit(
  rel: string,
  hunk: string,
  task: string,
  inScope: Keyed[],
  context = "",
  siblings = "",
  blockText = "",
  cwd = "",
  act = ACT,
  flag = FLAG
): Promise<[Hit[], Record<string, number>, Answers, Rule[], string[], Record<string, number>]> {
  const parts = [`File: ${rel}`];

  if (task) parts.push(`The user's current request: ${task}`);
  parts.push(`The edit:\n${hunk.slice(0, MAX_STATE_CHARS)}`);

  if (context) parts.push(`Surrounding lines after the edit:\n${context}`);
  assignQuestionKeys(inScope);
  const asked = inScope.filter((r) => isSubjectRelevant(hunk, r.subject, rel));
  const skipped = inScope.filter((r) => !asked.includes(r));

  if (siblings && asked.some((r) => r.subject === "imports_deps")) {
    const names = siblings.split(", ").slice(0, SIBLING_CAP).join(", ");
    parts.push(`Local modules importable from this file's directory: ${names}`);
  }

  const cmpChars: Record<string, number> = {};

  if (cwd) {
    for (const subject of new Set(asked.map((r) => r.subject))) {
      const found = await comparator(subject || "other", hunk, rel, cwd);

      if (found) {
        cmpChars[subject] = found.length;
        parts.push(found);
      }
    }
  }

  const answers = await askRules(parts.join("\n\n"), asked);
  let [hits, probs] = collectVerdicts(inScope, answers, act, flag);

  const escalated: string[] = [];

  const undecided = asked.filter((r) => {
    const p = probs[probKey(r)] ?? 0;

    return flag <= p && p < actFor(r, act);
  });

  const budget = budgetSeconds();

  if (ESCALATE && undecided.length > 0 && (budget === null || budget >= ESCALATE_MIN)) {
    const extra = [...parts];

    if (blockText) extra.push(`The function or block this edit landed in, after the edit:\n${blockText}`);

    const around = undecided
      .flatMap((r) => (r.context ? [`[${r.id}] ${r.context}`] : []))
      .join("\n");

    if (around) extra.push(`The instruction file says, around this rule:\n${around}`);
    let second: Answers = {};

    try {
      second = await askRules(extra.join("\n\n"), undecided, true);
    } catch {
      second = {};
    }

    if (Object.keys(second).length > 0) {
      for (const r of undecided) {
        probs[probKey(r)] = Math.round(verdictOf(second[probKey(r)]) * 1000) / 1000;
        escalated.push(r.id);
      }

      hits = hitsFrom(inScope, probs, act, flag);
    }
  }

  return [hits, probs, answers, skipped, escalated, cmpChars];
}

async function handleEdit(event: HookEvent): Promise<PostToolUseOutput | StopOutput | Record<string, never>> {
  const inp = event.tool_input;

  if (!inp) return {};

  const cwd = event.cwd ?? process.cwd();
  const filePath = isString(inp["file_path"]) ? inp["file_path"] : "";
  const rel = relativeTo(filePath, cwd);

  if (!filePath || EXCLUDED_RE.test(rel) || isOutside(rel)) return {};
  const rules = await loadRules(cwd, { cachePath: path.join(configDir(), RULES_CACHE) });

  if (rules.length === 0) return {};
  const inScope = scopedRules(rules, "edit", [rel]);
  const hunk = editHunks(inp, cwd).trim();

  if (!hunk) return {};
  const sid = event.session_id ?? "unknown";
  const [turn, task, nAnswers] = lastUserPrompt(event.transcript_path);
  updateState(sid, (st) => recordHunk(st, turn, rel, hunk));

  if (!inScope.length) return {};

  const context = fileContext(filePath, needleOf(inp));
  const siblings = siblingModules(filePath);
  const blockText = ESCALATE ? enclosingBlock(filePath, needleOf(inp)) : "";

  const sg = astWhich()[1];
  const t0 = performance.now();

  const [hits, probs, answers, skipped, escalated, cmpChars] = await judgeEdit(
    rel,
    hunk,
    task,
    inScope,
    context,
    siblings,
    blockText,
    cwd
  );

  const ms = Math.round(performance.now() - t0);

  const acting =
    hits.length > 0
      ? updateState(sid, (st) => {
          const list: Hit[] = [];

          for (const v of hits) {
            const key = `${v.rule}|${rel}`;

            if (v.band === "act" && (st.blocks[key] ?? 0) < MAX_BLOCKS) {
              st.blocks[key] = (st.blocks[key] ?? 0) + 1;
              list.push(v);
            }
          }

          return list;
        })
      : [];

  const flagged = hits.filter((v) => !acting.includes(v));

  logDecision(event, answers, probs, hits, rules.length, rules.length - inScope.length, "edit", {
    inputHash: inputDigest(event),
    blocked: acting.map((v) => v.rule),
    hashes: ruleHashes(inScope),
    ms,
    nIrrelevant: skipped.length,
    head: addedHead(hunk),
    escalated,
    cmpChars,
    sg,
    userAnswers: nAnswers,
  });

  if (flagged.length === 0 && acting.length === 0) return {};

  const notice = withheldNotice(hits, acting, `on ${rel}`);
  const lines = ["This edit appears to break a rule from this repository's instructions.", ...acting.map(cite), `Repair ${rel} now, then continue with the task.`];

  if (notice && acting.length > 0) {
    return {
      systemMessage: notice,
      decision: "block",
      reason: lines.join("\n"),
    };
  }

  if (notice) return { systemMessage: notice };

  return { decision: "block", reason: lines.join("\n") };
}

function worktreeTree(cwd: string): [string, string, string] {
  const root = gitSync(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const indexPath = gitSync(root, ["rev-parse", "--git-path", "index"]).trim();
  const index = path.join(root, indexPath);
  const scratch = path.join(BLOCK_DIR, `index-${process.pid}`);
  fs.mkdirSync(BLOCK_DIR, { recursive: true });

  try {
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, scratch);
      const st = fs.statSync(index);
      fs.utimesSync(scratch, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: scratch };
    gitSync(root, ["add", "-A"], env);
    const ignored = gitSync(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    const tree = gitSync(root, ["write-tree"], env).trim();

    return [root, tree, crypto.createHash("sha256").update(ignored).digest("hex")];
  } finally {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
    }
  }
}

function snapshotKey(event: HookEvent): string {
  return event.tool_use_id ?? JSON.stringify(event.tool_input ?? null);
}

async function handleBashBefore(event: HookEvent): Promise<Record<string, never>> {
  const sid = event.session_id ?? "unknown";
  const cwd = event.cwd ?? process.cwd();
  const [turn] = lastUserPrompt(event.transcript_path);

  if (!turn) return {};
  let tree: [string, string, string] | null = null;

  try {
    tree = worktreeTree(cwd);
  } catch {
    tree = null;
  }

  updateState(sid, (st) => {
    enterTurn(st, turn);

    if (tree) st.snapshots[snapshotKey(event)] = tree;
    else st.partial = true;
  });

  return {};
}

async function handleBashAfter(event: HookEvent): Promise<Record<string, never>> {
  const sid = event.session_id ?? "unknown";
  const cwd = event.cwd ?? process.cwd();
  const [turn] = lastUserPrompt(event.transcript_path);
  const key = snapshotKey(event);

  const before = updateState(sid, (st) => {
    if (st.turn !== turn) return null;
    const snap = st.snapshots[key] ?? null;
    delete st.snapshots[key];

    return snap;
  });

  if (!turn || !before) return {};
  const [root, oldTree, oldIgnored] = before;
  let hunks: Array<[string, string]> = [];

  try {
    const [, newTree, newIgnored] = worktreeTree(root);

    if (newIgnored !== oldIgnored) {
      updateState(sid, (st) => {
        st.partial = true;
      });
    }

    const names = gitSync(root, ["diff", "--name-only", "-z", oldTree, newTree]).split("\0").filter(Boolean);
    hunks = [];

    for (const name of names) {
      const rel = relativeTo(path.join(root, name), cwd);

      if (EXCLUDED_RE.test(rel) || isOutside(rel)) continue;
      const hunk = gitSync(root, ["diff", "--no-color", "--no-ext-diff", "-U3", oldTree, newTree, "--", name]);
      hunks.push([rel, hunk]);
    }
  } catch {
    updateState(sid, (st) => {
      st.partial = true;
    });

    return {};
  }

  if (hunks.length > 0) {
    updateState(sid, (st) => {
      for (const [rel, hunk] of hunks) recordHunk(st, turn, rel, hunk);
    });
  }

  return {};
}

async function handleStop(event: HookEvent): Promise<StopOutput | Record<string, never>> {
  const sid = event.session_id ?? "unknown";
  const sstate = readState(sid);
  const [turn, task, nAnswers] = lastUserPrompt(event.transcript_path);

  if (!turn || sstate.turn !== turn || !(sstate.hunks.length > 0 || sstate.partial)) return {};
  const cwd = event.cwd ?? process.cwd();
  const rules = await loadRules(cwd, { cachePath: path.join(configDir(), RULES_CACHE) });
  const turnRules = scopedRules(rules, "turn", sstate.files);

  if (turnRules.length === 0) return {};

  const diff = sstate.hunks.join("\n\n");
  const parts = [`Files changed this turn: ${sstate.files.join(", ") || "none recorded"}`];

  if (sstate.partial) {
    parts.push(
      "This turn also ran shell commands. Changes they made are not in the diff below, so it is partial."
    );
  }

  if (task) parts.push(`The user's current request: ${task}`);
  parts.push(`The changes:\n${diff.slice(0, MAX_TURN_CHARS)}`);
  assignQuestionKeys(turnRules);
  const asked = turnRules.filter((r) => isSubjectRelevant(diff, r.subject, sstate.files.join(", ")));
  const t0 = performance.now();
  const answers = await askRules(parts.join("\n\n"), asked);
  const ms = Math.round(performance.now() - t0);

  const [hits, probs] = collectVerdicts(turnRules, answers, ACT, FLAG);
  const already = event.stop_hook_active === true;

  const acting =
    hits.length > 0
      ? updateState(sid, (st) => {
          const list: Hit[] = [];

          for (const v of hits) {
            if (v.band === "act" && !already && st.stop_blocks < MAX_STOP_BLOCKS) {
              st.stop_blocks += 1;
              list.push(v);
            }
          }

          return list;
        })
      : [];

  logDecision(event, answers, probs, hits, rules.length, rules.length - turnRules.length, "turn", {
    blocked: acting.map((v) => v.rule),
    hashes: ruleHashes(turnRules),
    ms,
    nIrrelevant: turnRules.length - asked.length,
    userAnswers: nAnswers,
  });

  const out: StopOutput = {};

  const held = already
    ? "not sent again while the agent is still finishing"
    : "omitted because this session already used its two turn blocks — not sent to the agent";

  const notice = withheldNotice(hits, acting, "at end of turn", held);

  if (notice) out.systemMessage = notice;

  if (acting.length > 0) {
    const files = sstate.files.join(", ");
    const lines = ["The changes this turn appear to break a rule from this repository's instructions."];
    lines.push(...acting.map(cite));
    lines.push(`Repair ${files} before you finish. Keep the fix to what the rule asks.`);
    out.decision = "block";
    out.reason = lines.join("\n");
  }

  return out;
}

async function main(): Promise<void> {
  let event: HookEvent = {};

  try {
    deadline = performance.now() + HOOK_BUDGET * 1000;

    if (!enabled("rules")) return;
    event = await readStdinJson<HookEvent>();
    const name = event.hook_event_name ?? "PostToolUse";
    const bash = event.tool_name === "Bash";
    let out: HookOutput = {};

    if (name === "Stop") {
      out = await handleStop(event);
    } else if (name === "PreToolUse") {
      out = bash ? await handleBashBefore(event) : {};
    } else {
      out = bash ? await handleBashAfter(event) : await handleEdit(event);
    }

    if (Object.keys(out).length > 0) writeOutput(out);
  } catch (e) {
    logError(e instanceof Error ? e : new Error(String(e)), event);
  }
}

function invokedDirectly(entry: string): boolean {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry));
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  }
}

const entry = process.argv[1];

if (entry && invokedDirectly(entry)) {
  try {
    await main();
  } catch {
  }
}
