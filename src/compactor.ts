#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { appendLogLine } from "../adapters/afk/src/shared/config.ts";
import { isJsonObject, isJsonArray, isString, type JsonValue } from "../adapters/afk/src/shared/json.ts";
import {
  blockText,
  judgeable,
  selectBlocks,
  DIRECTIVE_CHARS,
  MAX_BLOCKS,
  RESCUE_BLOCKS,
  type Block,
  type Kept,
  type Stats,
} from "./compact/strategy.ts";

export const ROWS_HEADER =
  "This session's history was compacted by Jev. Every message below " +
  "was judged still needed and kept verbatim, or as a head with an " +
  "elision note; everything else was dropped. Continue the last task " +
  "without asking the user to repeat anything.";

const STATS_LOG = "jev-compact-log.jsonl";

export interface CompactRow {
  role?: JsonValue;
  text?: JsonValue;
  toolUses?: JsonValue;
  toolResults?: JsonValue;
  handle?: JsonValue;
}

interface ClaudeBlock extends Block {
  row?: CompactRow;
}

interface LoggedStats extends Stats {
  trigger?: string;
  rows_in?: number;
  rows_out?: number;
  passed_through?: number;
}

export function rowText(row: CompactRow): string | null {
  const content: JsonValue[] = [{ type: "text", text: row.text ?? "" }];

  for (const u of isJsonArray(row.toolUses) ? row.toolUses : []) {
    if (!isJsonObject(u)) continue;

    content.push({ type: "tool_use", name: u["tool"] ?? "?", input: u["input"] ?? {} });
  }

  for (const r of isJsonArray(row.toolResults) ? row.toolResults : []) {
    if (!isJsonObject(r)) continue;

    content.push({ type: "tool_result", content: r["text"] });
  }

  return judgeable(isString(row.role) ? row.role : "", blockText(content).trim());
}

function plainRow(row: CompactRow): boolean {
  return !row.toolUses && !row.toolResults;
}

function textRow(role: string, text: string): CompactRow {
  return { role, text, toolUses: [], toolResults: [] };
}

function rowsOut(blocks: ClaudeBlock[], kept: Kept[]): CompactRow[] {
  const out: CompactRow[] = [textRow("user", ROWS_HEADER)];

  for (const k of kept) {
    const block = blocks[k.i]!;
    const row = block.row;

    if (row && plainRow(row) && k.text === block.text) out.push(row);
    else out.push(textRow(block.role, k.text));
  }

  return out;
}

function fallback(reason: string): number {
  process.stdout.write(JSON.stringify({ fallback: reason }) + "\n");

  return 0;
}

function logStats(sessionId: string | undefined, stats: LoggedStats): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      session_id: sessionId ?? null,
      source: "rows",
      ...stats,
    };

    appendLogLine(STATS_LOG, JSON.stringify(row));
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

  const directive = (event.instructions ?? "").trim().slice(0, DIRECTIVE_CHARS) || null;

  const incoming = (isJsonArray(event.messages) ? event.messages : []).filter((r): r is CompactRow =>
    isJsonObject(r)
  );

  const blocks: ClaudeBlock[] = [];

  for (let i = incoming.length - 1; i >= 0; i--) {
    if (blocks.length === MAX_BLOCKS + RESCUE_BLOCKS) break;
    const r = incoming[i]!;
    const text = rowText(r);

    if (text !== null) blocks.push({ role: isString(r.role) ? r.role : "assistant", text, row: r });
  }

  blocks.reverse();

  if (blocks.length === 0) return fallback("no judgeable rows");

  let kept: Kept[];
  let stats: LoggedStats;

  try {
    [kept, stats] = await selectBlocks(blocks, event.cwd ?? null, directive);
  } catch (e) {
    return fallback(`jev: ${String(e)}`);
  }

  stats.trigger = event.trigger;
  stats.rows_in = incoming.length;
  const out = rowsOut(blocks, kept);
  stats.rows_out = out.length;
  stats.passed_through = out.filter((r) => r["handle"] !== undefined).length;
  logStats(event.session_id, stats);
  const what = event.trigger ? `${event.trigger} compaction` : "compaction";
  process.stdout.write(
    JSON.stringify({
      messages: out,
      summary: `${what} replaced by ${out.length} rows (kept ${stats.kept}, ${stats.truncated} truncated, ${Math.round(stats.reduction * 100)}% smaller, ${stats.ms} ms)`,
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
    process.stderr.write("usage: compactor.ts rows  (reads a session.compact event on stdin)\n");
    process.exit(2);
  }
}
