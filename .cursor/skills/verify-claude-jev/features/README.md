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
- `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` may both be unset. Without them,
  hooks must fail open (exit 0, no stdout) and `jev.py` must exit 2 with
  `jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY`. That is the **in-band**
  contract for this skill. `control-jev` passes your environment through, so if
  your shell has real keys, every no-key recipe must start with
  `unset TYPESAFE_API_KEY OPENROUTER_API_KEY CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`
  in the same shell — otherwise the recipe makes live paid calls and stops proving
  fail-open. The third is the pane-saved key, and **doctor does not report it**:
  it only prints the two env vars. Catch it with
  `control-jev jev -- status` — `"key": "saved"` means a "no-key" fixture will
  really call Jev.
- Run one `control-jev launch` per audit. There is a single active-run slot and
  `cleanup` empties it, which orphans an earlier run's home and evidence until
  you re-adopt it with `JE_VERIFY_RUN_ID=<id> control-jev launch`.
- Do not `source` the control-jev state file into your shell.
- A key saved in the `/claude-jev` settings pane does not apply here: Claude
  Code hands it to hooks as `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`, and
  `control-jev` runs the scripts directly.
- Put evidence under `.cursor/skills/verify-claude-jev/artifacts/$RUN_ID/` via
  `control-jev save`.

## In-band vs out-of-band

**In-band** (this skill's proved contract without Claude Code): `compileall`,
hook stdin fail-open / skip, `rows` bad-input fallback (all four reasons) and its
exit-2 usage path, pin-tail keep including `KEEP_CHARS` truncation, and no-key
multi-row Jev-error fallback, `jev.py` missing-key and usage exits, each command
hook's on/off toggle (`PROMPTROUTER` / `SUBAGENTROUTER` / `RULES` — not
`COMPACTION`, which is gated only in `register.ts`), the Bash snapshot hunks with
all three `partial` triggers, `stats.py` on an empty home, and
`comparators.py which` with no ast-grep installed. `SKILL.md`'s "What this skill
proves here" is the same list; keep the two in step.

**Out-of-band** (needs a real key; the last two also need Claude Code): live
classify/route/block answers, the populated stats report, a real plugin session,
function-hook `/compact`, and the `/claude-jev` settings pane.
Feature bullets labeled out-of-band are recipes for that machine only — never
count an in-band fail-open pass as verifying them.

A label of "out-of-band" that names only a key (no Claude Code) is drivable here
after all: a live `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` plus `control-jev
hook` proves the router hint, the subagent route and brief denial, the rule
block and its per-session budget, `jev noul`, and the populated stats report.
Only the settings pane and function-hook `/compact` truly need a real session, and
both were proved that way once (2026-09-25) against the **installed** copy: see the
toggle A/B in `settings-pane.md` and the two debug lines in `session-compaction.md`.
`claude plugin update claude-jev@claude-jev` moves that copy to current, so such a
run needs no `--plugin-dir` — and after updating, the session must be restarted
before the new code is the one under test.

The eval gates (`eval/replay.py`, `eval/rules_eval.py`, `eval/compare.py`) are
out-of-band and are the only evidence allowed to change a number in `README.md`.
They bill differently: `run` judges prompts through Jev and costs calls, while
`report` reads the cached prediction and answer files and is free — with
`eval/observed/` populated, all three routing rows and the compaction gate can be
re-read without spending, and only uncached or re-worded cases bill. Confirm the
cache holds what you need (`wc -l eval/observed/pred_<variant>.jsonl`) before
asking to run.

`rules_eval.py run --out` does **not** bypass the answer cache — it moves the
prediction file only, while `eval/observed/rules_cache.jsonl` is still read, so a
re-score reports a latency that belongs to the cache (0.01s) and not the hook
(0.40s live). `JEV_RULES_CACHE=<fresh path>` is the only live route: it re-asks
every question, ~320 calls and ~40s for the 247-edit sample, and that is what
`README.md`'s latency cell is measured by. Set it to a throwaway path so the
standing cache keeps its answers.

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
- [Comparators](./comparators.md) covers the pinned ast-grep the rules hook consults: `which`, a judgment with no binary, and the detached fetch.
- [Settings pane](./settings-pane.md) covers the `/claude-jev` pane (out-of-band only).
