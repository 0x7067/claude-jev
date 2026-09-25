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
- `rules-bash-partial` marks the turn's diff partial when the snapshot fails, for example outside a git repository, when the command touches an ignored path, or when the after-diff itself errors.
- `rules-bash-failure` records the same hunk for a command that failed: `hooks.json` runs this script on `PostToolUseFailure` for `Bash` too.
- `rules-live-block` (out-of-band; needs a key) blocks an edit that breaks a rule and spends a per-session budget.
- `rules-live-turn` (out-of-band; needs a key) judges the turn on `Stop` over a narrower rule set than the edit phase.
- `rules-toggle-off` makes no Jev call when `rules` ("Rule checks" in `/claude-jev` or `/config`) is off.

## How to get to it (user POV)

- Edit a file in Claude Code with the plugin installed.
- Run a shell command that writes files (Bash snapshot hooks), including one that fails after writing.
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
- **Bash partial.** Run the `PreToolUse` event with `"session_id":"vnogit"` and `cwd` set to a new directory under `$VERIFY_HOME` that is not a git repo. Exit code `0`; `jev-rule-blocks/vnogit.json` has `"partial": true`. This still needs the real `transcript_path` — with no transcript the handler returns before the snapshot is attempted and **no state file is written at all**.
- **Bash partial by ignored path (in-band, no Jev call).** In a second disposable git repo, put `out/` in `.gitignore` and commit only `f.txt`. Send `PreToolUse` with a new `session_id` and `tool_use_id`, run `mkdir -p $R/out && echo x > $R/out/log.txt`, then send the matching `PostToolUse`. Exit code `0`; the state file has `"partial": true` with `"files": []` and **no hunks** — the tree diff cannot see the ignored write, so the turn is marked partial with **no snapshot failure**. Verified as `vign.json`.
- **Bash partial drops hunks on error (from source, not driven here).** When the after-tree or the diff itself errors, the handler sets `partial` and returns `{}`, so unlike the ignored-path case it records no hunks at all. Reproducing it needs git to fail mid-way, which no `control-jev` recipe does yet.
- **Toggle off.** Export a fake key so a call, if made, is logged: `export OPENROUTER_API_KEY=sk-or-v1-fake` (a bare assignment does not reach `control-jev`). Count lines in `$VERIFY_HOME/.claude/jev-calls.jsonl`, run `CLAUDE_PLUGIN_OPTION_RULES=false control-jev hook rules '{"hook_event_name":"PostToolUse","cwd":"'"$CLAUDE_PLUGIN_ROOT"'","tool_input":{"file_path":"'"$CLAUDE_PLUGIN_ROOT"'/scripts/jev.py","old_string":"DEFAULT_TIMEOUT","new_string":"DEFAULT_TIMEOUT"}}'`, and count again. Use the edit event: a Stop event with no transcript makes no call either way. Exit code `0`, stdout empty, and no line added. The same run without the variable adds one `jev-calls.jsonl` row **per chunk**, not one row: the instruction file is classified in chunks, so a run on this checkout added 3 rows (12, 60, and 60 questions). Any rise proves the count can move. Save both counts as `rule-enforcement/toggle-off.txt`. Run `unset OPENROUTER_API_KEY` afterward; the no-key recipes need it unset.
- **Bash failure hunk.** Reuse the disposable repo and transcript from **Bash hunk** with `"tool_use_id":"t9"`, `"session_id":"vfail"`, and the `PreToolUse` event, then write the file and send the same event with `"hook_event_name":"PostToolUseFailure"`. Exit code `0`, stdout empty; `jev-rule-blocks/vfail.json` has `"files": ["f.txt"]`, `"partial": false`, and the hunk, exactly like the success path.
- **Live block budget (out-of-band; needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, not Claude Code).** Send a `PostToolUse` edit event whose `new_string` adds a `# comment` line to a path this checkout's rules cover, with a `session_id` and `cwd` set to the checkout. With a key the hook answers in about a second: `{"decision": "block", "reason": "..."}` naming the rule id and the instruction-file line. Send the **same event again in the same session: it blocks a second time.** The budget is `MAX_BLOCKS` (2) per `(rule, file)` per session, not one per input. The third and every later send prints only `{"systemMessage": "[jev rules] uncertain about <rule> <prob> on <file> — not sent to the agent"}`. A fresh `session_id` blocks from 0 again. Prove it on `jev-rule-blocks/<session>.json`, where the `(rule, file)` key counts to 2.
- **Live turn judgment (out-of-band; needs a key).** Write a transcript with one typed user line (`{"type":"user","uuid":"sx1",...}`), send a `PostToolUse` edit event carrying that `transcript_path` so a hunk lands under `sx1`, then send `Stop` with the same `session_id`, `cwd`, and `transcript_path`. Exit code `0`. Read the `rules` row with `phase=turn` in `jev-router-log.jsonl`: it carries `n_scoped_out` and the `probs` the turn actually judged. The turn phase judges only rules whose section the turn's files touch — on this checkout it judged 1 rule where the edit phase judged 15, and a comment edit that blocked at `phase=edit` (0.96) produced no `probs` entry at all at `phase=turn`, so stdout stayed empty.
- **Proof.** Save the three transcripts under `rule-enforcement/`. Each shows exit `0` and empty stdout for the no-key path. `rule-enforcement/toggle-off.txt` shows 0 calls with the toggle off and more than 0 with it on, and says how many rows the on-run added. Save the three `jev-rule-blocks/<session>.json` states as `rule-enforcement/bash-hunk.json`. With a key, save the live block sends and the `phase=turn` row as `rule-enforcement/live-block-budget.txt` and `rule-enforcement/live-stop-turn.txt`.

