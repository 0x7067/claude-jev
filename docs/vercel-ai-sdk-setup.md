# Using Jev with the Vercel AI SDK

The [Vercel AI SDK](https://sdk.vercel.ai/) is a free, open-source TypeScript toolkit for building AI apps (Apache-2.0, no Vercel account required). Its `@ai-sdk/mcp` package connects to MCP servers, so you can add Jev as a decision engine alongside your LLM of choice.

These instructions install the third-party [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) MCP server — a separate project from this Claude Code plugin.

## Prerequisites

- Node.js 22+
- A Jev API key from [console.typesafe.ai](https://console.typesafe.ai/) (TypeSafe keys, `ts_...` / `apikey_...` prefix) or purchased at [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted keys, `jv_live_...` prefix, prepaid credit required). The browser playground at jevtypesafeai.com is free; the API is not.
- An LLM provider key. The Anthropic samples below use `@ai-sdk/anthropic`, which reads `ANTHROPIC_API_KEY` from this process. That variable stays out of the MCP child `env`.

## Credential routing

The MCP process reads `TYPESAFE_API_KEY`, then `JEV_API_KEY`, then `JEV_KEY`. It does not read `OPENROUTER_API_KEY`.

`JEV_BASE_URL`, when set, is the endpoint. Otherwise only a key that starts with `jv_live_` goes to the hosted gateway; every other key goes to the TypeSafe API.

| Key | Endpoint when `JEV_BASE_URL` is unset |
|---|---|
| `jv_live_...` from [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted gateway, not affiliated with TypeSafe AI) | `https://jevtypesafeai.com/api/v1/decide` |
| any other key, including `ts_...` / `apikey_...` from [console.typesafe.ai](https://console.typesafe.ai/) | `https://api.typesafe.ai/v1/systemone` |

A hosted key and a TypeSafe key are not interchangeable. The samples pass `TYPESAFE_API_KEY`. The child `env` is explicit, so list `JEV_BASE_URL` there when you set an override (the snippets do).

## Install

```bash
npm install ai @ai-sdk/mcp zod
```

Plus your LLM provider, e.g.:

```bash
npm install @ai-sdk/anthropic    # or @ai-sdk/openai, @ai-sdk/groq, etc.
```

## Connect Jev via stdio

The AI SDK launches the Jev MCP server as a local process. The samples are ESM and use top-level `await`. Run a file with `npx tsx file.ts`, or set `"type": "module"` in `package.json`.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount } from "ai";

const jev = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "github:codaaiteam/jev-mcp#6cfb78daa00d405b76f8fee221b559cbb73563a8"],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY!,
      ...(process.env.JEV_BASE_URL
        ? { JEV_BASE_URL: process.env.JEV_BASE_URL }
        : {}),
      PATH: process.env.PATH!,
    },
  }),
});

try {
  const tools = await jev.tools();

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
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

`jev.tools()` with no `schemas` is automatic mode. Each `TypedToolResult.output` is the raw MCP `CallToolResult`, not a JSON string: on success `{ content: [{ type: "text", text: "<pretty JSON>" }] }`. Parse that text part. If `isError` is set, the text in the same place is a plain `jev-mcp error: …` string. `jev_check` JSON is `{ probability, likely }` (`likely` is `probability >= 0.5`). There is no `verdict` field.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { generateText, isStepCount } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const jev = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "github:codaaiteam/jev-mcp#6cfb78daa00d405b76f8fee221b559cbb73563a8"],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY!,
      ...(process.env.JEV_BASE_URL
        ? { JEV_BASE_URL: process.env.JEV_BASE_URL }
        : {}),
      PATH: process.env.PATH!,
    },
  }),
});

