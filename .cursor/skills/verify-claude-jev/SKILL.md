---
name: verify-claude-jev
description: >
  Drive and prove claude-jev (Claude Code plugin) the way a user/session would:
  isolated HOME, stdin JSON hooks, jev CLI, and compaction rows bridge. Use for
  /verify-claude-jev, verifying hook fail-open, routing, rules, compaction, or
  the jev/stats skills after changing scripts/.
---

# Verify claude-jev

claude-jev is a Claude Code plugin. Users do not open a web UI; they install the
plugin and Claude Code invokes Python hooks on stdin JSON. Agents also call
`scripts/jev.py` and `/claude-jev:stats`. This skill drives those surfaces from
the shell with an isolated `HOME` so a verification run never shares
`~/.claude` logs or caches with a live session.

Maintain the feature map under `features/` as the app changes. Use
`/maintain-verification-skill` to refresh entry points, selectors/commands, and
gotchas when hooks or skills drift.

## Launch

There is no long-lived server. Launch means: create a disposable home, point
`CLAUDE_PLUGIN_ROOT` at this checkout, and record a run id. Ready when
`control-jev doctor` exits 0.

```bash
export PATH="$PWD/.cursor/skills/verify-claude-jev/bin:$PATH"
# optional: TYPESAFE_API_KEY for live Jev calls; without it hooks fail open
control-jev launch
# prints run_id=... home=/tmp/jev-verify-... evidence_dir=... ready=1
# subsequent control-jev commands read the active run from the control state file
# force a specific id with JE_VERIFY_RUN_ID=...; reuse the last home with launch --reuse
```

Teardown is `control-jev cleanup` (see Cleanup). Never drive an instance whose
`HOME` was not created by `control-jev launch` for this run.

Isolation: each run uses `HOME=/tmp/jev-verify-$RUN_ID`. Do not point two
drives at the same `HOME`. Do not use the developer's real home.

## Doctor

Read-only check that the active run is worth driving:

```bash
control-jev doctor
```

Requires: `python3` compiles `scripts/` and `eval/`; empty stdin to
`prompt_router.py` exits 0 with empty stdout; empty stdin to
`compactor.py rows` exits 0 with a JSON `fallback`; disposable `HOME` exists.
Writes `$EVIDENCE_DIR/doctor.txt`. Fail the run if `doctor=fail`.

`TYPESAFE_API_KEY` may be unset. Doctor reports `typesafe_api_key=unset` and
still passes — fail-open without a key is expected. Live classification paths
need the key; see feature files.

## Drive

Harness: `control-jev` (shell). Prefer it over raw python so `HOME` and
evidence paths stay consistent.

```bash
# Hook with a JSON event argument (or pipe JSON on stdin with no arg)
control-jev hook prompt_router '{"prompt":"hi","transcript_path":""}'
control-jev hook subagent_router '{"tool_input":{"prompt":"find callers of foo","subagent_type":"Explore"}}'
control-jev hook rules '{"hook_event_name":"PostToolUse","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","tool_input":{"file_path":"scripts/jev.py","old_string":"x","new_string":"y"}}'

# Compaction rows bridge
control-jev rows /path/to/event.json
# or: control-jev rows < event.json

# Jev CLI / stats (need API key for success paths)
control-jev jev -- noul "Is this a yes/no check?" "state text"
control-jev stats -- --days 7
```

Stable handles: script paths under `scripts/`, JSON field names Claude Code
sends (`prompt`, `tool_input`, `hook_event_name`, `messages`), and CLI
subcommands documented in `skills/jev/SKILL.md`. Prefer those over scraping
log prose.

Feature recipes live in `features/`. Start from the baseline in
`features/README.md`, then follow one feature file end to end.

## Evidence

Proof root for a run (named location; survives cleanup):

`.cursor/skills/verify-claude-jev/artifacts/<RUN_ID>/`

Override with `JE_VERIFY_EVIDENCE` if needed. Capture:

- Command, stdout, stderr, and exit code for every drive step.
- The JSON event fed to a hook (action) and the hook's stdout (result).
- For compaction: the `messages` or `fallback` object, plus proof that
  pin-tail or fallback behavior matches the feature file.
- For mutations of disposable state under `$HOME/.claude/`: a second read
  of the file after the action (hooks append logs only when Jev answers).

```bash
control-jev evidence doctor.txt
control-jev save session-compaction/rows-out.json -
```

Standards: exercise the real stdin/CLI path Claude Code or the agent uses —
not internal setters. Capture the action and the resulting state. Mocks only
at the production boundary already used by the plugin (missing
`TYPESAFE_API_KEY` → fail open / `jev: set TYPESAFE_API_KEY`). When proving a
no-key path, observe silence or exit 2 rather than trusting the docstring.

## Cleanup

```bash
control-jev cleanup
```

Removes only `/tmp/jev-verify-$RUN_ID` for the active run and clears the
control state file. Does **not** delete `.cursor/skills/verify-claude-jev/artifacts/<RUN_ID>/`.
After cleanup, confirm evidence still exists:

```bash
test -d .cursor/skills/verify-claude-jev/artifacts/<RUN_ID>
ls .cursor/skills/verify-claude-jev/artifacts/<RUN_ID>
```

Never `pkill` by script name. Never remove another run's home.

## Helpers

Executable: `.cursor/skills/verify-claude-jev/bin/control-jev`

```bash
control-jev launch|doctor|cleanup|status
control-jev hook <prompt_router|subagent_router|rules> [json]
control-jev rows [json-file]
control-jev jev -- <jev.py args...>
control-jev stats -- <stats.py args...>
control-jev evidence <relpath>
control-jev save <relpath> -
control-jev help
```

Put `bin/` on `PATH` for the session, or invoke it by absolute path from the
repo root.

## Feature map

See [features/README.md](features/README.md). Drive one mapped feature per
proof unless the task asks for coverage.