## Gotchas

- Live key / real Claude Code session block-or-flag paths need `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`; only a real *session* needs Claude Code, so the block, budget, and turn recipes above are drivable under `control-jev` alone. Do not count fail-open silence as that proof.
- A Stop event with an empty `transcript_path` makes no call: the last user message keys the turn state, so there is no turn to judge. Do not use it for the toggle proof — use the edit event.
- Empty stdout on a Stop is not one signal. It can mean a Jev failure, a compliant turn, a turn the hook skipped because the transcript's last user entry is not a typed prompt, or a violation whose rule the turn phase scoped out. The `phase`, `probs`, and `blocked` fields of the `rules` row in `jev-router-log.jsonl` tell them apart; `blocked: []` with a one-entry `probs` means the rule never reached the turn phase.
- A turn's `AskUserQuestion` answers ride along in the Jev request; the decision row counts them in `user_answers`. An empty stdout after the user approved something by picking an option is expected, not a dropped call.
- Vendored and out-of-project paths are skipped by the hook; pointing `file_path` outside the project is not a positive enforcement case.
- Empty stdout with a live key can mean "compliant" or "below FLAG" — pair with the decision log under `$VERIFY_HOME/.claude/jev-router-log.jsonl` when proving an out-of-band judgment.
- The Bash hooks need a transcript whose **last user entry carries a `uuid`** and reads as a typed prompt; the uuid is the turn key, so an entry with no `uuid` records nothing even though the prompt itself is fine. Only the last 400 lines are read, and an entry longer than 500,000 chars is skipped. With `transcript_path` empty they record nothing.
- `tool_use_id` is **optional** on the Bash pair: the key is `tool_use_id`, else the canonicalized JSON of `tool_input`. So a Pre/Post pair with **no** `tool_use_id` on either side still pairs and records. "A Post with an unseen id records nothing" is only true when ids were present and differ. Pairing also requires the same turn uuid and the same session file (`session_id` defaults to `unknown`).
- The edit path is asymmetric: it records a turn hunk **before** judging, so an `Edit` event with no `session_id` and no `transcript_path` still creates `jev-rule-blocks/unknown.json` with `turn: ""` — but only once rule classification succeeds. With no key, `load_rules` raises first and nothing is written, which is why the no-key edit recipe leaves the directory untouched.
- `partial` resets to `false` whenever the turn uuid changes, and each git call is capped at 4s, so a slow repo can look like a clean turn rather than a partial one.
- A malformed event appends a `rules-error` row to `jev-router-log.jsonl`, but that write has **no** `makedirs`: on a home where `.claude/` does not exist yet the row is silently not written. Assert the exit code and empty stdout, not the error row.
- Two more config-dir files appear once a rules judgment runs with a key: `jev-rules-cache.json` (per-chunk, content-hashed, written atomically via a `.<pid>.tmp` sibling) and `jev-rules-calib.json` (per-rule thresholds). A proof that lists `$VERIFY_HOME/.claude/` will find them alongside `jev-rule-blocks/<session>.lock`.
- The hook reads rules from `CLAUDE.md` and `AGENTS.md` plus `.claude/rules` / `.cursor/rules`, and one **global** `CLAUDE.md` in the config dir — under this harness that is `$VERIFY_HOME/.claude/CLAUDE.md`. A leftover file there changes every rule count in this feature with no visible cause.
- The skip list is a regex over the **relative** path (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.claude`, `vendor`, `target`, lockfiles), so `.claude` paths are excluded by name as well as by the out-of-project test.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty and invalidates the edit/Stop events.
