# Using Jev with OpenCode

[OpenCode](https://opencode.ai) is a free, open-source AI coding agent with first-class MCP support. These instructions install the third-party [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) MCP server — a separate project from this Claude Code plugin — so that OpenCode sessions can call Jev's typed judgment tools.

## Prerequisites

- [OpenCode](https://opencode.ai/docs/) installed (`brew install anomalyco/tap/opencode` or `npm install -g opencode-ai`)
- Node.js `>=18` on `PATH`. The config below starts jev-mcp with `npx`, and a Homebrew-only OpenCode install does not provide `npx`.
- A Jev API key. A hosted key from [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) starts with `jv_live_` and needs prepaid credit (the browser playground is free; the API is not). Any other key, including one from [console.typesafe.ai](https://console.typesafe.ai/), goes to TypeSafe unless `JEV_BASE_URL` is set. See [Credential routing](#credential-routing).

## Credential routing

Pinned at `6cfb78daa00d405b76f8fee221b559cbb73563a8`, jev-mcp reads the key from `TYPESAFE_API_KEY`, or from the aliases `JEV_API_KEY` and `JEV_KEY`. It does not read `OPENROUTER_API_KEY`. This Claude Code plugin's OpenRouter path — `OPENROUTER_API_KEY`, or an `sk-or-` value in `TYPESAFE_API_KEY` sent to `https://openrouter.ai/api/v1/systemone` — is a different credential story and does not apply to this server.

An explicit `JEV_BASE_URL` always wins. With it unset, the server special-cases one prefix:

| Key in `TYPESAFE_API_KEY` (or `JEV_API_KEY` / `JEV_KEY`) | Endpoint |
|---|---|
| Starts with `jv_live_` | `https://jevtypesafeai.com/api/v1/decide` (hosted gateway at [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing), not affiliated with TypeSafe AI) |
| Anything else, including an `sk-or-` OpenRouter key placed in `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` |

A hosted `jv_live_` key is valid only at the jevtypesafeai.com gateway.

## Setup

Add the Jev MCP server in either a project-level `opencode.json` or your global config at `~/.config/opencode/opencode.json`.

`{env:TYPESAFE_API_KEY}` is safe to commit: it is a substitution, not the secret. OpenCode substitutes it from the environment of the OpenCode process itself — the OS or user environment, launchd or systemd, or a shell profile the desktop app inherits. The `export` below applies only to a CLI session started from that shell. An unset variable becomes an empty string.

```bash
export TYPESAFE_API_KEY=your_key_here
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "github:codaaiteam/jev-mcp#6cfb78daa00d405b76f8fee221b559cbb73563a8"],
      "enabled": true,
      "environment": {
        "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}"
      }
    }
  }
}
```

OpenCode discovers the tools automatically on next launch.

## Available tools

OpenCode prefixes each MCP tool with the server's key from `opencode.json`. With the key `jev` above, the native registered names are:

| Tool in OpenCode | What it does |
|---|---|
| `jev_jev_classify` | Pick one of your labelled options (routing, categorization, intent) |
| `jev_jev_score` | Rate input on an ordered scale you define (risk, urgency, quality) |
| `jev_jev_check` | Calibrated yes/no probability (gates, filters, guardrails) |
| `jev_jev_gate` | Risk-screen an action before it runs (allow / confirm / block) |
| `jev_jev_decide` | Multiple typed questions in one round trip |

OpenCode 2 nests MCP servers under `mcp.servers` and uses different field names than these examples; per-server Code Mode is an OpenCode 2 setting, and the Prerequisites install does not enable it by default.

## Usage tips

Mention Jev in your prompts to get OpenCode to use it:

```
Before running that deploy script, use jev to check if it's safe.
```

Or add a rule to your project's `AGENTS.md`:

```
Use `jev` tools to classify prompts, score risk, and gate dangerous actions.
```

### Restrict to a specific agent

If you run multiple agents and only want one to use Jev, deny it globally and allow it on a built-in agent. Prefer `permission` over the deprecated `tools` map. This keeps Jev on the built-in `build` agent and off the others. The `jev*` patterns match the native names above.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "github:codaaiteam/jev-mcp#6cfb78daa00d405b76f8fee221b559cbb73563a8"],
      "enabled": true,
      "environment": {
        "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}"
      }
    }
  },
  "permission": {
    "jev*": "deny"
  },
  "agent": {
    "build": {
      "permission": {
        "jev*": "allow"
      }
    }
  }
}
```

## Links

- [OpenCode docs](https://opencode.ai/docs/)
- [OpenCode MCP server docs](https://opencode.ai/docs/mcp-servers/)
- [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) (third-party MCP server)
- [TypeSafe docs](https://docs.typesafe.ai/introduction)
