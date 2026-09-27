import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  resolveDecisionBackend,
  DEFAULT_BACKEND,
  type DecisionBackend,
} from "../adapters/afk/src/shared/jev-client.ts";
import {
  judge,
  blockText,
  visibleText,
  transcriptEntry,
  selectBlocks,
  transcriptBlocks,
  PIN_TAIL,
  MAX_BLOCKS,
  KEEP_THRESHOLD,
  type Block,
  type Kept,
  type Stats,
} from "../src/compactor.ts";
import {
  isJsonObject,
  isJsonArray,
  isString,
  isNumber,
  parseJsonObject,
  type Json,
  type JsonValue,
} from "../adapters/afk/src/shared/json.ts";

const HERE = path.dirname(fileURLToPath2(import.meta.url));

const ROOT = path.resolve(HERE, "..", "..");

const DATA = path.join(ROOT, "eval", "observed");

const COMPACT_CACHE = path.join(DATA, "compact_cache.jsonl");

const SUMMARY_CACHE = path.join(DATA, "summary_cache.jsonl");

const COMPACTOR_SRC = path.join(ROOT, "src", "compactor.ts");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

const CONTINUED = "continued from a previous conversation";

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);

const SKIP_TOOLS = new Set(["Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"]);

const SYNTH_CHARS = 100_000;

const MIN_POST_RETRIEVALS = 5;

const MIN_BLOCKS = 30;

interface BackendTally {
  calls: number;
  failed: number;
  errors: Map<string, number>;
}

interface Tallied {
  backend: DecisionBackend;
  tally: BackendTally;
}

function tallying(inner: DecisionBackend, maxInflight: number): Tallied {
  const tally: BackendTally = { calls: 0, failed: 0, errors: new Map() };
  const waiting: Array<() => void> = [];
  let inflight = 0;

  const acquire = (): Promise<void> => {
    if (maxInflight <= 0 || inflight < maxInflight) {
      inflight += 1;

      return Promise.resolve();
    }

    return new Promise<void>((done) => waiting.push(() => {
      inflight += 1;
      done();
    }));
  };

  const release = (): void => {
    inflight -= 1;
    waiting.shift()?.();
  };

  return {
    tally,
    backend: {
      name: inner.name,
      ask: async (state, questions, timeoutMs) => {
        await acquire();
        tally.calls += 1;

        try {
          return await inner.ask(state, questions, timeoutMs);
        } catch (e) {
          tally.failed += 1;
          const why = String(e).slice(0, 100);
          tally.errors.set(why, (tally.errors.get(why) ?? 0) 	+ 1);

          throw e;
        } finally {
          release();
        }
      },
    },
  };
}

const FLOOR_REFETCH_FULL = 0.7;

const FLOOR_PLANTED_USER = 0.95;

const FLOOR_PLANTED_BURIED = 0.9;

const SUMMARY_PROMPT = `Your task is to create a detailed summary of the conversation so far between a user and an AI coding assistant, paying close attention to the user's explicit requests and the assistant's previous actions. This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Cover: the primary request and intent; key technical concepts; files and code sections examined or modified, with paths; errors encountered and how they were resolved; problem-solving approaches; pending tasks; and the current state of the work.

CONVERSATION:
`;

function fileURLToPath2(url: string): string {
  return url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
}

interface ToolCall {
  i: number;
  name: string;
  key: string;
}

function toolKey(name: string, inp: Json | undefined): string | null {
  if (SKIP_TOOLS.has(name)) return null;

  if (FILE_TOOLS.has(name)) {
    const p = inp?.["file_path"] ?? inp?.["notebook_path"];

    return isString(p) && p ? `file:${path.normalize(p)}` : null;
  }

  if (name === "Grep") {
    const p = inp?.["path"] ?? inp?.["pattern"];

    return isString(p) && p ? `grep:${p}` : null;
  }

  if (name === "Glob") {
    const p = inp?.["pattern"];

    return isString(p) && p ? `glob:${p}` : null;
  }

  if (name === "Bash") {
    const lines = String(inp?.["command"] ?? "").trim().split("\n");

    return lines[0] ? `bash:${lines[0].trim().slice(0, 120)}` : null;
  }

  if (name === "WebFetch") {
    const u = inp?.["url"];

    return isString(u) && u ? `url:${u}` : null;
  }

  return null;
}

