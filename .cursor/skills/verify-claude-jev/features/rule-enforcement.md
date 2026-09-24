# Rule enforcement

Rule enforcement judges edits on `PostToolUse` (`Edit|Write|MultiEdit|NotebookEdit`)
and whole-turn rules on `Stop`. On `Bash`, `PreToolUse` snapshots the git
working tree and `PostToolUse` / `PostToolUseFailure` record what the command
changed, so `Stop` judges shell writes too. Any error or missing key must exit 0 without
blocking the session.

## Sub-features

- `rules-fail-open` exits 0 with empty stdout on bad input or missing API key.
- `rules-stop-shape` accepts `hook_event_name=Stop` without crashing.
- `rules-edit-shape` accepts a PostToolUse edit event without crashing.
- `rules-bash-hunk` records each file a Bash command changed as a turn hunk, with no Jev call.
- `rules-bash-partial` marks the turn's diff partial when the snapshot fails, for example outside a git repository.
- `rules-toggle-off` makes no Jev call when `rules` ("Rule checks" in `/claude-jev` or `/config`) is off.

## How to get to it (user POV)

- Edit a file in Claude Code with the plugin installed.
- Run a shell command that writes files (Bash snapshot hooks).
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
- **Bash hunk.** Make a disposable repo: `R=$VERIFY_HOME/bashrepo; mkdir -p $R && git -C $R init -q && echo a > $R/f.txt && git -C $R add . && git -C $R -c user.email=v@v -c user.name=v commit -qm i`. Write a transcript with one user prompt: `T=$VERIFY_HOME/transcript.jsonl; echo '{"type":"user","uuid":"u1","message":{"role":"user","content":"change f"}}' > $T`. Run `control-jev hook rules '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t1","session_id":"vbash","cwd":"'"$R"'","transcript_path":"'"$T"'","tool_input":{"command":"echo b > f.txt"}}'`, then `echo b > $R/f.txt`, then the same event with `"hook_event_name":"PostToolUse"`. Both exit `0` with empty stdout. `$VERIFY_HOME/.claude/jev-rule-blocks/vbash.json` has `"files": ["f.txt"]`, `"partial": false`, empty `snapshots`, and a hunk with `-a` / `+b`.
- **Bash partial.** Run the `PreToolUse` event with `"session_id":"vnogit"` and `cwd` set to a new directory under `$VERIFY_HOME` that is not a git repo. Exit code `0`; `jev-rule-blocks/vnogit.json` has `"partial": true`.
- **Toggle off.** Export a fake key so a call, if made, is logged: `export OPENROUTER_API_KEY=sk-or-v1-fake` (a bare assignment does not reach `control-jev`). Count lines in `$VERIFY_HOME/.claude/jev-calls.jsonl`, run `CLAUDE_PLUGIN_OPTION_RULES=false control-jev hook rules '{"hook_event_name":"PostToolUse","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","tool_input":{"file_path":"'"$CLAUDE_PLUGIN_ROOT"'/scripts/jev.py","old_string":"DEFAULT_TIMEOUT","new_string":"DEFAULT_TIMEOUT"}}'`, and count again. Use the edit event: a Stop event with no transcript makes no call either way. Exit code `0`, stdout empty, and no line added. The same run without the variable adds one line (a failed call on the fake key), which proves the count can move. Save both counts as `rule-enforcement/toggle-off.txt`. Run `unset OPENROUTER_API_KEY` afterward; the no-key recipes need it unset.
- **Proof.** Save the three transcripts under `rule-enforcement/`. Each shows exit `0` and empty stdout for the no-key path. `rule-enforcement/toggle-off.txt` shows 0 calls with the toggle off and 1 with it on.

## Gotchas

- Live key / real Claude Code session block-or-flag paths are **out-of-band** — need Claude Code + `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Do not count fail-open silence as that proof.
- Vendored and out-of-project paths are skipped by the hook; pointing `file_path` outside the project is not a positive enforcement case.
- Empty stdout with a live key can mean "compliant" or "below FLAG" — pair with the decision log under `$VERIFY_HOME/.claude/jev-router-log.jsonl` when proving an out-of-band judgment.
- The Bash hooks need a transcript whose last user entry is a typed prompt; with `transcript_path` empty they record nothing.
- Pre and Post pair by `tool_use_id`. A Post with an unseen id records nothing.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty and invalidates the edit/Stop events.
