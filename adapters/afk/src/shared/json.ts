export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Json = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function parseJsonObject(text: string): Json | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return isJsonObject(value) ? value : null;
}

export function parseJsonArray(text: string): unknown[] | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return isJsonArray(value) ? value : null;
}
