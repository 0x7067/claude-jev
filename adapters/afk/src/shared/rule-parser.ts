import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { jevAsk, type Questions } from "./jev-client.ts";
import {
  isJsonObject,
  isJsonArray,
  isString,
  isNumber,
  parseJsonObject,
  type Json,
  type JsonValue,
} from "./json.ts";
import {
  ruleQuestions,
  INSTRUCTION_MIN,
  TURN_MIN,
  CHOICE_MIN,
  DEFAULT_SUBJECT,
  DEFAULT_POLARITY,
  ITEMS_PER_REQUEST,
  POLARITY_CRITERIA,
  SUBJECT_CRITERIA,
} from "./questions.ts";
import { slugify } from "./utils.ts";
import { configDir } from "./config.ts";

export interface Rule {
  id: string;
  text: string;
  file: string;
  line: number;
  scope: string[];
  when: "edit" | "turn";
  fileHash: string;
  polarity: string;
  subject: string;
  context: string;
}

const MIN_ITEM_CHARS = 20;

const MAX_ITEM_CHARS = 600;

const MAX_NESTED_DEPTH = 4;

const RULE_CONTEXT_CHARS = 400;

const RULE_FILES = ["CLAUDE.md", "AGENTS.md"];

const AFK_RULE_FILES = ["AFK.md"];

const RULE_DIRS = [".claude/rules", ".cursor/rules"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "coverage",
  ".turbo",
  ".cache",
  "target",
  ".claude",
  "Library",
]);

function sameFilesystem(parent: string, path: string): boolean {
  try {
    return fs.lstatSync(path).dev === fs.lstatSync(parent).dev;
  } catch {
    return false;
  }
}

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(.*)/;

const HEADING = /^\s*#{1,6}\s+/;

const FRONT_MATTER = /^---\s*$/;

const SENTENCE = /(?<=\.)\s+(?=[A-Z])/;

const SCOPE_TAIL = /\(scope:\s*([^)]+)\)\s*$/;

const NAMED = /^\*\*([\w-]+)\*\*:?\s*(.*)/;

const CACHE_PATH = path.join(os.homedir(), ".afk", "jev-rule-cache.json");

export interface LoadRulesOptions {
  cachePath?: string;
  timeoutMs?: number;
  afkRules?: boolean;
}

type CacheData = Record<string, JsonValue>;

function loadCache(cachePath: string): CacheData {
  try {
    return parseJsonObject(fs.readFileSync(cachePath, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function saveCache(cache: CacheData, cachePath: string): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = cachePath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cachePath);
  } catch {
  }
}

function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE).map((t) => t.trim());
  const keep = parts.filter((t) => t.length >= MIN_ITEM_CHARS);

  return keep.length > 0 ? keep : [text];
}