try {
  const tools = await jev.tools();

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    tools,
    stopWhen: isStepCount(3),
    prompt: `You have a user comment to moderate. Use jev_check to determine
      if it's safe to auto-publish, then report the result.
      Comment: "Great article, learned a lot about TypeScript generics!"`,
  });

  const checkResult = result.steps
    .flatMap(s => s.toolResults)
    .find(r => r.toolName === "jev_check");

  if (checkResult) {
    const call = checkResult.output as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = call.content?.find(part => part.type === "text")?.text;
    if (call.isError || text == null) {
      console.error(text ?? "jev_check returned no text");
    } else {
      const jevAnswer = JSON.parse(text) as {
        probability: number;
        likely: boolean;
      };
      console.log("probability:", jevAnswer.probability);
      console.log("likely:", jevAnswer.likely);
    }
  }

  console.log(result.text);
} finally {
  await jev.close();
}
```

## Example: request routing

A self-contained copy of the client: the `generateText` call and the parse sit inside this sample's `try`. `jev_classify` JSON, once the text part is parsed, has `choice`, `confidence`, and `probabilities`.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { generateText, isStepCount } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const jev = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "github:codaaiteam/jev-mcp#6cfb78daa00d405b76f8fee221b559cbb73563a8"],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY!,
      ...(process.env.JEV_BASE_URL
        ? { JEV_BASE_URL: process.env.JEV_BASE_URL }
        : {}),
      PATH: process.env.PATH!,
    },
  }),
});

try {
  const tools = await jev.tools();

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    tools,
    stopWhen: isStepCount(3),
    prompt: `Use jev_classify to route this request to the right team.
      Request: "Our API is returning 500 errors on the /payments endpoint"
      Options: { frontend: "UI/UX issues", backend: "API and server issues",
      infra: "Infrastructure and deployment", billing: "Payment and subscription" }`,
  });

  const classifyResult = result.steps
    .flatMap(s => s.toolResults)
    .find(r => r.toolName === "jev_classify");

  if (classifyResult) {
    const call = classifyResult.output as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = call.content?.find(part => part.type === "text")?.text;
    if (call.isError || text == null) {
      console.error(text ?? "jev_classify returned no text");
    } else {
      const decision = JSON.parse(text) as {
        choice: string;
        confidence: number;
        probabilities: Record<string, number>;
      };
      console.log("choice:", decision.choice);
      console.log("confidence:", decision.confidence);
      console.log("probabilities:", decision.probabilities);
    }
  }

  console.log(result.text);
} finally {
  await jev.close();
}
```

## Free LLM providers

The AI SDK works with many providers. Some free options to pair with Jev:

| Provider | Package | Free tier |
|---|---|---|
| [Groq](https://console.groq.com) | `@ai-sdk/groq` | Generous free tier, fast inference |
| [Google Gemini](https://ai.google.dev) | `@ai-sdk/google` | Free API keys available |
| [OpenRouter](https://openrouter.ai) | `@openrouter/ai-sdk-provider` | Many free models |
| [Ollama](https://ollama.ai) (local) | `ollama-ai-provider-v2` | Completely free, runs locally (peers `ai@^7`, Node 22) |

## Notes

- **This pin is stdio-only.** `6cfb78daa00d405b76f8fee221b559cbb73563a8` connects with `StdioServerTransport` and has no HTTP MCP entrypoint. Do not point an HTTP transport at it. `JEV_BASE_URL` overrides the Jev API that process calls.
- **Always close the client.** Use `try/finally` to avoid process leaks. `MCPClient` does not implement `Symbol.asyncDispose`, so `using` is not supported.
- **Read `output`, then the text part.** With automatic `jev.tools()`, `output` is `{ content: [{ type: "text", text }] }`. `JSON.parse` runs on `text` only after `isError` is absent. `jev_check` logs `probability` and `likely`.
- **ESM.** Top-level `await` needs `npx tsx file.ts` or `"type": "module"`. `@ai-sdk/anthropic` reads `ANTHROPIC_API_KEY` in the parent process.

## Links

- [Vercel AI SDK docs](https://sdk.vercel.ai/)
- [AI SDK MCP docs](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) (third-party MCP server)
- [TypeSafe docs](https://docs.typesafe.ai/introduction)
