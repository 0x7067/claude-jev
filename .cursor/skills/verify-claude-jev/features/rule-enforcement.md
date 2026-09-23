# Rule enforcement

Rule enforcement judges edits on `PostToolUse` (`Edit|Write|MultiEdit|NotebookEdit`)
and whole-turn rules on `Stop`. Any error or missing key must exit 0 without
blocking the session.

## Sub-features

- `rules-fail-open` exits 0 with empty stdout on bad input or missing API key.
- `rules-stop-shape` accepts `hook_event_name=Stop` without crashing.
- `rules-edit-shape` accepts a PostToolUse edit event without crashing.

## How to get to it (user POV)

- Edit a file in Claude Code with the plugin installed.
- End a turn that accumulated edits (Stop hook).
- Run without `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` (enforcement disables silently).

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` has exported `CLAUDE_PLUGIN_ROOT` (required before the edit/Stop JSON below).
- `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` are unset for the in-band fail-open proof.

- **Malformed.** Feed non-JSON. Run `printf 'not-json\n' | control-jev hook rules`. Exit code `0` and stdout empty.
- **Edit event no key.** Feed a PostToolUse-shaped edit. Run `control-jev hook rules '{"hook_event_name":"PostToolUse","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","tool_input":{"file_path":"'"$CLAUDE_PLUGIN_ROOT"'/scripts/jev.py","old_string":"DEFAULT_TIMEOUT","new_string":"DEFAULT_TIMEOUT"}}'`. Exit code `0` and stdout empty when the key is unset.
- **Stop event no key.** Feed Stop. Run `control-jev hook rules '{"hook_event_name":"Stop","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","transcript_path":""}'`. Exit code `0` and stdout empty when the key is unset.
- **Proof.** Save the three transcripts under `rule-enforcement/`. Each shows exit `0` and empty stdout for the no-key path.

## Gotchas

- Live key / real Claude Code session block-or-flag paths are **out-of-band** — need Claude Code + `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Do not count fail-open silence as that proof.
- Vendored and out-of-project paths are skipped by the hook; pointing `file_path` outside the project is not a positive enforcement case.
- Empty stdout with a live key can mean "compliant" or "below FLAG" — pair with the decision log under `$VERIFY_HOME/.claude/jev-router-log.jsonl` when proving an out-of-band judgment.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty and invalidates the edit/Stop events.
