# claude-jev verification map

This directory is the maintained source for verifying the user-facing behavior
of claude-jev. Read the index before driving the plugin, then use the matching
feature file as the recipe.

## Baseline preconditions

- Run from the repository root with `PATH` including
  `.cursor/skills/verify-claude-jev/bin`.
- `control-jev launch` created this run's disposable
  `VERIFY_HOME=/tmp/jev-verify-$RUN_ID` (child processes see it as `HOME`).
- `control-jev doctor` printed `doctor=ok` and wrote `$EVIDENCE_DIR/doctor.txt`.
- Run `eval "$(control-jev env)"` before any recipe line that expands
  `$CLAUDE_PLUGIN_ROOT`, `$EVIDENCE_DIR`, or `$RUN_ID`. That command exports
  those assignments without replacing your shell `HOME`.
- Never drive a verify home that was not started by this verification run.
- Do not `source` the control-jev state file into your shell.
- `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` may both be unset. Without them,
  hooks must fail open (exit 0, no stdout) and `jev.py` must exit 2 with
  `jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY`. That is the **in-band**
  contract for this skill. A key saved in the `/claude-jev` settings pane does
  not apply here: Claude Code hands it to hooks as `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`, and `control-jev` runs the scripts directly.
- Put evidence under `.cursor/skills/verify-claude-jev/artifacts/$RUN_ID/` via
  `control-jev save`.

## In-band vs out-of-band

**In-band** (this skill's proved contract without Claude Code): `compileall`,
hook stdin fail-open / skip, `rows` bad-input fallback, pin-tail keep, and
no-key multi-row Jev-error fallback, `jev.py` missing-key.

**Out-of-band** (needs a machine with Claude Code + `TYPESAFE_API_KEY` or
`OPENROUTER_API_KEY`): live classify/route/block answers, a real plugin
session, function-hook `/compact`, and the `/claude-jev` settings pane.
Feature bullets labeled out-of-band are recipes for that machine only — never
count an in-band fail-open pass as verifying them.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted JSON and flags unchanged.
- Load recipe env with `eval "$(control-jev env)"` before expanding `$CLAUDE_PLUGIN_ROOT`.
- Drive hooks through `control-jev hook <name> '<json>'`.
- Drive the rows bridge through `control-jev rows`.
- Drive the agent-facing CLI through `control-jev jev -- ...`.
- Restore nothing under `$VERIFY_HOME` after a mutation except when a recipe says to
  delete a disposable fixture file. Never remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action (JSON event or CLI argv) and the resulting stdout,
  stderr, and exit code — not only a final success line.
- Hook proof includes the event file and the hook output (or empty output when
  fail-open / skip applies).
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof (log append under `$VERIFY_HOME/.claude/`) includes a second read of
  the log after the call.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable or out-of-band path with the attempted command and the
  unmet precondition (usually missing `TYPESAFE_API_KEY` or no `claude`).
- Do not report a skipped live-API / Claude Code entry point as verified through fail-open.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-jev` starts with `Preconditions:` and uses labeled
   bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable
handles, required state, commands, and observable proof.

## Features

- [Prompt routing](./prompt-routing.md) covers UserPromptSubmit skip, fail-open, and the on/off toggle.
- [Subagent routing](./subagent-routing.md) covers PreToolUse model picking, fail-open, and the on/off toggle.
- [Rule enforcement](./rule-enforcement.md) covers PostToolUse / Stop fail-open, event shape, Bash snapshot hunks, and the on/off toggle.
- [Session compaction](./session-compaction.md) covers the `rows` bridge: bad-input fallback, pin-tail keep, and no-key multi-row Jev-error fallback.
- [Jev CLI](./jev-cli.md) covers the `scripts/jev.py` CLI: missing key, bad input, `status`, and a pinned provider.
- [Stats](./stats.md) covers `scripts/stats.py`, the report the pane's Stats row shows.
- [Settings pane](./settings-pane.md) covers the `/claude-jev` pane (out-of-band only).
