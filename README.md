# claude-jev AFK Plugin

Jev judgment hooks for [agent-afk](https://github.com/griffinwork40/agent-afk). Five hooks fire automatically on every session, prompt, edit, and turn end, enforcing your project rules through the Jev (TypeSafe System One) judgment API.

**Hooks are fences; MCP tools are lenses.** The Jev MCP server (`jev-mcp`) gives the agent tools it can call on demand. This plugin adds hooks the agent cannot skip or rationalize past. Use both: MCP for agent-initiated judgment, hooks for agent-proof guardrails.

## What it does

| Hook | Event | What it judges |
|------|-------|----------------|
| `session-start.ts` | `SessionStart` | Loads rules from instruction files and injects a structured digest into the session's first turn. No API call (pure file I/O). |
| `prompt-router.ts` | `UserPromptSubmit` | Classifies each prompt as chat / lookup / fix / feature / ops and injects a routing hint when confidence >= 0.75. |
| `subagent-router.ts` | `PreToolUse` (`agent`) | Recommends a model tier when the spawn names no `agent_type`, and flags a brief that changes files but leaves out paths, acceptance criteria, verification, or commit policy. Advisory only. |
| `rules.ts` | `PostToolUse` (edits) | Loads rules from instruction files, classifies them, and judges each edit hunk. **Blocks at >= 0.80** (agent cannot override). Flags 0.50-0.80 as advisory context. |
| `stop-sweep.ts` | `Stop` | Judges the session's accumulated edits against turn-scope rules (scope creep, cross-file patterns). |

All five fail open: any error, missing key, or timeout produces no output and never blocks a prompt.

## Install

### From GitHub (recommended)

The `afk` branch of `0x7067/claude-jev` holds this directory at its root, refreshed on every release. agent-afk 5.257.3 fails to install a branch by name (`'--detach' cannot be used with '-b'`), so install its current commit, then follow the branch on update:

```bash
afk plugin install 0x7067/claude-jev claude-jev --ref "$(git ls-remote https://github.com/0x7067/claude-jev.git refs/heads/afk | cut -f1)" -y
afk plugin update claude-jev --ref afk
```

Always update with `--ref afk`. A bare `afk plugin update` checks out the newest version tag in the repository, and those tags are the Claude Code plugin, not this one.

### From a checkout

```bash
afk plugin install "$(pwd)/adapters/afk" claude-jev
```

This symlinks the directory, so it follows whatever the checkout has.

AFK discovers the plugin on the next session start and wires hooks from `hooks/hooks.json`. AFK runs plugin hooks only when `~/.afk/config/afk.config.json` sets `"enablePluginHooks": true`.

Use agent-afk 5.257.3 or later. On 5.244.0, a session with all five hooks loaded exits right after "Initializing agent..." without calling the model.

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

AFK starts hook commands with a reduced environment: `PATH`, `HOME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `USER`, `LOGNAME`, non-secret `AFK_*` variables, and `CLAUDE_PLUGIN_ROOT`. A key exported in your shell does not reach the hooks. Store it in AFK's env file instead, which the hooks read when AFK runs them:

```sh
afk config env set OPENROUTER_API_KEY
# or
afk config env set TYPESAFE_API_KEY
```

The hooks look for `$AFK_HOME/config/afk.env`, or `~/.afk/config/afk.env` when `AFK_HOME` is unset.

### 2. Verify

```sh
# SessionStart hook (no API key needed)
echo '{"session_id":"test","cwd":"'$(pwd)'"}' | node --experimental-strip-types src/session-start.ts

# Prompt router (needs API key)
echo '{"prompt":"list files in this directory","session_id":"test"}' | node --experimental-strip-types src/prompt-router.ts
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

- **Hook environment**: AFK passes neither `CLAUDE_CONFIG_DIR` nor `CLAUDE_PLUGIN_OPTION_*` to hooks (agent-afk 5.257.3). Logs go to `~/.claude`, and the provider follows the key's prefix; it cannot be pinned.
- **Advisory-only subagent routing**: AFK command hooks read only `continue`, `decision`, `reason`, and `hookSpecificOutput.additionalContext` (agent-afk 5.244.0), so a tier recommendation and a missing-brief note surface as context text. The hook cannot switch the model. AFK does honor `decision: "block"` with a `reason`, so denying a bad brief is possible, but the adapter does not do it yet.
- **Named agents are not routed**: a spawn with an `agent_type` takes that agent's model defaults, so the hook skips the tier question and only checks the brief.
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
  dist/                # Compiled JS from npm run build; the hooks run src/ directly
```

## Runtime requirements

- Node.js 22.18 or later, which runs the TypeScript hooks without a build
- `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` in AFK's `afk.env` (except SessionStart, which needs no key)
