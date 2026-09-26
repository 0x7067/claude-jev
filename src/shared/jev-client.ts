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
export type ChoiceAnswer = { choice: string; confidence: number };
export type ScoreAnswer = { score: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;

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

function resolveKey(): { key: string; provider: Provider } {
  for (const p of PROVIDERS) {
    const k = (process.env[p.keyVar] ?? "").trim();
    if (k) return { key: k, provider: providerFor(k) };
  }
  throw new Error("No Jev API key found. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.");
}

export async function jevAsk(
  state: string,
  questions: Questions,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Answers> {
  const { key, provider } = resolveKey();
  const url = process.env["JEV_BASE_URL"] ?? provider.url;

  const body = JSON.stringify({
    state,
    model: DEFAULT_MODEL,
    questions,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await res.json()) as { answers?: Answers };
    return payload.answers ?? {};
  } finally {
    clearTimeout(timer);
  }
}
