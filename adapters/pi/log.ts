import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { isNumber, isString, parseJsonObject, type Json } from "../afk/src/shared/json.ts";

export const CALL_LOG = "jev-calls.jsonl";

export const COMPACT_LOG = "jev-compact-log.jsonl";

const TAIL_BYTES = 4096;

export interface LogRecord {
  ts?: string;
  ok?: boolean;
  ms?: number;
  error?: string;
  trigger?: string;
  kept?: number;
  blocks_in?: number;
}

export function appendLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  } catch {
    return;
  }
}

function recordFrom(value: Json): LogRecord {
  const record: LogRecord = {};

  if (isString(value["ts"])) record.ts = value["ts"];

  if (value["ok"] === true || value["ok"] === false) record.ok = value["ok"];

  if (isNumber(value["ms"])) record.ms = value["ms"];

  if (isString(value["error"])) record.error = value["error"];

  if (isString(value["trigger"])) record.trigger = value["trigger"];

  if (isNumber(value["kept"])) record.kept = value["kept"];

  if (isNumber(value["blocks_in"])) record.blocks_in = value["blocks_in"];

  return record;
}

export function lastRecord(path: string): LogRecord | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);

    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    let last = "";

    for (const line of lines) {
      if (line.trim() !== "") last = line;
    }

    if (last === "") return undefined;
    const parsed = parseJsonObject(last);

    return parsed === null ? undefined : recordFrom(parsed);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
