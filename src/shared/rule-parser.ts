import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { jevAsk } from "./jev-client.js";
import {
  ruleQuestions,
  INSTRUCTION_Q,
  TURN_Q,
  POLARITY_Q,
  SUBJECT_Q,
  INSTRUCTION_MIN,
  TURN_MIN,
  CHOICE_MIN,
  DEFAULT_SUBJECT,
  DEFAULT_POLARITY,
  ITEMS_PER_REQUEST,
  TURN_CRITERIA,
  POLARITY_CRITERIA,
  SUBJECT_CRITERIA,
} from "./questions.js";
import { slugify } from "./utils.js";
import type { Answers } from "./jev-client.js";

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
}

const MIN_ITEM_CHARS = 20;
const MAX_ITEM_CHARS = 600;
const MAX_NESTED_DEPTH = 4;

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
]);

const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(.*)/;
const HEADING = /^\s*#{1,6}\s+/;
const FRONT_MATTER = /^---\s*$/;
const SENTENCE = /(?<=\.)\s+(?=[A-Z])/;
const SCOPE_TAIL = /\(scope:\s*([^)]+)\)\s*$/;

const CACHE_PATH = path.join(os.homedir(), ".afk", "jev-rule-cache.json");

function loadCache(): Record<string, Record<string, unknown>> {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const data = JSON.parse(raw);
    return typeof data === "object" && data !== null
      ? (data as Record<string, Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, Record<string, unknown>>): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
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
  answer: Record<string, unknown> | undefined,
  criteria: Record<string, string>,
  defaultVal: string
): string {
  if (!answer) return defaultVal;
  const pick = answer["choice"] as string | undefined;
  const conf = answer["confidence"] as number | undefined;
  if (pick && pick in criteria && typeof conf === "number" && conf >= CHOICE_MIN) return pick;
  return defaultVal;
}

function digestKey(questionStr: string, content: string): string {
  return crypto
    .createHash("sha256")
    .update(questionStr + content)
    .digest("hex");
}

function sortedStringify(val: unknown): string {
  if (Array.isArray(val)) {
    return `[${val.map(sortedStringify).join(", ")}]`;
  }
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}: ${sortedStringify(obj[k])}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(val);
}

function questionKey(): string {
  return (
    INSTRUCTION_Q +
    TURN_Q +
    POLARITY_Q +
    SUBJECT_Q +
    sortedStringify([TURN_CRITERIA, POLARITY_CRITERIA, SUBJECT_CRITERIA])
  );
}

async function classifyItems(
  lines: string[],
  items: Item[]
): Promise<Map<number, ClassifiedItem>> {
  const content = lines.join("");
  const key = digestKey(questionKey(), content);

  const cache = loadCache();
  const hit = cache[key];
  if (typeof hit === "object" && hit !== null) {
    const result = new Map<number, ClassifiedItem>();
    for (const [k, v] of Object.entries(hit)) {
      const idx = parseInt(k, 10);
      if (!isNaN(idx) && typeof v === "object" && v !== null) {
        const vr = v as Record<string, unknown>;
        if (vr["when"] === "edit" || vr["when"] === "turn") {
          result.set(idx, {
            when: vr["when"] as "edit" | "turn",
            polarity: (vr["polarity"] as string) ?? DEFAULT_POLARITY,
            subject: (vr["subject"] as string) ?? DEFAULT_SUBJECT,
          });
        }
      }
    }
    return result;
  }

  const meta = new Map<number, ClassifiedItem>();

  for (let start = 0; start < items.length; start += ITEMS_PER_REQUEST) {
    const chunk = items.slice(start, start + ITEMS_PER_REQUEST);
    const state = chunk
      .map((item, ci) => `[${ci}] ${item.text}`)
      .join("\n\n");
    const questions = ruleQuestions(chunk.length);

    let answers: Answers = {};
    try {
      answers = await jevAsk(state, questions);
    } catch {
      continue;
    }

    for (let ci = 0; ci < chunk.length; ci++) {
      const qA = answers[`q${ci}`] as Record<string, unknown> | undefined;
      const p = qA?.["noul"];
      if (typeof p !== "number" || p < INSTRUCTION_MIN) continue;

      const tA = answers[`t${ci}`] as Record<string, unknown> | undefined;
      const t = tA?.["noul"];
      const isTurn = typeof t === "number" && t >= TURN_MIN;

      meta.set(start + ci, {
        when: isTurn ? "turn" : "edit",
        polarity: choiceOf(
          answers[`p${ci}`] as Record<string, unknown> | undefined,
          POLARITY_CRITERIA,
          DEFAULT_POLARITY
        ),
        subject: choiceOf(
          answers[`s${ci}`] as Record<string, unknown> | undefined,
          SUBJECT_CRITERIA,
          DEFAULT_SUBJECT
        ),
      });
    }
  }

  if (meta.size > 0) {
    const cached: Record<string, unknown> = {};
    for (const [idx, v] of meta.entries()) {
      cached[String(idx)] = v;
    }
    cache[key] = cached;
    saveCache(cache);
  }

  return meta;
}

