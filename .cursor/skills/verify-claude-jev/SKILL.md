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
`~/.claude` logs and caches with a live session.

Maintain the feature map under `features/` as the app changes. Use
`/maintain-verification-skill` to refresh entry points, selectors/commands, and
gotchas when hooks or skills drift.

## What this skill proves here

**In-band (proved by this skill's own launch → doctor → drive → cleanup loop):**

- `python3 -m compileall` over `scripts/` and `eval/`
- Hook stdin contract: empty/malformed events and no-key fail-open exit `0`
  without live classify (silent stdout)
- `compactor.py rows` fallback and pin-tail keep without calling Jev
- `jev.py` missing-key exit `2`

**Out-of-band (not proved on a ship without Claude Code + API key):**

- A real Claude Code session with the plugin loaded (`claude`, function hooks,
  trusted workspace)
- Live Jev classification / routing / rule blocks that need `TYPESAFE_API_KEY`
- End-to-end `/compact` through `hooks/register.ts`

Do not report an out-of-band path as verified because the in-band fail-open
path passed. Feature files mark live entries **out-of-band**; run those only on
a machine that has Claude Code and a real key.

## Launch

There is no long-lived server. Launch means: create a disposable home, point
`CLAUDE_PLUGIN_ROOT` at this checkout, and record a run id. Ready when
`control-jev doctor` exits 0.

```bash
export PATH="$PWD/.cursor/skills/verify-claude-jev/bin:$PATH"
# TYPESAFE_API_KEY is out-of-band for live classify; without it hooks fail open
control-jev launch
# prints run_id=... home=/tmp/jev-verify-... evidence_dir=... ready=1
# subsequent control-jev commands read the active run from the control state file
# force a specific id with JE_VERIFY_RUN_ID=... (must match [A-Za-z0-9._-]+,
# no `..`); reuse the last home with launch --reuse
eval "$(control-jev env)"   # exports CLAUDE_PLUGIN_ROOT (+ run vars after launch)
```

Teardown is `control-jev cleanup` (see Cleanup). Never drive an instance whose
verify home was not created by `control-jev launch` for this run.

Isolation: each run uses `VERIFY_HOME=/tmp/jev-verify-$RUN_ID`; child
processes see that path as `HOME`. Active-run state lives under
`$XDG_RUNTIME_DIR/jev-verify-control` when set, otherwise
`/tmp/jev-verify-control-<uid>` (mode 0700) — never a world-writable shared
path. The state file is a validated `RUN_ID=` line only (never `source`d).
Prefer `eval "$(control-jev env)"`, which exports recipe vars without
touching `HOME`. Do not point two drives at the same verify home.

## Doctor

Read-only check that the active run is worth driving:

```bash
control-jev doctor
```

Requires: `python3` compiles `scripts/` and `eval/`; empty stdin to
`prompt_router.py` exits 0 with empty stdout; empty stdin to
`compactor.py rows` exits 0 with a JSON `fallback`; disposable verify home
exists. Writes `$EVIDENCE_DIR/doctor.txt`. Fail the run if `doctor=fail`.

`TYPESAFE_API_KEY` may be unset. Doctor reports `typesafe_api_key=unset` and
still passes — fail-open without a key is the in-band expectation. Live
classification is out-of-band; see feature files.

## Drive

Harness: `control-jev` (shell). Prefer it over raw python so verify home and
evidence paths stay consistent.

Before any recipe JSON that expands `$CLAUDE_PLUGIN_ROOT` (or other run vars),
load the exportable assignments:

```bash
eval "$(control-jev env)"
```

`control-jev env` always prints `export CLAUDE_PLUGIN_ROOT=…` for this
checkout. After `launch`, it also prints `RUN_ID`, `VERIFY_HOME`, and
`EVIDENCE_DIR`. It never exports `HOME`.

```bash
# Hook with a JSON event argument (or pipe JSON on stdin with no arg)
control-jev hook prompt_router '{"prompt":"hi","transcript_path":""}'
control-jev hook subagent_router '{"tool_input":{"prompt":"find callers of foo","subagent_type":"Explore"}}'
control-jev hook rules '{"hook_event_name":"PostToolUse","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","tool_input":{"file_path":"'"$CLAUDE_PLUGIN_ROOT"'/scripts/jev.py","old_string":"x","new_string":"y"}}'

# Compaction rows bridge
control-jev rows /path/to/event.json
# or: control-jev rows < event.json

# Jev CLI missing-key (in-band). Live noul needs TYPESAFE_API_KEY (out-of-band).
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
- For mutations of disposable state under `$VERIFY_HOME/.claude/`: a second
  read of the file after the action (hooks append logs only when Jev answers).

```bash
control-jev evidence doctor.txt
control-jev save session-compaction/rows-out.json -
```

Standards: exercise the real stdin/CLI path Claude Code or the agent uses —
not internal setters. Capture the action and the resulting state. Mocks only
at the production boundary already used by the plugin (missing
`TYPESAFE_API_KEY` → fail open / `jev: set TYPESAFE_API_KEY`). When proving a
no-key path, observe silence or exit 2 rather than trusting the docstring.

In-band evidence proves compile + fail-open / pin-tail / missing-key only.
Out-of-band evidence (live classify, real `claude` session, function-hook
compaction) belongs on a machine with Claude Code and `TYPESAFE_API_KEY`; do
not treat an empty fail-open transcript as that proof.

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
control-jev launch|doctor|env|cleanup|status
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
