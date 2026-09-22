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
- Never drive a verify home that was not started by this verification run.
- Do not `source` the control-jev state file into your shell.
- `TYPESAFE_API_KEY` may be unset. Without it, hooks must fail open (exit 0,
  no stdout) and `jev.py` must exit 2 with `jev: set TYPESAFE_API_KEY`. Live
  classification proofs require the key; feature files say so under Gotchas.
- Put evidence under `.cursor/skills/verify-claude-jev/artifacts/$RUN_ID/` via
  `control-jev save`.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted JSON and flags unchanged.
- Drive hooks through `control-jev hook <name> '<json>'`.
- Drive the rows bridge through `control-jev rows`.
- Drive the agent-facing CLI through `control-jev jev -- ...`.
- Restore nothing under `$HOME` after a mutation except when a recipe says to
  delete a disposable fixture file. Never remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action (JSON event or CLI argv) and the resulting stdout,
  stderr, and exit code — not only a final success line.
- Hook proof includes the event file and the hook output (or empty output when
  fail-open / skip applies).
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof (log append under `$HOME/.claude/`) includes a second read of
  the log after the call.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet
  precondition (usually a missing `TYPESAFE_API_KEY`).
- Do not report a skipped live-API entry point as verified through fail-open.

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

- [Prompt routing](./prompt-routing.md) covers UserPromptSubmit skip and fail-open.
- [Subagent routing](./subagent-routing.md) covers PreToolUse model picking and fail-open.
- [Rule enforcement](./rule-enforcement.md) covers PostToolUse / Stop fail-open and event shape.
- [Session compaction](./session-compaction.md) covers the `rows` bridge, pin-tail keep, and fallback.
- [Jev CLI](./jev-cli.md) covers the agent skill CLI missing-key and ask surfaces.