async function parseRules(
  filePath: string,
  baseLabel?: string,
  fileScope?: string[]
): Promise<Rule[]> {
  let lines: string[];
  try {
    const content = fs.readFileSync(filePath, "utf8");
    lines = content.split("\n");
  } catch {
    return [];
  }

  const base = baseLabel ?? path.basename(filePath);
  const fileHash = crypto
    .createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 12);
  const scope0 = [...(fileScope ?? []), ...frontmatterPaths(lines)];

  const rawItems = markdownItems(lines);
  const items = rawItems.filter((item) => item.text.trim().length >= MIN_ITEM_CHARS);

  let meta: Map<number, ClassifiedItem>;
  try {
    meta = await classifyItems(lines, items);
  } catch {
    return [];
  }

  const rules: Rule[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    if (!meta.has(idx)) continue;
    const { when, polarity, subject } = meta.get(idx)!;
    let text = items[idx]!.text.trim();

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

    rules.push({
      id: slugify(text),
      text,
      file: base,
      line: items[idx]!.lineNo,
      scope,
      when,
      fileHash,
      polarity,
      subject,
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
        if (fs.existsSync(p)) {
          out.push({ filePath: p, scope: `${rel}/**` });
        }
      }
    }
    for (const entry of entries) {
      const sub = path.join(dir, entry);
      try {
        if (
          fs.statSync(sub).isDirectory() &&
          !SKIP_DIRS.has(entry) &&
          !entry.startsWith(".") &&
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
    const key = r.text.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

export async function loadRules(cwd: string): Promise<Rule[]> {
  const rules: Rule[] = [];

  for (const name of [...RULE_FILES, ...AFK_RULE_FILES]) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      rules.push(...(await parseRules(p)));
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
          rules.push(...(await parseRules(path.join(dirPath, fn), `${dir}/${fn}`)));
        }
      }
    }
  }

  for (const { filePath, scope } of nestedFiles(cwd)) {
    rules.push(
      ...(await parseRules(filePath, path.relative(cwd, filePath), [scope]))
    );
  }

  const globalPath = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (fs.existsSync(globalPath)) {
    const rel = path.relative(os.homedir(), globalPath);
    rules.push(...(await parseRules(globalPath, `~/${rel}`)));
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
    if (new RegExp(`^${rx}$`).test(filePath)) return true;
  }
  return false;
}

const COMMENT_RE = new RegExp("(^|\\s)(#|\\/\\/|\\/\\*|\\*\\/|<!--)|\"\"\"|\\'\\'\\'");
const IMPORTISH_RE =
  /^\s*[-+]?\s*(import\b|from\s+\S+\s+import\b|export\s+\*|const\s+\w+\s*=\s*require\(|require\(|use\s+\w|#include\b|using\b)/m;
const MANIFEST_RE =
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|setup\.py)$/;
const TESTISH_RE = /\btest|\bspec\b|describe\(|\bit\(|assert|expect\(/i;
const NUMBER_RE = /(?<![\w.])-?\d[\d_]*(\.\d+)?\b/g;
const STRINGY_RE = /"[^"\n]{4,}"|'[^'\n]{4,}'|`[^`\n]{4,}`/;
const DEFINES_RE =
  /^\s*[-+]?\s*(def\b|class\b|function\b|const\b|let\b|var\b|type\b|interface\b|enum\b|struct\b|fn\b|export\b)/m;
const TYPEISH_RE =
  /(:\s*[A-Z][\w\[\]<>.]*|\bany\b|\bas\b|\binterface\b|\btype\b|->\s*[\w\[\]]+|\bSchema\b)/;
const ERRORISH_RE =
  /\b(try|catch|except|finally|throw|raise|Result|Error|Exception|panic|rescue)\b/i;

type SubjectTest = (hunk: string, rel: string) => boolean;

const SUBJECT_TESTS: Record<string, SubjectTest> = {
  imports_deps: (h, rel) => IMPORTISH_RE.test(h) || MANIFEST_RE.test(rel),
  comments: (h) => COMMENT_RE.test(h),
  tests: (h, rel) => TESTISH_RE.test(h) || TESTISH_RE.test(rel),
  literals_constants: (h) => {
    if (STRINGY_RE.test(h)) return true;
    const nums = Array.from(h.matchAll(NUMBER_RE));
    return nums.some((m) => !["0", "1", "-1"].includes(m[0]!));
  },
  naming: (h) => DEFINES_RE.test(h),
  types: (h) => TYPEISH_RE.test(h),
  errors: (h) => ERRORISH_RE.test(h),
};

export function isSubjectRelevant(hunk: string, subject: string, rel: string): boolean {
  const test = SUBJECT_TESTS[subject];
  return test ? test(hunk, rel) : true;
}
