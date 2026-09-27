# claude-jev AFK Plugin

Jev judgment hooks for [agent-afk](https://github.com/griffinwork40/agent-afk). Five hooks judge session starts, prompts, subagent spawns, edits, and turn ends, enforcing your project rules through the Jev (TypeSafe System One) judgment API.

**Hooks are fences; MCP tools are lenses.** The Jev MCP server (`jev-mcp`) gives the agent tools it can call on demand. This plugin adds hooks the agent cannot skip or rationalize past. Use both: MCP for agent-initiated judgment, hooks for agent-proof guardrails.

## What it does

| Hook | Event | What it judges |
|------|-------|----------------|
| `session-start.ts` | `SessionStart` | Loads rules from instruction files and injects a structured digest into the session's first turn. No API call (pure file I/O). |
| `prompt-router.ts` | `UserPromptSubmit` | Classifies each prompt as chat / lookup / fix / feature / ops and injects a routing hint when confidence >= 0.75. Interactive REPL only. |
| `subagent-router.ts` | `PreToolUse` (`agent`) | Recommends a model tier when the spawn names no `agent_type`, and flags a brief that changes files but leaves out paths, acceptance criteria, verification, or commit policy. Advisory only, and AFK does not deliver it yet (see Known gaps). |
| `rules.ts` | `PreToolUse` (`edit_file`, `write_file`) | Loads rules from instruction files, classifies them, and judges each edit before it is written. **Blocks at >= 0.80**, so the edit never lands (agent cannot override). Flags 0.50-0.80 as advisory context, which AFK does not deliver yet. |
| `stop-sweep.ts` | `Stop` | Judges the edits made since its last completed judgment against turn-scope rules (scope creep, cross-file patterns), and hands what it finds to the next turn. Interactive REPL only. |

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

The rule hook and the Stop sweep keep per-session state, so they need the session id on each hook event. agent-afk sends it from the first release that includes [griffinwork40/agent-afk#2392](https://github.com/griffinwork40/agent-afk/pull/2392). On earlier versions both stay silent rather than share one state file across every session.

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

AFK starts hook commands with a reduced environment: `PATH`, `HOME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `USER`, `LOGNAME`, non-secret `AFK_*` variables, and `CLAUDE_PLUGIN_ROOT`. A key exported in your shell does not reach the hooks. Store it in AFK's env file instead, which the hooks read when AFK runs them. `afk config env set` refuses these names (`unknown config key`, agent-afk 5.259.0), so add the line with an editor:

```sh
# ~/.afk/config/afk.env
TYPESAFE_API_KEY=your-key-here
# or
OPENROUTER_API_KEY=sk-or-...
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

`rules.ts` runs on `PreToolUse`, before `edit_file` or `write_file` touches the file. When it judges the edit against a rule at >= 0.80 probability of violation, it prints `{"decision": "block", "reason": ...}`. AFK does not run the tool and returns the reason to the agent as an error result, so the edit never lands and the agent must rewrite it before continuing. The agent cannot skip or dismiss this. In a live agent-afk 5.259.0 session the judgment took about half a second.

AFK ignores a block from a `PostToolUse` hook: it dispatches that event without waiting and only records the decision in its trace. That is why the rule hook does not run after the edit, as the Claude Code plugin's does.

Each rule is allowed to block the same file at most twice per session. After that, the rule downgrades to a flag to prevent unlandable repair loops. An edit the hook blocks is not recorded for the Stop sweep, because it never landed.

Edits in the 0.50-0.80 range are not blocked. The hook prints them as `additionalContext`, but AFK drops everything except a block from a `PreToolUse` hook, so today they reach neither the agent nor the user.

`stop-sweep.ts` judges the edits that went through since its last completed judgment, then clears that record; when the Jev call fails, the edits wait for the next turn's sweep. AFK fires `Stop` only in the interactive REPL, gives each Stop handler 5 s, and shows a Stop block to the user as a notice without passing it to the agent. The sweep therefore reports as `additionalContext`, which AFK prepends to the user's next prompt, and asks the agent to repair the file unless the user says otherwise.

## Known gaps

- **Hook environment**: AFK passes neither `CLAUDE_CONFIG_DIR` nor `CLAUDE_PLUGIN_OPTION_*` to hooks (agent-afk 5.257.3). Logs go to `~/.claude`, and the provider follows the key's prefix; it cannot be pinned.
- **Subagent routing is not delivered**: AFK command hooks read only `continue`, `decision`, `reason`, and `hookSpecificOutput.additionalContext` (agent-afk 5.244.0), and AFK keeps nothing but a block from a `PreToolUse` hook (agent-afk 5.259.0). The subagent router never blocks, so its tier recommendation and missing-brief note reach neither the agent nor the user, and the hook cannot switch the model. AFK does honor `decision: "block"` with a `reason`, so denying a bad brief is possible, but the adapter does not do it yet.
- **Uncertain rule matches are not delivered**: see [How blocking works](#how-blocking-works).
- **Prompt and turn-end hooks run only in the REPL**: AFK fires `UserPromptSubmit` and `Stop` only in the interactive REPL, so the prompt router and the Stop sweep never run in `afk chat`, Telegram, or daemon sessions.
- **`patch_apply` is not judged**: the rule hook reads `edit_file` and `write_file` input only, so edits made through `patch_apply` land unjudged.
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
    rules.ts           # PreToolUse(edit): rule enforcement
    stop-sweep.ts      # Stop: turn-level compliance
  dist/                # Compiled JS from npm run build; the hooks run src/ directly
```

## Runtime requirements

- Node.js 22.18 or later, which runs the TypeScript hooks without a build
- `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` in AFK's `afk.env` (except SessionStart, which needs no key)
- For the rule hook and the Stop sweep, an agent-afk release that sends the session id on each hook event ([griffinwork40/agent-afk#2392](https://github.com/griffinwork40/agent-afk/pull/2392))
