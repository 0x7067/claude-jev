import fs from "node:fs";
import path from "node:path";
import { callerName, configDir, pluginVersion } from "./config.ts";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { noul: number };

export type ChoiceAnswer = { choice: string; confidence: number; probabilities?: Record<string, number> };

export type ScoreAnswer = { score: number };

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Questions = Record<string, Question>;

export type Answers = Record<string, Answer>;

export function asChoice(answer: Answers[string] | undefined): ChoiceAnswer | undefined {
  return answer && "choice" in answer ? answer : undefined;
}

export function asNoul(answer: Answers[string] | undefined): NoulAnswer | undefined {
  return answer && "noul" in answer ? answer : undefined;
}

export function asScore(answer: Answers[string] | undefined): ScoreAnswer | undefined {
  return answer && "score" in answer ? answer : undefined;
}

const DEFAULT_MODEL = "jev-latest";

const DEFAULT_TIMEOUT_MS = 8000;

interface Provider {
  name: string;
  url: string;
  keyPrefix: string;
  keyVar: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "typesafe",
    url: "https://api.typesafe.ai/v1/systemone",
    keyPrefix: "",
    keyVar: "TYPESAFE_API_KEY",
  },
  {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/systemone",
    keyPrefix: "sk-or-",
    keyVar: "OPENROUTER_API_KEY",
  },
];

function providerFor(key: string): Provider {
  let best: Provider = PROVIDERS[0]!;

  for (const p of PROVIDERS) {
    if (key.startsWith(p.keyPrefix) && p.keyPrefix.length >= best.keyPrefix.length) {
      best = p;
    }
  }

  return best;
}

function pinnedProvider(): Provider | undefined {
  const name = (process.env["CLAUDE_PLUGIN_OPTION_PROVIDER"] ?? "").trim();

  return PROVIDERS.find((p) => p.name === name);
}

function savedKey(): string {
  return (process.env["CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY"] ?? "").trim();
}

interface ResolvedKey {
  key: string;
  provider: Provider;
}

function resolveKey(): ResolvedKey {
  const pinned = pinnedProvider();

  for (const p of pinned ? [pinned] : PROVIDERS) {
    const k = (process.env[p.keyVar] ?? "").trim();

    if (k) return { key: k, provider: pinned ?? providerFor(k) };
  }

  const saved = savedKey();

  if (saved) return { key: saved, provider: pinned ?? providerFor(saved) };

  throw new Error("No Jev API key found. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.");
}


export interface DecisionBackend {
  readonly name: string;
  ask(state: string, questions: Questions, timeoutMs: number): Promise<Answers>;
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

async function typedAsk(
  url: string,
  providerName: string,
  model: string,
  key: string,
  state: string,
  questions: Questions,
  timeoutMs: number
): Promise<Answers> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    // SAFETY: the SystemOne and decisions answers endpoints return { answers } per the API contract.
    const payload = (await res.json()) as { answers?: Answers };

    if (!payload.answers || Object.keys(payload.answers).length === 0) {
      throw new Error("backend returned no answers");
    }

    logCall(providerName, model, Object.keys(questions).length, Date.now() - started, null);

    return payload.answers;
  } catch (e) {
    logCall(providerName, model, Object.keys(questions).length, Date.now() - started, String(e));

    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function logCall(provider: string, model: string, n: number, ms: number, error: string | null): void {
  try {
    const dir = configDir();

    fs.mkdirSync(dir, { recursive: true });

    const rec = {
      ts: new Date().toISOString(),
      caller: callerName(),
      n_questions: n,
      provider,
      model,
      ms,
      ok: error === null,
      v: pluginVersion(),
      error: error?.slice(0, 300),
    };

    fs.appendFileSync(path.join(dir, "jev-calls.jsonl"), JSON.stringify(rec) + "\n");
  } catch {
  }
}

function systemoneBackend(model: string): DecisionBackend {
  return {
    name: `systemone:${model}`,
    ask: (state, questions, timeoutMs) => {
      const { key, provider } = resolveKey();

      return typedAsk(
        process.env["JEV_BASE_URL"] ?? provider.url,
        provider.name,
        model,
        key,
        state,
        questions,
        timeoutMs
      );
    },
  };
}

function decisionsBackend(model: string): DecisionBackend {
  return {
    name: `decisions:${model}`,
    ask: (state, questions, timeoutMs) => {
      const key =
        (process.env["OPENROUTER_API_KEY"] ?? "").trim() || savedKey();

      if (!key) throw new Error("decisions backend needs OPENROUTER_API_KEY");

      return typedAsk(DECISIONS_URL, "openrouter", model, key, state, questions, timeoutMs);
    },
  };
}

const BACKENDS = new Map<string, (model: string) => DecisionBackend>([
  ["systemone", systemoneBackend],
  ["decisions", decisionsBackend],
]);

export function resolveDecisionBackend(spec: string): DecisionBackend {
  const at = spec.indexOf(":");
  const id = at === -1 ? "systemone" : spec.slice(0, at);
  const model = at === -1 ? spec : spec.slice(at + 1);
  const make = BACKENDS.get(id);

  if (make === undefined) throw new Error(`unknown decision backend: ${id}`);

  if (model === "") throw new Error(`empty decision model: ${spec}`);

  return make(model);
}

export const DEFAULT_BACKEND: DecisionBackend = systemoneBackend(DEFAULT_MODEL);

export async function jevAsk(
  state: string,
  questions: Questions,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Answers> {
  return DEFAULT_BACKEND.ask(state, questions, timeoutMs);
}
