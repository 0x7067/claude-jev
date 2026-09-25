# Using Jev with the Vercel AI SDK

The [Vercel AI SDK](https://sdk.vercel.ai/) is a free, open-source TypeScript toolkit for building AI apps (Apache-2.0, no Vercel account required). Its `@ai-sdk/mcp` package connects to MCP servers, so you can add Jev as a decision engine alongside your LLM of choice.

These instructions install the third-party [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) MCP server — a separate project from this Claude Code plugin.

## Prerequisites

- Node.js 22+
- A Jev API key from [console.typesafe.ai](https://console.typesafe.ai/) (TypeSafe keys, `ts_...` / `apikey_...` prefix) or purchased at [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted keys, `jv_live_...` prefix, prepaid credit required). The browser playground at jevtypesafeai.com is free; the API is not.
- An LLM provider key (Anthropic, OpenAI, Groq, Google, or any AI SDK provider)

## Credential routing

The MCP server auto-routes requests based on key prefix:

| Key prefix | Source | Endpoint |
|---|---|---|
| `jv_live_...` | [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted gateway, not affiliated with TypeSafe AI) | `https://jevtypesafeai.com/api/v1/decide` |
| `ts_...` / `apikey_...` | [console.typesafe.ai](https://console.typesafe.ai/) (official TypeSafe API) | `https://api.typesafe.ai/v1/systemone` |

These key types are not interchangeable. Use one or the other.

## Install

```bash
npm install ai @ai-sdk/mcp
```

Plus your LLM provider, e.g.:

```bash
npm install @ai-sdk/anthropic    # or @ai-sdk/openai, @ai-sdk/groq, etc.
```

## Connect Jev via stdio

The AI SDK launches the Jev MCP server as a local process.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount } from "ai";

const jev = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "github:codaaiteam/jev-mcp#6cfb78daa00d"],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY!,
      PATH: process.env.PATH!,
    },
  }),
});

try {
  const tools = await jev.tools();

  const result = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    tools,
    stopWhen: isStepCount(5),
    prompt: "Classify this request: 'refactor the auth module to support SAML'",
  });

  console.log(result.text);
} finally {
  await jev.close();
}
```

## Available tools

| Tool | What it does |
|---|---|
| `jev_classify` | Pick one of your labelled options (routing, categorization, intent) |
| `jev_score` | Rate input on an ordered scale you define (risk, urgency, quality) |
| `jev_check` | Calibrated yes/no probability (gates, filters, guardrails) |
| `jev_gate` | Risk-screen an action before it runs (allow / confirm / block) |
| `jev_decide` | Multiple typed questions in one round trip |

## Example: content moderation gate

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { generateText, isStepCount } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const jev = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "github:codaaiteam/jev-mcp#6cfb78daa00d"],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY!,
      PATH: process.env.PATH!,
    },
  }),
});

try {
  const tools = await jev.tools();

  const result = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    tools,
    stopWhen: isStepCount(3),
    prompt: `You have a user comment to moderate. Use jev_check to determine
      if it's safe to auto-publish, then report the result.
      Comment: "Great article, learned a lot about TypeScript generics!"`,
  });

  // The LLM calls jev_check and reports its finding in result.text.
  // To access the raw Jev probability, extract it from the tool result:
  const checkResult = result.steps
    .flatMap(s => s.toolResults)
    .find(r => r.toolName === "jev_check");

  if (checkResult) {
    const jevAnswer = JSON.parse(checkResult.result as string);
    console.log("probability:", jevAnswer.probability);
    console.log("verdict:", jevAnswer.verdict);
  }

  console.log(result.text);
} finally {
  await jev.close();
}
```

## Example: request routing

This continues from the setup example above (assumes `jev` and `tools` are in scope).

```typescript
const result = await generateText({
  model: anthropic("claude-sonnet-4-20250514"),
  tools,
  stopWhen: isStepCount(3),
  prompt: `Use jev_classify to route this request to the right team.
    Request: "Our API is returning 500 errors on the /payments endpoint"
    Options: { frontend: "UI/UX issues", backend: "API and server issues",
    infra: "Infrastructure and deployment", billing: "Payment and subscription" }`,
});

// Extract the jev_classify result from tool call steps
const classifyResult = result.steps
  .flatMap(s => s.toolResults)
  .find(r => r.toolName === "jev_classify");

if (classifyResult) {
  const decision = JSON.parse(classifyResult.result as string);
  console.log("choice:", decision.choice);
  console.log("confidence:", decision.confidence);
  console.log("probabilities:", decision.probabilities);
}
```

## Free LLM providers

The AI SDK works with many providers. Some free options to pair with Jev:

| Provider | Package | Free tier |
|---|---|---|
| [Groq](https://console.groq.com) | `@ai-sdk/groq` | Generous free tier, fast inference |
| [Google Gemini](https://ai.google.dev) | `@ai-sdk/google` | Free API keys available |
| [OpenRouter](https://openrouter.ai) | `@openrouter/ai-sdk-provider` | Many free models |
| [Ollama](https://ollama.ai) (local) | `ollama-ai-provider` | Completely free, runs locally |

## Notes

- **stdio is local-only.** For deployed apps, run the MCP server as an HTTP endpoint and use the HTTP transport instead.
- **Always close the client.** Use `try/finally` to avoid process leaks. `MCPClient` does not implement `Symbol.asyncDispose`, so `using` is not supported.
- **Tool results are JSON strings.** The MCP server serializes Jev answers as JSON text in the tool result. Parse them to access typed fields (choice, probability, confidence, probabilities).

## Links

- [Vercel AI SDK docs](https://sdk.vercel.ai/)
- [AI SDK MCP docs](https://sdk.vercel.ai/docs/ai-sdk-core/mcp-clients)
- [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) (third-party MCP server)
- [TypeSafe docs](https://docs.typesafe.ai/introduction)
