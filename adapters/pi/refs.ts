import { isJsonObject, isString } from "../afk/src/shared/json.ts";

export type ScanValue =
  | string
  | number
  | boolean
  | null
  | readonly ScanValue[]
  | { readonly [key: string]: ScanValue };

export type LocationKind = "file" | "url" | "pattern";

export interface Location {
  kind: LocationKind;
  value: string;
}

const LOCATION_KEYS =
  /^(path|file|filepath|file_path|filename|file_name|target|dest|destination|source|src|dir|directory|folder|location)$/i;

const URL_KEYS = /^(url|uri|href|endpoint)$/i;

const PATTERN_KEYS = /^(pattern|glob|glob_pattern|query|regex|selector)$/i;

const URL_VALUE = /https?:\/\/[^\s'"`<>()[\]{},;|]+/g;

const ABSOLUTE_PATH = /(?:\/[^\s'"`<>()[\]{},;|*?]+)+/g;

const RELATIVE_PATH = /\b[\w.@+-]+(?:\/[\w.@+-]+)*\/[\w.@+-]+\.[A-Za-z0-9]{1,12}\b/g;

const MAX_SCAN_DEPTH = 6;

const MAX_LOCATIONS = 24;

const MAX_FREE_TEXT = 20_000;

function isJsonValueArray(value: ScanValue): value is readonly ScanValue[] {
  return Array.isArray(value);
}

function plausible(value: string): boolean {
  if (value.length < 3 || value.length > 400) return false;

  if (/\s/.test(value)) return false;

  if (/[*,;|<>]$/.test(value)) return false;

  return true;
}

function add(into: Map<string, Location>, kind: LocationKind, value: string): void {
  if (into.size >= MAX_LOCATIONS) return;

  if (!plausible(value)) return;
  const key = `${kind}:${value}`;

  if (!into.has(key)) into.set(key, { kind, value });
}

function fromFreeText(text: string, into: Map<string, Location>): void {
  if (text.length > MAX_FREE_TEXT) return;
  const urls = text.match(URL_VALUE) ?? [];

  for (const url of urls) add(into, "url", url.replace(/[.,;)]+$/, ""));
  const withoutUrls = text.replace(URL_VALUE, " ");

  for (const match of withoutUrls.match(ABSOLUTE_PATH) ?? []) add(into, "file", match.replace(/[.,;:)]+$/, ""));

  for (const match of withoutUrls.match(RELATIVE_PATH) ?? []) add(into, "file", match);
}

function walk(value: ScanValue, key: string | undefined, depth: number, into: Map<string, Location>): void {
  if (depth > MAX_SCAN_DEPTH || into.size >= MAX_LOCATIONS) return;

  if (isString(value)) {
    if (key !== undefined && URL_KEYS.test(key) && value.startsWith("http")) add(into, "url", value);
    else if (key !== undefined && PATTERN_KEYS.test(key)) add(into, "pattern", value);
    else if (key !== undefined && LOCATION_KEYS.test(key)) add(into, "file", value);
    else fromFreeText(value, into);

    return;
  }

  if (isJsonValueArray(value)) {
    for (const item of value) walk(item, key, depth + 1, into);

    return;
  }

  if (isJsonObject(value)) {
    for (const [name, child] of Object.entries(value)) walk(child, name, depth + 1, into);
  }
}

export function locations(args: ScanValue): Location[] {
  const into = new Map<string, Location>();

  walk(args, undefined, 0, into);

  return [...into.values()];
}
