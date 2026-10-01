import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  PROVIDERS,
  type Answers,
  type Provider,
  type Questions,
} from "../afk/src/shared/jev-client.ts";
import { isJsonObject, isNumber, isString, parseJsonObject, type JsonValue } from "../afk/src/shared/json.ts";
import { envValue, readEnv, type EnvSource } from "./env.ts";
import { appendLine, lastRecord, type LogRecord } from "./log.ts";

export { DEFAULT_MODEL, PROVIDERS };

export type { Provider };

export class JevError extends Error {}

export interface JevFiles {
  dotEnv?: string;
  callLog?: string;
}

export interface AskCall extends JevFiles {
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  caller?: string;
}

export interface Resolved {
  source: EnvSource | "missing";
  key: string;
  provider: Provider | undefined;
}

export interface Status {
  version: string;
  key: EnvSource | "missing";
  provider: string | undefined;
  pinned: string;
  lastCall: LogRecord | undefined;
}

interface CallLogRecord {
  ts: string;
  caller: string;
  n_questions: number;
  provider: string;
  model: string;
  ms: number;
  ok: boolean;
  v: string;
  error?: string;
}

const FAST_FAIL_MS = 1_000;

let cachedVersion: string | undefined;

export function version(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const parsed = parseJsonObject(readFileSync(join(root, "plugin.json"), "utf8"));
    const found = parsed?.["version"];

    cachedVersion = isString(found) ? found : "unknown";
  } catch {
    cachedVersion = "unknown";
  }

  return cachedVersion;
}

export function providerFor(key: string): Provider {
  let best: Provider = PROVIDERS[0]!;

  for (const provider of PROVIDERS) {
    if (key.startsWith(provider.keyPrefix) && provider.keyPrefix.length >= best.keyPrefix.length) {
      best = provider;
    }
  }

  return best;
}

export function pinnedProvider(dotEnvPath?: string): Provider | undefined {
  const name = envValue("JEV_PROVIDER", dotEnvPath);

  return PROVIDERS.find((provider) => provider.name === name);
}

export function resolve(files: JevFiles = {}): Resolved {
  const pinned = pinnedProvider(files.dotEnv);
  const candidates = pinned ? [pinned] : PROVIDERS;

  for (const provider of candidates) {
    const direct = process.env[provider.keyVar]?.trim();

    if (direct) return { source: "env", key: direct, provider: pinned ?? providerFor(direct) };
  }

  for (const provider of candidates) {
    const found = readEnv(provider.keyVar, files.dotEnv);

    if (found?.source === "dotenv") {
      return { source: "dotenv", key: found.value, provider: pinned ?? providerFor(found.value) };
    }
  }

  return { source: "missing", key: "", provider: pinned };
}

export function missingKeyMessage(provider: Provider | undefined): string {
  const names = provider ? [provider.keyVar] : PROVIDERS.map((item) => item.keyVar);

  return `set ${names.join(" or ")}`;
}

function readAnswer(value: JsonValue): Answers[string] | undefined {
  if (!isJsonObject(value)) return undefined;

  if (isNumber(value["noul"])) return { noul: value["noul"] };

  if (isString(value["choice"]) && isNumber(value["confidence"])) {
    return { choice: value["choice"], confidence: value["confidence"] };
  }

  if (isNumber(value["score"])) return { score: value["score"] };

  return undefined;
}

function readAnswers(value: JsonValue | undefined): Answers {
  if (!isJsonObject(value)) return {};
  const answers: Answers = {};

  for (const [key, item] of Object.entries(value)) {
    const answer = readAnswer(item);

    if (answer !== undefined) answers[key] = answer;
  }

  return answers;
}

function logCall(
  callLog: string | undefined,
  provider: Provider,
  model: string,
  questions: number,
  started: number,
  error: string | undefined,
  caller: string
): void {
  if (callLog === undefined) return;

  const record: CallLogRecord = {
    ts: new Date().toISOString(),
    caller,
    n_questions: questions,
    provider: provider.name,
    model,
    ms: Math.round(performance.now() - started),
    ok: error === undefined,
    v: version(),
  };

  if (error !== undefined) record.error = error.slice(0, 300);
  appendLine(callLog, JSON.stringify(record));
}

export async function ask(state: string, questions: Questions, options: AskCall = {}): Promise<Answers> {
  const { key, provider, source } = resolve(options);

  if (source === "missing" || provider === undefined) throw new JevError(missingKeyMessage(provider));
  const model = options.model ?? envValue("JEV_MODEL", options.dotEnv) ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caller = options.caller ?? "compaction";
  const body = JSON.stringify({ state, model, questions });
  const count = Object.keys(questions).length;

  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    let response: Response;

    try {
      response = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);

      logCall(options.callLog, provider, model, count, started, text, caller);

      if (attempt === 1 && options.signal?.aborted !== true && performance.now() - started < FAST_FAIL_MS) {
        continue;
      }

      throw new JevError(text);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);

      logCall(options.callLog, provider, model, count, started, `HTTP ${response.status}: ${detail}`, caller);
      throw new JevError(`HTTP ${response.status}: ${detail}`);
    }

    const payload = parseJsonObject(await response.text().catch(() => ""));

    logCall(options.callLog, provider, model, count, started, undefined, caller);

    return readAnswers(payload?.["answers"]);
  }
}

export function status(files: JevFiles = {}): Status {
  const { source, provider } = resolve(files);

  return {
    version: version(),
    key: source,
    provider: provider?.name,
    pinned: envValue("JEV_PROVIDER", files.dotEnv) ?? "auto",
    lastCall: files.callLog === undefined ? undefined : lastRecord(files.callLog),
  };
}
