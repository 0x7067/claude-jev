# Using Jev with OpenCode

[OpenCode](https://opencode.ai) is a free, open-source AI coding agent with first-class MCP support. These instructions install the third-party [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) MCP server — a separate project from this Claude Code plugin — so that OpenCode sessions can call Jev's typed judgment tools.

## Prerequisites

- [OpenCode](https://opencode.ai/docs/) installed (`brew install anomalyco/tap/opencode` or `npm install -g opencode-ai`)
- A Jev API key from [console.typesafe.ai](https://console.typesafe.ai/) (TypeSafe keys, `ts_...` / `apikey_...` prefix) or purchased at [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted keys, `jv_live_...` prefix, prepaid credit required). The browser playground at jevtypesafeai.com is free; the API is not.

## Credential routing

The MCP server auto-routes requests based on key prefix:

| Key prefix | Source | Endpoint |
|---|---|---|
| `jv_live_...` | [jevtypesafeai.com/pricing](https://jevtypesafeai.com/pricing) (hosted gateway, not affiliated with TypeSafe AI) | `https://jevtypesafeai.com/api/v1/decide` |
| `ts_...` / `apikey_...` | [console.typesafe.ai](https://console.typesafe.ai/) (official TypeSafe API) | `https://api.typesafe.ai/v1/systemone` |

These key types are not interchangeable. Use one or the other.

## Setup

Export your key, then add the Jev MCP server to your OpenCode config. This works in either a project-level `opencode.json` or your global config at `~/.config/opencode/opencode.json`:

```bash
export TYPESAFE_API_KEY=ts_your_key_here
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "github:codaaiteam/jev-mcp#6cfb78daa00d"],
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

OpenCode prefixes each MCP tool with the server's key from `opencode.json`. With the key `jev` above, the tools appear as:

| Tool in OpenCode | What it does |
|---|---|
| `jev_jev_classify` | Pick one of your labelled options (routing, categorization, intent) |
| `jev_jev_score` | Rate input on an ordered scale you define (risk, urgency, quality) |
| `jev_jev_check` | Calibrated yes/no probability (gates, filters, guardrails) |
| `jev_jev_gate` | Risk-screen an action before it runs (allow / confirm / block) |
| `jev_jev_decide` | Multiple typed questions in one round trip |

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

If you run multiple agents and only want one to use Jev, disable it globally and enable it per-agent:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "github:codaaiteam/jev-mcp#6cfb78daa00d"],
      "enabled": true,
      "environment": {
        "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}"
      }
    }
  },
  "tools": {
    "jev*": false
  },
  "agent": {
    "reviewer": {
      "tools": {
        "jev*": true
      }
    }
  }
}
```

The `jev*` globs match the prefixed names (`jev_jev_classify`, etc.).

## Links

- [OpenCode docs](https://opencode.ai/docs/)
- [OpenCode MCP server docs](https://opencode.ai/docs/mcp-servers/)
- [codaaiteam/jev-mcp](https://github.com/codaaiteam/jev-mcp) (third-party MCP server)
- [TypeSafe docs](https://docs.typesafe.ai/introduction)