const REFETCH_KINDS = ["file", "grep", "glob", "url"];

function toolCalls(lines: string[], lo: number, hi: number): ToolCall[] {
  const out: ToolCall[] = [];

  for (let i = lo; i < hi; i++) {
    const line = lines[i]!;

    if (line.length > 2_000_000) continue;

    const d = parseJsonObject(line);

    if (d === null) continue;

    if (d["isSidechain"] || d["type"] !== "assistant") continue;

    const msg = isJsonObject(d["message"]) ? d["message"] : undefined;
    const content = msg?.["content"];

    for (const b of isJsonArray(content) ? content : []) {
      if (isJsonObject(b) && b["type"] === "tool_use") {
        const name = String(b["name"] ?? "");
        const key = toolKey(name, isJsonObject(b["input"]) ? b["input"] : undefined);

        if (key) out.push({ i, name, key });
      }
    }
  }

  return out;
}

function refetches(pre: ToolCall[], post: ToolCall[]): string[] {
  const fetched = new Set(pre.map((c) => c.key));

  return post.flatMap((c) => (REFETCH_KINDS.includes(c.key.split(":")[0]!) && fetched.has(c.key) ? [c.key] : []));
}

function keyTerms(key: string): string[] {
  const idx = key.indexOf(":");
  const kind = key.slice(0, idx);
  const val = key.slice(idx + 1);
  const terms = [val];

  if (kind === "file") {
    const base = path.basename(val);

    if (base !== val) terms.push(base);
  }

  return terms;
}

function covered(key: string, context: string): boolean {
  return keyTerms(key).some((t) => context.includes(t));
}

function messageContent(d: Json | undefined): JsonValue | undefined {
  if (d === undefined) return undefined;

  const msg = d["message"];

  return isJsonObject(msg) ? msg["content"] : undefined;
}

interface Boundary {
  i: number;
  meta: Json;
  summary: string;
  preserved: string;
}

function boundaries(lines: string[]): Boundary[] {
  const byUuid = new Map<string, Json>();

  for (let i = 0; i < lines.length; i++) {
    const d = parseJsonObject(lines[i]!);

    if (d !== null && d["uuid"]) byUuid.set(String(d["uuid"]), d);
  }

  const out: Boundary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const d = parseJsonObject(lines[i]!);

    if (d === null || d["subtype"] !== "compact_boundary") continue;

    const metaRaw = d["compactMetadata"];
    const meta: Json = isJsonObject(metaRaw) ? metaRaw : {};
    let summary = "";

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const n = parseJsonObject(lines[j]!);
      const c = messageContent(n ?? undefined);

      if (isString(c) && c.includes(CONTINUED)) {
        summary = c;
        break;
      }
    }

    const pm = meta["preservedMessages"];
    const uuids = isJsonObject(pm) && isJsonArray(pm["uuids"]) ? pm["uuids"].filter(isString) : [];

    const preserved = uuids
      .filter((u) => byUuid.has(u))
      .map((u) => blockText(messageContent(byUuid.get(u))))
      .join("\n");

    out.push({ i, meta, summary, preserved });
  }

  return out;
}

function selectionSig(decisionBackend: DecisionBackend): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(COMPACTOR_SRC))
    .update(decisionBackend.name)
    .digest("hex")
    .slice(0, 16);
}

interface CacheRow {
  key: string;
  sig: string;
  kept: string[];
  stats: Stats;
  summary: string | null;
}

