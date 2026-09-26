export function asChoice(answer) {
    return answer && "choice" in answer ? answer : undefined;
}
export function asNoul(answer) {
    return answer && "noul" in answer ? answer : undefined;
}
export function asScore(answer) {
    return answer && "score" in answer ? answer : undefined;
}
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 8000;
const PROVIDERS = [
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
function providerFor(key) {
    let best = PROVIDERS[0];
    for (const p of PROVIDERS) {
        if (key.startsWith(p.keyPrefix) && p.keyPrefix.length >= best.keyPrefix.length) {
            best = p;
        }
    }
    return best;
}
function pinnedProvider() {
    const name = (process.env["CLAUDE_PLUGIN_OPTION_PROVIDER"] ?? "").trim();
    return PROVIDERS.find((p) => p.name === name);
}
function savedKey() {
    return (process.env["CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY"] ?? "").trim();
}
function resolveKey() {
    const pinned = pinnedProvider();
    for (const p of pinned ? [pinned] : PROVIDERS) {
        const k = (process.env[p.keyVar] ?? "").trim();
        if (k)
            return { key: k, provider: pinned ?? providerFor(k) };
    }
    const saved = savedKey();
    if (saved)
        return { key: saved, provider: pinned ?? providerFor(saved) };
    throw new Error("No Jev API key found. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.");
}
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
async function typedAsk(url, model, key, state, questions, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        const payload = (await res.json());
        return payload.answers ?? {};
    }
    finally {
        clearTimeout(timer);
    }
}
function systemoneBackend(model) {
    return {
        name: `systemone:${model}`,
        ask: (state, questions, timeoutMs) => {
            const { key, provider } = resolveKey();
            return typedAsk(process.env["JEV_BASE_URL"] ?? provider.url, model, key, state, questions, timeoutMs);
        },
    };
}
function decisionsBackend(model) {
    return {
        name: `decisions:${model}`,
        ask: (state, questions, timeoutMs) => {
            const key = (process.env["OPENROUTER_API_KEY"] ?? "").trim() || savedKey();
            if (!key)
                throw new Error("decisions backend needs OPENROUTER_API_KEY");
            return typedAsk(DECISIONS_URL, model, key, state, questions, timeoutMs);
        },
    };
}
const BACKENDS = new Map([
    ["systemone", systemoneBackend],
    ["decisions", decisionsBackend],
]);
export function resolveDecisionBackend(spec) {
    const at = spec.indexOf(":");
    const id = at === -1 ? "systemone" : spec.slice(0, at);
    const model = at === -1 ? spec : spec.slice(at + 1);
    const make = BACKENDS.get(id);
    if (make === undefined)
        throw new Error(`unknown decision backend: ${id}`);
    if (model === "")
        throw new Error(`empty decision model: ${spec}`);
    return make(model);
}
export const DEFAULT_BACKEND = systemoneBackend(DEFAULT_MODEL);
export async function jevAsk(state, questions, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return DEFAULT_BACKEND.ask(state, questions, timeoutMs);
}
//# sourceMappingURL=jev-client.js.map