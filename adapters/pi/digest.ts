import { isAbsolute, resolve } from "node:path";
import { type Block, type Kept } from "../../src/compact/strategy.ts";

export const DIGEST_HEADER =
  "This is not a written summary. Jev selected the blocks below out of the " +
  "session transcript, and each one is verbatim text — kept whole, or cut to a " +
  "head and a tail around an elision note. Everything else was dropped. Blocks are " +
  "oldest first, each introduced by a ---[jev:<n>:<role>]--- line. Continue the " +
  "last task without asking the user to repeat anything.";

export const MAX_POINTER_LINES = 40;

// 16_000 is the selected body plus <read-files> pointers only.
// DIGEST_HEADER, ---[jev:…]--- delimiters, and <modified-files> are extra.
export const POINTER_CHARS = 2_000;

export const SELECT_CHARS = 14_000;

const DELIMITER = /^---\[jev:(\d+):([a-z_]+)\]---$/;

const FILE_LISTS = /\n?<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>\n?/g;

export interface IndexedBlock extends Block {
  refs?: readonly string[];
}

export function delimiter(i: number, role: string): string {
  return `---[jev:${i}:${role}]---`;
}

export function renderDigest(blocks: readonly Block[], kept: readonly Kept[], pointers = ""): string {
  const parts = [DIGEST_HEADER];

  for (const k of kept) {
    const block = blocks[k.i];
    const role = block === undefined ? "assistant" : block.role;

    parts.push(`${delimiter(k.i, role)}\n${k.text}`);
  }

  return parts.join("\n\n") + pointers;
}

export function pointerPaths(
  blocks: readonly IndexedBlock[],
  kept: readonly Kept[],
  cwd: string,
  maxLines = MAX_POINTER_LINES,
  budget = POINTER_CHARS
): string[] {
  if (maxLines <= 0 || budget <= 0) return [];
  const state = new Map(kept.map((k) => [k.i, k.kind]));
  const lines: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < blocks.length && lines.length < maxLines; i++) {
    const kind = state.get(i);

    if (kind !== undefined && kind !== "truncated") continue;
    const refs = blocks[i]?.refs ?? [];

    for (const ref of refs) {
      const path = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);

      if (seen.has(path)) continue;
      seen.add(path);
      lines.push(path);

      if (lines.join("\n").length > budget) {
        lines.pop();
        break;
      }
    }
  }

  return lines;
}

function canonicalPath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function withoutModified(pointers: readonly string[], modified: readonly string[], cwd: string): string[] {
  const skip = new Set<string>();

  for (const path of modified) skip.add(canonicalPath(path, cwd));

  return pointers.filter((path) => !skip.has(canonicalPath(path, cwd)));
}

export function mergeReadFiles(native: readonly string[], pointers: readonly string[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const path of [...native, ...pointers]) {
    const key = canonicalPath(path, cwd);

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }

  return out;
}

export function pointerIndex(
  blocks: readonly IndexedBlock[],
  kept: readonly Kept[],
  cwd: string,
  maxLines = MAX_POINTER_LINES,
  budget = POINTER_CHARS
): string {
  const lines = pointerPaths(blocks, kept, cwd, maxLines, budget);

  if (lines.length === 0) return "";

  return `\n\n<read-files>\n${lines.join("\n")}\n</read-files>`;
}

function splitJevDigest(summary: string): Block[] {
  const blocks: Block[] = [];

  for (const line of summary.split("\n")) {
    const match = DELIMITER.exec(line);

    if (match) {
      const role = match[2];

      if (role !== undefined) blocks.push({ role, text: "" });
    } else if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];

      if (last !== undefined) last.text += `${line}\n`;
    }
  }

  const out: Block[] = [];

  for (const block of blocks) {
    const text = block.text.replace(/\n+$/, "");

    if (text.trim() !== "") out.push({ role: block.role, text });
  }

  return out;
}

export function splitSummary(summary: string): Block[] {
  const body = summary.replace(FILE_LISTS, "\n");
  const fromJev = splitJevDigest(body);

  if (fromJev.length > 0) return fromJev;
  const sections = body.split(/\n(?=## )/);
  const split: Block[] = [];

  for (const section of sections) {
    const text = section.trim();

    if (text !== "") split.push({ role: "summary", text });
  }

  if (split.length > 1) return split;
  const text = body.trim();

  return text === "" ? [] : [{ role: "summary", text }];
}