function isStats(v: unknown): v is Stats {
  if (!isJsonObject(v)) return false;

  const numeric = [
    "judged",
    "rescued",
    "pinned",
    "kept",
    "truncated",
    "escalated",
    "chars_before",
    "chars_after",
    "est_tokens_after",
    "reduction",
    "ms",
  ];

  return numeric.every((k) => isNumber(v[k])) && isJsonArray(v["rows"]);
}

function cacheRow(d: Json): CacheRow | null {
  if (!isString(d["key"]) || !isString(d["sig"]) || !isStats(d["stats"])) return null;

  return {
    key: d["key"],
    sig: d["sig"],
    kept: isJsonArray(d["kept"]) ? d["kept"].filter(isString) : [],
    stats: d["stats"],
    summary: isString(d["summary"]) ? d["summary"] : null,
  };
}

function loadCompactCache(): [Map<string, CacheRow>, Map<string, string | null>] {
  const judged = new Map<string, CacheRow>();
  const summaries = new Map<string, string | null>();

  if (fs.existsSync(COMPACT_CACHE)) {
    for (const line of fs.readFileSync(COMPACT_CACHE, "utf8").split("\n")) {
      if (!line.trim()) continue;

      const d = parseJsonObject(line);

      if (d === null) continue;

      const row = cacheRow(d);

      if (row !== null) judged.set(`${row.key}|${row.sig}`, row);

      if (isString(d["summary"])) summaries.set(String(d["key"]), d["summary"]);
    }
  }

  if (fs.existsSync(SUMMARY_CACHE)) {
    for (const line of fs.readFileSync(SUMMARY_CACHE, "utf8").split("\n")) {
      if (!line.trim()) continue;

      const d = parseJsonObject(line);

      if (d !== null && isString(d["key"]) && isString(d["summary"])) summaries.set(d["key"], d["summary"]);
    }
  }

  return [judged, summaries];
}

interface ReplayResult {
  kept: string[];
  stats: Stats;
  summary: string | null;
}