function frontmatterPaths(lines: string[]): string[] {
  const paths: string[] = [];

  if (!lines.length || !FRONT_MATTER.test(lines[0]!)) return paths;
  let inPaths = false;

  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();

    if (FRONT_MATTER.test(line)) break;

    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }

    if (inPaths) {
      const m = line.match(/^\s*-\s*["']?(.*?)["']?\s*$/);

      if (m) {
        paths.push(m[1]!);
        continue;
      }

      inPaths = false;
    } else {
      const m = line.match(/^paths:\s*\[(.*)\]/);

      if (m) {
        paths.push(...m[1]!.split(",").map((p) => p.trim().replace(/^['"]|['"]$/g, "")));
      }
    }
  }

  return paths;
}

interface Item {
  lineNo: number;
  text: string;
}

function markdownItems(lines: string[]): Item[] {
  const items: Item[] = [];
  let curLine = 0;
  let cur: string[] = [];
  let isBullet = false;
  let inFence = false;
  let inFront = lines.length > 0 && FRONT_MATTER.test(lines[0]!);

  function flush() {
    if (cur.length > 0) {
      const text = cur.map((x) => x.trim()).join(" ");

      if (!isBullet && text.length > MAX_ITEM_CHARS) {
        for (const t of splitSentences(text)) {
          items.push({ lineNo: curLine, text: t });
        }
      } else {
        items.push({ lineNo: curLine, text });
      }

      cur = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    const lineNum = i + 1;

    if (inFront) {
      if (i > 0 && FRONT_MATTER.test(line)) inFront = false;
      continue;
    }

    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      flush();
      continue;
    }

    if (inFence) continue;

    if (!line.trim() || HEADING.test(line) || line.trimStart().startsWith("|")) {
      flush();
      continue;
    }

    const m = BULLET.exec(line);

    if (m) {
      flush();
      curLine = lineNum;
      cur = [m[1]!];
      isBullet = true;
    } else if (cur.length > 0 && (line.startsWith(" ") || line.startsWith("\t") || !isBullet)) {
      cur.push(line);
    } else {
      flush();
      curLine = lineNum;
      cur = [line];
      isBullet = false;
    }
  }

  flush();

  return items;
}

interface ClassifiedItem {
  when: "edit" | "turn";
  polarity: string;
  subject: string;
}

function choiceOf(
  answer: Json | undefined,
  criteria: Record<string, string>,
  defaultVal: string
): string {
  if (!answer) return defaultVal;

  const pick = answer["choice"];
  const conf = answer["confidence"];

  if (isString(pick) && pick in criteria && isNumber(conf) && conf >= CHOICE_MIN) return pick;

  return defaultVal;
}

function sortedStringify(val: JsonValue): string {
  if (isJsonArray(val)) {
    return "[" + val.map(sortedStringify).join(", ") + "]";
  }

  if (isJsonObject(val)) {
    const pairs = Object.keys(val)
      .sort()
      .map((k) => JSON.stringify(k) + ": " + sortedStringify(val[k]));

    return "{" + pairs.join(", ") + "}";
  }

  return JSON.stringify(val);
}

function chunkKey(state: string, questions: Questions): string {
  return crypto
    .createHash("sha256")
    .update(sortedStringify([state, questions]))
    .digest("hex");
}

function sectionHeadings(lines: string[], items: Item[]): Map<number, string> {
  const out = new Map<number, string>();
  let current = "no heading";
  const ordered = [...items].sort((a, b) => a.lineNo - b.lineNo);
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    if (HEADING.test(line)) current = line.replace(/^\s*#{1,6}\s+/, "").trim();

    while (pos < ordered.length && ordered[pos]!.lineNo === lineNum) {
      out.set(lineNum, current);
      pos++;
    }
  }

  return out;
}

async function classifyChunk(
  start: number,
  chunk: Item[],
  headings: Map<number, string>,
  cache: CacheData,
  cachePath: string,
  timeoutMs: number | undefined
): Promise<Map<number, ClassifiedItem>> {
  const state = chunk
    .map(
      (item, i) =>
        "[" + i + "] (" + (headings.get(item.lineNo) ?? "no heading") + ") " + item.text
    )
    .join("\n\n");

  const questions = ruleQuestions(chunk.length);
  const key = chunkKey(state, questions);

  const hit = cache[key];

  if (isJsonObject(hit)) {
    const result = new Map<number, ClassifiedItem>();

    for (const [k, v] of Object.entries(hit)) {
      if (!/^\d+$/.test(k)) continue;
      const idx = parseInt(k, 10);

      if (isJsonObject(v)) {
        const when = v["when"];

        if (when === "edit" || when === "turn") {
          result.set(idx, {
            when,
            polarity: isString(v["polarity"]) ? v["polarity"] : DEFAULT_POLARITY,
            subject: isString(v["subject"]) ? v["subject"] : DEFAULT_SUBJECT,
          });
        }
      }
    }

    return new Map([...result].map(([k2, v2]) => [start + k2, v2]));
  }

  const answers = await jevAsk(state, questions, timeoutMs);

  if (Object.keys(answers).length === 0) {
    throw new Error("backend returned no answers");
  }

  const out: Record<number, ClassifiedItem> = {};

  for (let i = 0; i < chunk.length; i++) {
    const q = answers["q" + i];
    const p = q && "noul" in q ? q.noul : undefined;

    if (!isNumber(p) || p < INSTRUCTION_MIN) continue;
    const t = answers["t" + i];
    const tn = t && "noul" in t ? t.noul : undefined;
    const turn = isNumber(tn) && tn >= TURN_MIN;
    out[i] = {
      when: turn ? "turn" : "edit",
      polarity: choiceOf(answers["p" + i], POLARITY_CRITERIA, DEFAULT_POLARITY),
      subject: choiceOf(answers["s" + i], SUBJECT_CRITERIA, DEFAULT_SUBJECT),
    };
  }

  cache[key] = Object.fromEntries(
    Object.entries(out).map(([k, v]): [string, Json] => [k, { when: v.when, polarity: v.polarity, subject: v.subject }])
  );
  saveCache(cache, cachePath);

  return new Map(Object.entries(out).map(([k, v]) => [start + parseInt(k, 10), v]));
}

async function classifyItems(
  lines: string[],
  items: Item[],
  cachePath: string,
  timeoutMs?: number
): Promise<Map<number, ClassifiedItem>> {
  const cache = loadCache(cachePath);
  const headings = sectionHeadings(lines, items);
  const starts: number[] = [];

  for (let s = 0; s < items.length; s += ITEMS_PER_REQUEST) starts.push(s);

  const meta = new Map<number, ClassifiedItem>();

  if (starts.length <= 1) {
    for (const start of starts) {
      const chunk = items.slice(start, start + ITEMS_PER_REQUEST);

      for (const [k, v] of await classifyChunk(
        start,
        chunk,
        headings,
        cache,
        cachePath,
        timeoutMs
      )) {
        meta.set(k, v);
      }
    }

    return meta;
  }

  const errors: unknown[] = [];

  for (let i = 0; i < starts.length; i += 8) {
    const batch = starts.slice(i, i + 8);

    const settled = await Promise.allSettled(
      batch.map((start) =>
        classifyChunk(
          start,
          items.slice(start, start + ITEMS_PER_REQUEST),
          headings,
          cache,
          cachePath,
          timeoutMs
        )
      )
    );

    for (const r of settled) {
      if (r.status === "fulfilled") {
        for (const [k, v] of r.value) meta.set(k, v);
      } else {
        errors.push(r.reason);
      }
    }
  }

  if (errors.length > 0 && meta.size === 0) throw errors[0];

  return meta;
}

async function parseRules(
  filePath: string,
  baseLabel?: string,
  fileScope?: string[],
  opts: LoadRulesOptions = {}
): Promise<Rule[]> {
  let lines: string[];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    lines = content.split("\n");
  } catch {
    return [];
  }

  const base = baseLabel ?? path.basename(filePath);
  const fileHash = crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  const scope0 = [...(fileScope ?? []), ...frontmatterPaths(lines)];

  const rawItems = markdownItems(lines);
  const items = rawItems.filter((item) => item.text.trim().length >= MIN_ITEM_CHARS);

  const meta = await classifyItems(lines, items, opts.cachePath ?? CACHE_PATH, opts.timeoutMs);

  const rules: Rule[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    if (!meta.has(idx)) continue;
    const { when, polarity, subject } = meta.get(idx)!;
    let text = items[idx]!.text.trim();

    const around = items
      .slice(Math.max(0, idx - 1), idx + 2)
      .filter((it) => it.text !== text)
      .map((it) => it.text)
      .join(" ")
      .slice(0, RULE_CONTEXT_CHARS);

    if (text.length > MAX_ITEM_CHARS) {
      const cut = text.lastIndexOf(". ", MAX_ITEM_CHARS);
      text = cut > 100 ? text.slice(0, cut + 1) : text.slice(0, MAX_ITEM_CHARS);
    }

    const scope = [...scope0];
    const sm = SCOPE_TAIL.exec(text);

    if (sm) {
      scope.push(...sm[1]!.split(",").map((g) => g.trim()));
      text = text.slice(0, sm.index).trim();
    }

    let name: string | null = null;
    const nm = NAMED.exec(text);

    if (nm) {
      name = nm[1]!;
      text = nm[2]!.trim() || text;
    }

    rules.push({
      id: name ?? slugify(text),
      text,
      file: base,
      line: items[idx]!.lineNo,
      scope,
      when,
      fileHash,
      polarity,
      subject,
      context: around,
    });
  }

  return rules;
}

function nestedFiles(cwd: string): Array<{ filePath: string; scope: string }> {
  const out: Array<{ filePath: string; scope: string }> = [];

  function walk(dir: string, depth: number) {
    if (depth > MAX_NESTED_DEPTH) return;
    let entries: string[];

    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      return;
    }

    if (depth > 0) {
      const rel = path.relative(cwd, dir);

      for (const name of RULE_FILES) {
        const p = path.join(dir, name);

        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          out.push({ filePath: p, scope: rel + "/**" });
        }
      }
    }

    for (const entry of entries) {
      const sub = path.join(dir, entry);

      try {
        if (entry.startsWith(".") || SKIP_DIRS.has(entry) || !sameFilesystem(dir, sub)) {
          continue;
        }

        if (
          fs.statSync(sub).isDirectory() &&
          !fs.existsSync(path.join(sub, ".git"))
        ) {
          walk(sub, depth + 1);
        }
      } catch {
      }
    }
  }

  walk(cwd, 0);

  return out;
}

function dedupe(rules: Rule[]): Rule[] {
  const seen = new Set<string>();
  const out: Rule[] = [];

  for (const r of rules) {
    const key = r.text.toLowerCase().trim().split(/\s+/).join(" ");

    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }

  return out;
}

export async function loadRules(
  cwd: string,
  opts: LoadRulesOptions = {}
): Promise<Rule[]> {
  const rules: Rule[] = [];
  const cachePath = opts.cachePath ?? CACHE_PATH;

  for (const name of [...RULE_FILES, ...(opts.afkRules === true ? AFK_RULE_FILES : [])]) {
    const p = path.join(cwd, name);

    if (fs.existsSync(p)) {
      rules.push(
        ...(await parseRules(p, undefined, undefined, { cachePath, timeoutMs: opts.timeoutMs }))
      );
    }
  }

  for (const dir of RULE_DIRS) {
    const dirPath = path.join(cwd, dir);

    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      let entries: string[];

      try {
        entries = fs.readdirSync(dirPath).sort();
      } catch {
        entries = [];
      }

      for (const fn of entries) {
        if (fn.endsWith(".md") || fn.endsWith(".mdc")) {
          rules.push(
            ...(await parseRules(path.join(dirPath, fn), dir + "/" + fn, undefined, {
              cachePath,
              timeoutMs: opts.timeoutMs,
            }))
          );
        }
      }
    }
  }

  for (const { filePath, scope } of nestedFiles(cwd)) {
    rules.push(
      ...(await parseRules(filePath, path.relative(cwd, filePath), [scope], {
        cachePath,
        timeoutMs: opts.timeoutMs,
      }))
    );
  }

  const globalPath = path.join(configDir(), "CLAUDE.md");

  if (fs.existsSync(globalPath)) {
    const rel = path.relative(os.homedir(), globalPath);
    rules.push(
      ...(await parseRules(globalPath, "~/" + rel, undefined, {
        cachePath,
        timeoutMs: opts.timeoutMs,
      }))
    );
  }

  return dedupe(rules);
}

