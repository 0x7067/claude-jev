import { readFileSync } from "node:fs";

export type EnvSource = "env" | "dotenv";

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function fromFile(path: string, name: string): string | undefined {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(trimmed);

    if (match?.[1] !== name) continue;
    const raw = match[2] ?? "";
    const value = raw.trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));

    const stored = quoted ? value.slice(1, -1) : value;

    if (stored !== "") return stored;
  }

  return undefined;
}

export function readEnv(name: string, dotEnvPath?: string): { value: string; source: EnvSource } | undefined {
  const direct = process.env[name]?.trim();

  if (direct) return { value: direct, source: "env" };
  const saved = dotEnvPath === undefined ? undefined : fromFile(dotEnvPath, name);

  return saved ? { value: saved, source: "dotenv" } : undefined;
}

export function envValue(name: string, dotEnvPath?: string): string | undefined {
  return readEnv(name, dotEnvPath)?.value;
}