async function replay(
  preLines: string[],
  cache: Map<string, CacheRow>,
  summaries: Map<string, string | null>,
  cacheF: number | null,
  decisionBackend: DecisionBackend,
  gen?: () => Promise<string | null>
): Promise<ReplayResult> {
  const key = crypto.createHash("sha256").update(preLines.join("")).digest("hex");
  const sig = selectionSig(decisionBackend);
  let summary = summaries.get(key) ?? null;

  if (summary === null && gen) {
    summary = await gen();

    summaries.set(key, summary);

    if (summary !== null) {
      fs.appendFileSync(SUMMARY_CACHE, JSON.stringify({ key, summary }) + "\n");
    }
  }

  const cacheKey = `${key}|${sig}`;
  const hit = cache.get(cacheKey);

  if (hit) return { kept: hit.kept, stats: hit.stats, summary };
  const tmp = path.join(os.tmpdir(), `jev-compact-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmp, preLines.join("\n"));
  let kept: string[];
  let stats: Stats;

  try {
    [kept, stats] = await judge(tmp, null, decisionBackend);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (stats.judged > 0) {
    const d: CacheRow = { key, sig, kept, stats, summary };
    cache.set(cacheKey, d);

    if (cacheF !== null) fs.appendFileSync(cacheF, JSON.stringify(d) + "\n");
  }

  return { kept, stats, summary };
}

function flatten(lines: string[], hi: number): string {
  const parts: string[] = [];

  for (const line of lines.slice(0, hi)) {
    const d = parseJsonObject(line);

    if (d === null) continue;

    if (d["isSidechain"] || (d["type"] !== "user" && d["type"] !== "assistant")) continue;

    const t = blockText(messageContent(d)).trim();

    if (t) parts.push(t);
  }

  return parts.join("\n\n");
}

function tailText(lines: string[], hi: number, n = 6): string {
  const texts: string[] = [];

  for (let i = hi - 1; i >= 0; i--) {
    const d = parseJsonObject(lines[i]!);

    if (d === null) continue;

    if (d["type"] !== "user" && d["type"] !== "assistant") continue;

    const t = blockText(messageContent(d)).trim();

    if (t) {
      texts.unshift(t);

      if (texts.length >= n) break;
    }
  }

  return texts.join("\n");
}

function synthCut(lines: string[]): number | null {
  let total = 0;
  let blocks = 0;
  let cut: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.length > 2_000_000) continue;

    const d = parseJsonObject(line);

    if (d === null) continue;

    const text = visibleText(transcriptEntry(d));

    if (text === null) continue;
    total += text.length;
    blocks += 1;

    if (total >= SYNTH_CHARS && blocks >= MIN_BLOCKS) {
      cut = i + 1;
      break;
    }
  }

  if (cut === null) return null;
  const post = toolCalls(lines, cut, lines.length);
  const n = post.filter((c) => REFETCH_KINDS.includes(c.key.split(":")[0]!)).length;

  return n >= MIN_POST_RETRIEVALS ? cut : null;
}

async function genSummary(conversation: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("pi", ["-p", "--no-session", "--no-tools", SUMMARY_PROMPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    let out = "";
    let err = "";

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();

      if (out.length > 1_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);

      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 || !out.trim()) {
        console.error(`genSummary failed: status=${code} err=${err.slice(0, 300)}`);

        resolve(null);

        return;
      }

      resolve(out.trim());
    });
    child.stdin.end(conversation);
  });
}

interface EventRow {
  kind: string;
  session: string;
  subagent: boolean;
  event_i: number;
  n_blocks: number;
  trigger: unknown;
  post_tokens: number;
  duration_s: number | null;
  jev_tokens: number;
  jev_ms: number;
  jev_gated: boolean;
  jev_kept: number;
  no_summary: boolean;
  refetch_reads: number;
  refetch_default_covered: number;
  refetch_jev_covered: number;
  refetch_jev_full: number;
}

const CONSTRAINTS = [
  "One constraint: do not touch anything under migrations/, the DBA owns that folder.",
  "Use pnpm for everything here, never npm or yarn.",
  "The ticket is PROJ-4471 and the deadline is Friday. Do not open a PR before then.",
  "Keep all changes inside src/billing/. Anything outside it needs my sign-off first.",
  "Do not bump any dependency versions in this task, even if a fix suggests it.",
  "Write the tests with vitest, not jest; we are mid-migration.",
  "Never force-push to main. Use a branch named fix/ledger-rounding.",
  "The API must stay backwards compatible with v2 clients until October.",
  "Log lines must use the structured logger, not print or console.log.",
  "Do not run the seed script against the shared staging database.",
];

const RESTATE = (c: string) => `Noted, and I'll keep to your constraint: ${c}`;

const KEYS = [
  "migrations/",
  "pnpm",
  "PROJ-4471",
  "src/billing/",
  "dependency versions",
  "vitest",
  "fix/ledger-rounding",
  "v2 clients",
  "structured logger",
  "seed script",
];

function mulberry32(seedText: string): () => number {
  let h = crypto.createHash("sha256").update(seedText).digest().readUInt32LE(0);

  return () => {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plant(blocks: Block[], rng: () => number): [Block[], { key: string; user: number; buried: number | null }] {
  const n = blocks.length - PIN_TAIL;
  const k = Math.floor(rng() * CONSTRAINTS.length);
  const c = CONSTRAINTS[k]!;
  const key = KEYS[k]!;
  const out = [...blocks];
  const lo = Math.max(1, Math.floor(n / 5));
  const hi = Math.max(2, n - 8);
  const posUser = hi > lo ? lo + Math.floor(rng() * (hi - lo)) : lo;
  out.splice(posUser, 0, { role: "user", text: c });
  const cands: number[] = [];

  for (let i = 0; i < out.length; i++) {
    const b = out[i]!;

    if (b.role === "assistant" && i > posUser + 1 && i < out.length - 8 && !b.text.startsWith("[tool_use") && b.text.length < 900) {
      cands.push(i);
    }
  }

  let posBuried: number | null = cands.length > 0 ? cands[Math.floor(rng() * cands.length)]! : null;

  if (posBuried !== null) {
    const b = out[posBuried]!;
    out[posBuried] = { role: "assistant", text: b.text.replace(/\s+$/, "") + "\n\n" + RESTATE(c) };
  }

  return [out, { key, user: posUser, buried: posBuried }];
}

interface PlantResult {
  user: string | null;
  buried: string | null;
  userCut: string | null;
  buriedCut: string | null;
  kept: number;
  blocks: number;
}

async function runEvent(
  fp: string,
  lines: string[],
  i: number,
  kind: string,
  seed: number,
  decisionBackend: DecisionBackend
): Promise<PlantResult | null> {
  const tmp = path.join(os.tmpdir(), `jev-planted-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmp, lines.slice(0, i).join("\n"));
  let blocks: Block[];

  try {
    blocks = transcriptBlocks(tmp).slice(-MAX_BLOCKS);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (blocks.length < 30) return null;
  const [plantedBlocks, meta] = plant(blocks, mulberry32(`${seed}:${path.basename(fp)}`));
  let kept: Kept[];
  let stats: Stats;

  try {
    [kept, stats] = await selectBlocks(plantedBlocks, null, null, decisionBackend);
  } catch (e) {
    process.stderr.write(`  jev failed on ${path.basename(fp)}: ${String(e)}\n`);

    return null;
  }

  const final = new Map(kept.map((k) => [k.i, k]));

  const fate = (pos: number | null): string | null => {
    if (pos === null) return null;
    const k = final.get(pos);

    if (k === undefined) return "dropped";

    return k.text.includes(meta.key) ? "kept" : "cut";
  };

  const cutOffset = (pos: number | null): string | null => {
    if (pos === null || fate(pos) !== "cut") return null;
    const original = plantedBlocks[pos]!.text;

    return `${original.indexOf(meta.key)}/${original.length}->${final.get(pos)!.text.length}`;
  };

  return {
    user: fate(meta.user),
    buried: fate(meta.buried),
    userCut: cutOffset(meta.user),
    buriedCut: cutOffset(meta.buried),
    kept: stats.kept,
    blocks: plantedBlocks.length,
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }

  return a;
}

function gate(rows: EventRow[], plants: Array<PlantResult | null>, tally: BackendTally): number {
  const reads = rows.reduce((sum, r) => sum + r.refetch_reads, 0);
  const full = reads > 0 ? rows.reduce((sum, r) => sum + r.refetch_jev_full, 0) / reads : NaN;
  const user = plants.flatMap((p) => (p !== null && p.user !== null ? [p.user] : []));
  const buried = plants.flatMap((p) => (p !== null && p.buried !== null ? [p.buried] : []));
  const su = user.length > 0 ? user.filter((v) => v === "kept").length / user.length : NaN;
  const sb = buried.length > 0 ? buried.filter((v) => v === "kept").length / buried.length : NaN;

  const checks: Array<[string, number, number, number]> = [
    ["re-fetch verbatim coverage", full, FLOOR_REFETCH_FULL, reads],
    ["planted user constraint survival", su, FLOOR_PLANTED_USER, user.length],
    ["planted buried restatement survival", sb, FLOOR_PLANTED_BURIED, buried.length],
  ];

  console.log("\ncompaction gate (both goals, one verdict):");
  let failed = false;

  for (const [name, val, floor, n] of checks) {
    const ok = val >= floor;

    if (!ok) failed = true;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(38)} ${(100 * val).toFixed(1).padStart(5)}%  floor ${Math.round(100 * floor)}%  n=${n}`);
  }

  if (tally.calls > 0) {
    const rate = tally.failed / tally.calls;
    const clean = tally.failed === 0;

    if (!clean) failed = true;
    console.log(
      `  ${clean ? "ok  " : "FAIL"} ${"backend chunk failures".padEnd(38)} ${(100 * rate).toFixed(1).padStart(5)}%  ceiling 0%  n=${tally.calls}`
    );

    for (const [why, count] of [...tally.errors].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.log(`         ${count}x ${why}`);
    }
  }

  const byKind: Array<[string, string[], Array<string | null>]> = [
    ["user", user, plants.flatMap((p) => (p !== null ? [p.userCut] : []))],
    ["buried", buried, plants.flatMap((p) => (p !== null ? [p.buriedCut] : []))],
  ];

  for (const [name, fates, cuts] of byKind) {
    const tally = fates.reduce<Record<string, number>>((acc, f) => {
      acc[f] = (acc[f] ?? 0) + 1;

      return acc;
    }, {});

    console.log(
      `  ${name.padEnd(38)} ${Object.entries(tally)
        .map(([k, v]) => `${k} ${v}`)
        .join("  ")}`
    );

    const reported = cuts.filter((v) => v !== null);

    if (reported.length > 0) {
      console.log(`    ${name} cut, key offset/original->kept: ${reported.join(" ")}`);
    }
  }

  return failed ? 2 : 0;
}

interface Args {
  synth: number;
  seed: number;
  workers: number;
  explain: boolean;
  maxInflight: number;
  decisionModel?: string;
  out?: string;
  projects?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { synth: 0, seed: 0, workers: 4, explain: false, maxInflight: 0 };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--synth") args.synth = Number(argv[++i]);
    else if (argv[i] === "--seed") args.seed = Number(argv[++i]);
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--explain") args.explain = true;
    else if (argv[i] === "--decision-model") args.decisionModel = argv[++i];
    else if (argv[i] === "--max-inflight") args.maxInflight = Number(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--projects") args.projects = argv[++i];
  }

  return args;
}

async function pooled<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];

  for (let i = 0; i < items.length; i += workers) {
    const batch = items.slice(i, i + workers);
    results.push(...(await Promise.allSettled(batch.map(fn))));
  }

  return results;
}

export async function cmdCompact(args: Args): Promise<number> {
  const base: DecisionBackend =
    args.decisionModel === undefined
      ? DEFAULT_BACKEND
      : resolveDecisionBackend(args.decisionModel);

  const { backend: decisionBackend, tally } = tallying(base, args.maxInflight);

  const files = (function walk(dir: string): string[] {
    const out: string[] = [];

    if (!fs.existsSync(dir)) return out;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);

      if (entry.isDirectory()) out.push(...walk(p));
      else if (entry.name.endsWith(".jsonl")) out.push(p);
    }

    return out;
  })(args.projects ?? PROJECTS).sort();

  const [cache, summaries] = loadCompactCache();
  fs.mkdirSync(DATA, { recursive: true });
  const cacheF = fs.openSync(COMPACT_CACHE, "a");
  const real: EventRow[] = [];
  const synth: EventRow[] = [];
  const skipped: string[] = [];
  const realTodo: Array<[string, string[], number, number, number, Boundary, string]> = [];
  const candidates: Array<[string, string[], number, number, number, null, string]> = [];

  for (const fp of files) {
    let lines: string[];

    try {
      lines = fs.readFileSync(fp, "utf8").split("\n");
    } catch {
      continue;
    }

    const norm = fp.includes("/subagents/")
      ? lines.map((line) => {
          const d = parseJsonObject(line);

          if (d === null) return line;

          delete d["isSidechain"];

          return JSON.stringify(d);
        })
      : lines;

    const evs = boundaries(norm);

    if (evs.length > 0) {
      let prev = -1;

      for (let n = 0; n < evs.length; n++) {
        const end = n + 1 < evs.length ? evs[n + 1]!.i : norm.length;
        realTodo.push([fp, norm, evs[n]!.i, end, prev, evs[n]!, "real"]);
        prev = evs[n]!.i;
      }
    } else {
      if (norm.slice(0, 200).some((line) => line.includes(CONTINUED))) skipped.push(fp);
      const cut = synthCut(norm);

      if (cut !== null) candidates.push([fp, norm, cut, norm.length, -1, null, "synth"]);
    }
  }

  let synthTodo = candidates;

  if (args.synth > 0 && candidates.length > args.synth) {
    synthTodo = shuffle(candidates, mulberry32(String(args.seed))).slice(0, args.synth);
  } else if (args.synth === 0) {
    synthTodo = [];
  }

  const todo = [...realTodo, ...synthTodo];
  console.error(`  events: ${realTodo.length} real, ${synthTodo.length} synth`);
  let done = 0;

  const explainRows: { session: string; event_i: number; key: string; cause: string }[] = [];

  const analyze = async (t: [string, string[], number, number, number, Boundary | null, string]): Promise<EventRow> => {
    const [fp, lines, i, end, prevI, ev, kind] = t;
    const pre = toolCalls(lines, prevI + 1, i);
    const post = toolCalls(lines, kind === "real" ? i + 1 : i, end);
    const reads = refetches(pre, post);
    let summary: string | null = null;
    let defaultCtx: string;
    let postTokens: number;
    let durationS: number | null;
    let trigger: JsonValue | null;
    let kept: string[];
    let stats: Stats;

    if (kind === "real") {
      ({ kept, stats } = await replay(lines.slice(0, i), cache, summaries, cacheF, decisionBackend));
      defaultCtx = ev!.summary + "\n" + ev!.preserved;
      const meta = ev!.meta;
      const durationMs = meta["durationMs"];
      postTokens = Math.floor(defaultCtx.length / 4);
      durationS = Math.round((isNumber(durationMs) ? durationMs : 0) / 100) / 10;
      trigger = meta["trigger"] ?? null;
    } else {
      const r = await replay(
        lines.slice(0, i),
        cache,
        summaries,
        cacheF,
        decisionBackend,
        () => genSummary(flatten(lines, i))
      );

      ({ kept, stats } = r);
      defaultCtx = (r.summary ?? "") + "\n" + tailText(lines, i);
      postTokens = Math.floor(defaultCtx.length / 4);
      durationS = null;
      trigger = "synth";
      summary = r.summary;
    }

    const gated = kept.length === 0;
    const digestRows: string[] = gated ? [] : kept;
    const digest = digestRows.join("\n");
    const digestFull = digestRows.filter((t) => !t.includes("elided by jev-compact")).join("\n");
    const sessionKey = fp.split("/").slice(-2, -1)[0]!.slice(0, 48);

    if (args.explain && kind === "real" && !gated) {
      for (const k of reads) {
        if (covered(k, digest)) continue;

        const terms = keyTerms(k);
        const hits = stats.rows.filter((r) => terms.some((t) => r.ref.includes(t)));

        let cause = "no-match";

        if (hits.length > 0) {
          const best = hits.find((r) => r.verdict !== "dropped") ?? hits[0]!;

          cause =
            best.verdict === "dropped"
              ? best.keep !== null && best.keep >= KEEP_THRESHOLD
                ? "dropped-budget"
                : `dropped-judge:${best.kind}:k${best.keep === null ? "null" : best.keep.toFixed(2)}`
              : `kept-${best.verdict}`;
        }

        explainRows.push({ session: sessionKey, event_i: i, key: k, cause });
      }
    }

    return {
      kind,
      session: sessionKey,
      subagent: fp.includes("/subagents/"),
      event_i: i,
      n_blocks: stats.judged + stats.pinned,
      trigger,
      post_tokens: postTokens,
      duration_s: durationS,
      jev_tokens: gated ? 0 : stats.est_tokens_after,
      jev_ms: stats.ms,
      jev_gated: gated,
      jev_kept: gated ? 0 : stats.kept,
      no_summary: kind === "synth" && !summary,
      refetch_reads: reads.length,
      refetch_default_covered: reads.filter((k) => covered(k, defaultCtx)).length,
      refetch_jev_covered: reads.filter((k) => covered(k, digest)).length,
      refetch_jev_full: reads.filter((k) => covered(k, digestFull)).length,
    };
  };

  const settled = await pooled(todo, args.workers, analyze);

  for (const f of settled) {
    if (f.status === "fulfilled") {
      (f.value.kind === "real" ? real : synth).push(f.value);
    } else {
      process.stderr.write(`  event failed: ${String(f.reason).slice(0, 200)}\n`);
    }

    done++;

    if (done % 5 === 0 || done === todo.length) process.stderr.write(`\r  analyzed ${done}/${todo.length}`);
  }

  if (todo.length > 0) process.stderr.write("\n");
  fs.closeSync(cacheF);

  const plantFuts = await pooled(todo, args.workers, (t) =>
    runEvent(t[0], t[1], t[2], t[6], args.seed, decisionBackend)
  );

  const plantResults = plantFuts.filter((f): f is PromiseFulfilledResult<PlantResult> => f.status === "fulfilled" && f.value !== null).map((f) => f.value);

  const tot: Record<string, number> = {};

  for (const r of [...real, ...synth]) {
    for (const k of ["post_tokens", "jev_ms", "jev_tokens", "refetch_reads", "refetch_default_covered", "refetch_jev_covered", "refetch_jev_full"] as const) {
      tot[k] = (tot[k] ?? 0) + (r[k] || 0);
    }

    tot["events"] = (tot["events"] ?? 0) + 1;
    tot["gated"] = (tot["gated"] ?? 0) + (r.jev_gated ? 1 : 0);
    tot["no_summary"] = (tot["no_summary"] ?? 0) + (r.no_summary ? 1 : 0);
  }

  const n = tot["events"] ?? 0;
  console.log("default compaction vs Jev selection, replayed on the same blocks");
  console.log(`  real events: ${real.length}, synth: ${synth.length}, skipped files: ${skipped.length}`);

  if (n > 0) {
    console.log(
      `  TOTAL ${n} events | re-reads ${tot["refetch_reads"]} | default covered ${tot["refetch_default_covered"]} | jev covered ${tot["refetch_jev_covered"]} | jev verbatim ${tot["refetch_jev_full"]}`
    );
    console.log(
      `  per event: default ${Math.round(tot["post_tokens"] / n)} tok vs jev ${Math.round(tot["jev_tokens"] / n)} tok (+${Math.round(tot["jev_ms"] / n)}ms judging)`
    );

    if (tot["gated"]) console.log(`    * ${tot["gated"]} kept no rows — jev applied nothing`);

    if (tot["no_summary"]) console.log(`    ! ${tot["no_summary"]} synthetic events have no summary (pi -p failed)`);
  }

  if (skipped.length > 0) console.log(`\nskipped ${skipped.length} transcripts whose compaction happened in an earlier session file`);

  const outPath = args.out ?? path.join(DATA, "compare_compact.jsonl");
  fs.writeFileSync(outPath, [...real, ...synth].map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nrows -> ${outPath}`);

  if (args.explain) {
    const byCause = new Map<string, number>();

    for (const e of explainRows) byCause.set(e.cause, (byCause.get(e.cause) ?? 0) + 1);

    console.log("\nuncovered re-read attribution (real events):");

    for (const [c, n] of [...byCause].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);

    const byEvent = new Map<string, number>();

    for (const e of explainRows) {
      const k = `${e.session}:${e.event_i}`;

      byEvent.set(k, (byEvent.get(k) ?? 0) + 1);
    }

    const worst = new Set([...byEvent].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k));

    console.log("worst events (detail):");

    for (const e of explainRows) {
      const k = `${e.session}:${e.event_i}`;

      if (worst.has(k)) console.log(`  ${k}  ${e.cause.padEnd(16)} ${e.key.slice(0, 80)}`);
    }
  }

  return gate([...real, ...synth], plantResults, tally);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath2(import.meta.url);

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd !== "compact") {
    console.error("usage: node compact.js compact [--synth N] [--seed N] [--workers N] [--out P]");
    process.exit(2);
  }

  cmdCompact(parseArgs(rest))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