export function globMatch(filePath: string, globs: string[]): boolean {
  for (const g of globs) {
    const trimmed = g.trim();

    if (!trimmed) continue;

    const rx = trimmed
      .replace(/\*\*\//g, "DSTAR_SLASH")
      .replace(/\*\*/g, "DSTAR")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/DSTAR_SLASH/g, "(?:.*/)?")
      .replace(/DSTAR/g, ".*");

    if (new RegExp("^" + rx + "$").test(filePath)) return true;
  }

  return false;
}

const COMMENT_RE = new RegExp("(^|\\s)(#|\\/\\/|\\/\\*|\\*\\/|<!--)|\"\"\"|\\'\\'\\'");

const IMPORTISH_RE =
  /^\s*[-+]?\s*(import\b|from\s+\S+\s+import\b|export\s+\*|const\s+\w+\s*=\s*require\(|require\(|use\s+\w|#include\b|using\b)/m;

const MANIFEST_RE =
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|setup\.py)$/;

export const TESTISH_RE = /\btest|\bspec\b|describe\(|\bit\(|assert|expect\(/i;

const NUMBER_RE = /(?<![\w.])-?\d[\d_]*(\.\d+)?\b/g;

const STRINGY_RE = /"[^"\n]{4,}"|'[^'\n]{4,}'|`[^`\n]{4,}`/;

const DEFINES_RE =
  /^\s*[-+]?\s*(def\b|class\b|function\b|const\b|let\b|var\b|type\b|interface\b|enum\b|struct\b|fn\b|export\b)/m;

const TYPEISH_RE =
  /(:\s*[A-Z][\w[\]<>.]*|\bany\b|\bas\b|\binterface\b|\btype\b|->\s*[\w[\]]+|\bSchema\b)/;

const ERRORISH_RE =
  /\b(try|catch|except|finally|throw|raise|Result|Error|Exception|panic|rescue)\b/i;

type SubjectTest = (hunk: string, rel: string) => boolean;

const SUBJECT_TESTS = new Map<string, SubjectTest>([
  ["imports_deps", (h, rel) => IMPORTISH_RE.test(h) || MANIFEST_RE.test(rel)],
  ["comments", (h) => COMMENT_RE.test(h)],
  ["tests", (h, rel) => TESTISH_RE.test(h) || TESTISH_RE.test(rel)],
  [
    "literals_constants",
    (h) => {
      if (STRINGY_RE.test(h)) return true;
      const nums = Array.from(h.matchAll(NUMBER_RE));

      return nums.some((m) => !["0", "1", "-1"].includes(m[0]!));
    },
  ],
  ["naming", (h) => DEFINES_RE.test(h)],
  ["types", (h) => TYPEISH_RE.test(h)],
  ["errors", (h) => ERRORISH_RE.test(h)],
]);

export function isSubjectRelevant(hunk: string, subject: string, rel: string): boolean {
  const test = SUBJECT_TESTS.get(subject);

  return test ? test(hunk, rel) : true;
}
