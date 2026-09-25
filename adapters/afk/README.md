# claude-jev AFK Plugin

Jev judgment hooks for [agent-afk](https://github.com/griffinwork40/agent-afk). Five hooks fire automatically on every session, prompt, edit, and turn end, enforcing your project rules through the Jev (TypeSafe System One) judgment API.

**Hooks are fences; MCP tools are lenses.** The Jev MCP server (`jev-mcp`) gives the agent tools it can call on demand. This plugin adds hooks the agent cannot skip or rationalize past. Use both: MCP for agent-initiated judgment, hooks for agent-proof guardrails.

## What it does

| Hook | Event | What it judges |
|------|-------|----------------|
| `session-start.ts` | `SessionStart` | Loads rules from instruction files and injects a structured digest into the session's first turn. No API call (pure file I/O). |
| `prompt-router.ts` | `UserPromptSubmit` | Classifies each prompt as chat / lookup / fix / feature / ops and injects a routing hint when confidence >= 0.75. |
| `subagent-router.ts` | `PreToolUse` (Agent) | Recommends a model tier for the delegated task. Advisory only (AFK does not support `updatedInput`). |
| `rules.ts` | `PostToolUse` (edits) | Loads rules from instruction files, classifies them, and judges each edit hunk. **Blocks at >= 0.80** (agent cannot override). Flags 0.50-0.80 as advisory context. |
| `stop-sweep.ts` | `Stop` | Judges the session's accumulated edits against turn-scope rules (scope creep, cross-file patterns). |

All five fail open: any error, missing key, or timeout produces no output and never blocks a prompt.

## Install

### As an AFK plugin (recommended)

```bash
# Copy into AFK's plugin directory
cp -r adapters/afk ~/.afk/plugins/claude-jev

# Or symlink for development
ln -s "$(pwd)/adapters/afk" ~/.afk/plugins/claude-jev
```

AFK discovers the plugin automatically on next session start. Hooks wire from `hooks/hooks.json`; no manual config needed.

### Manual hook wiring

Copy the contents of `hooks/hooks.json` into your AFK hooks configuration if you prefer not to use the plugin system.

## Setup

### 1. API key

```sh
export TYPESAFE_API_KEY=your-key-here
# or
export OPENROUTER_API_KEY=sk-or-...
```

`TYPESAFE_API_KEY` is checked first. The SessionStart hook (rule digest) requires no API key.

### 2. Build

```sh
cd adapters/afk
npm install
npm run build
```

### 3. Verify

```sh
# SessionStart hook (no API key needed)
echo '{"session_id":"test","cwd":"'$(pwd)'"}' | node dist/session-start.js

# Prompt router (needs API key)
echo '{"prompt":"list files in this directory","session_id":"test"}' | node dist/prompt-router.js
```

## Rule sources

Rules are loaded from (in order):

1. `{cwd}/CLAUDE.md`, `{cwd}/AGENTS.md`
2. `{cwd}/AFK.md`
3. `{cwd}/.claude/rules/*.md`, `{cwd}/.claude/rules/*.mdc`
4. `{cwd}/.cursor/rules/*.md`, `{cwd}/.cursor/rules/*.mdc`
5. Nested `CLAUDE.md` / `AGENTS.md` in subdirectories (max depth 4)
6. `~/.claude/CLAUDE.md` (global)

Rule classification verdicts are cached at `~/.afk/jev-rule-cache.json` by SHA-256.

## How blocking works

When `rules.ts` judges an edit against a rule at >= 0.80 probability of violation, it exits with code 2, which AFK interprets as a hard block. The agent sees an error result with the rule text and must fix the edit before continuing. The agent cannot skip or dismiss this.

Each rule is allowed to block the same file at most twice per session. After that, the rule downgrades to a flag to prevent unlandable repair loops.

Edits in the 0.50-0.80 range are surfaced as advisory context: the agent sees the uncertain match and can address it before marking Done, but is not blocked.

## Known gaps

- **Advisory-only subagent routing**: AFK does not support `updatedInput`, so model tier recommendations surface as context text, not actual model switches.
- **No transcript access**: Hooks receive only the current event, not the conversation. The prompt router uses the prompt alone (the Python adapter also uses the previous turn).
- **No compaction hook**: AFK CLI hooks do not expose the transcript access needed for Jev-scored compaction.

## File structure

```
adapters/afk/
  .claude-plugin/
    plugin.json        # AFK plugin manifest
  hooks/
    hooks.json         # Hook registration (5 hooks)
  src/
    shared/
      jev-client.ts    # HTTP client for Jev API
      stdin.ts         # Read + parse stdin JSON
      stdout.ts        # Write hook output JSON
      questions.ts     # Question bundle definitions
      rule-parser.ts   # Parse, classify, and cache rules
      utils.ts         # Shared utilities
      state.ts         # Session state helpers
    session-start.ts   # SessionStart: rule digest injection
    prompt-router.ts   # UserPromptSubmit: routing hint
    subagent-router.ts # PreToolUse(Agent): model tier
    rules.ts           # PostToolUse(edit): rule enforcement
    stop-sweep.ts      # Stop: turn-level compliance
  dist/                # Compiled JS (npm run build)
```

## Runtime requirements

- Node.js 18+
- `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` (except SessionStart, which needs no key)
