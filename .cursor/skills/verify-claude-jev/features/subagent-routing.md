# Subagent routing

Subagent routing runs on `PreToolUse` for `Agent|Task`. When the caller did not
set `model`, it may set `updatedInput.model` to a tier. Failures must never
block the spawn.

## Sub-features

- `subagent-explicit` leaves an already-set model alone and prints nothing.
- `subagent-fail-open` exits 0 with empty stdout when the key is missing or input is bad.
- `subagent-route` (out-of-band; live key) may emit `hookSpecificOutput.updatedInput.model`.
- `subagent-tier-criteria` reads a subagent tier's description from the user's `CLAUDE.md` "Delegating to sub-agents" bullets, which is the Claude config dir's file — under this harness, `$VERIFY_HOME/.claude/CLAUDE.md`.
- `subagent-brief` (out-of-band; live key) denies a file-changing brief missing paths, acceptance criteria, verification command, or commit policy: `permissionDecision: deny` once per session per brief, then `systemMessage` only.
- `subagent-toggle-off` makes no Jev call when `subagentRouter` ("Subagent model routing" in `/claude-jev` or `/config`) is off.

## How to get to it (user POV)

- Spawn an Agent/Task tool without an explicit model in Claude Code.
- Spawn one with `model` already set (explicit wins).
- Spawn one without a model while your `CLAUDE.md` defines tier criteria (its text is what Jev reads).
- Run the plugin without `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` if the recipe needs exported run vars.

- **Explicit model.** Pass a model in tool input. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers","subagent_type":"Explore","model":"haiku"}}'`. Exit code `0` and stdout empty.
- **Fail open no key.** Unset the key and omit model. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers of parse_opt","subagent_type":"Explore"}}'`. Exit code `0` and stdout empty.
- **Malformed.** Feed non-JSON. Run `printf 'not-json\n' | control-jev hook subagent_router`. Exit code `0` and stdout empty.
- **Live route (out-of-band).** Needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` on a machine that can call Jev (Claude Code is not required — `control-jev` drives it). Run `control-jev hook subagent_router '{"tool_input":{"prompt":"grep the repo for the literal string parse_opt and list the files that contain it, nothing else","subagent_type":"Explore"},"session_id":"liveroute1"}'`. Exit code `0`; at confidence ≥ 0.75 stdout is `{"hookSpecificOutput":{"updatedInput":{...,"model":"haiku"}},"systemMessage":"[jev router] subagent → haiku (conf=1.00)"}`, and the tier is one of `haiku|sonnet|opus|fable` (the `TIERS` tuple).
- **Live brief check (out-of-band).** `control-jev hook subagent_router '{"tool_input":{"prompt":"Rename the helper in the parser module and update callers","subagent_type":"general-purpose"},"session_id":"livebrief1"}'`, sent twice with the same `session_id`. First send: `"permissionDecision": "deny"` with a reason naming the four missing parts (files or paths, acceptance criteria, verification command, commit policy). Second send: no `permissionDecision`, and `systemMessage` ending `spawned anyway (denied once already)`.
- **Toggle off.** Export a fake key so a call, if made, is logged: `export OPENROUTER_API_KEY=sk-or-v1-fake` (a bare assignment does not reach `control-jev`). Count lines in `$VERIFY_HOME/.claude/jev-calls.jsonl`, run `CLAUDE_PLUGIN_OPTION_SUBAGENTROUTER=false control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers of parse_opt","subagent_type":"Explore"}}'`, and count again. Exit code `0`, stdout empty, and no line added. The same run without the variable adds one line (a failed call on the fake key), which proves the count can move. Save both counts as `subagent-routing/toggle-off.txt`. Run `unset OPENROUTER_API_KEY` afterward; the no-key recipes need it unset.
- **Proof.** Save stdout/stderr/exit for explicit and fail-open cases under `subagent-routing/`. Both no-key cases show empty stdout and exit `0`. `subagent-routing/toggle-off.txt` shows 0 calls with the toggle off and 1 with it on.

- **Tier criteria.** Write `$VERIFY_HOME/.claude/CLAUDE.md` containing a `Delegating to sub-agents` heading with `- haiku: <text>` style bullets, then run either live recipe. Exit code `0`; the observable is the `subagent` row in `jev-router-log.jsonl` — with your file present the tier question is asked against your own descriptions. Delete the file before the no-key recipes; they do not read it.
- **Proof.** Save stdout/stderr/exit for explicit and fail-open cases under `subagent-routing/`. Both no-key cases show empty stdout and exit `0`. `subagent-routing/toggle-off.txt` shows 0 calls with the toggle off and a rise with it on. With a key, save the routed stdout and the two brief sends as `subagent-routing/live-route.txt` and `subagent-routing/live-brief.txt`.

## Gotchas

- An explicit `model` skips the tier question but not the brief check.
- An explicit `model` always wins; do not expect `updatedInput` on that path.
- The **Explicit model** recipe's empty stdout is not evidence that the model was left alone: with no key every input prints empty. It is a no-crash proof only; the deny path still runs on that event, so an explicit model plus an incomplete brief can print a denial.
- A brief is judged missing only when `brief_writes` clears `MIN_CONFIDENCE` (0.75) and each named part is at or under `BRIEF_MISSING` (0.25). A "confidently missing" part scoring 0.30 lists nothing and prints nothing.
- On the second send of a brief, `systemMessage` is **overwritten** when a tier is also picked: the route line `"[jev router] subagent → <tier> (conf=…)"` replaces "spawned anyway", and `updatedInput` appears alongside it. Assert the retry behavior on `permissionDecision` being absent, never on the phrase "spawned anyway".
- Denial state has no file of its own: `already_denied` re-reads `jev-router-log.jsonl` for a `kind: "subagent"` row with the same `session_id`, `brief_denied: true`, and the same first 200 characters of prompt. A missing or truncated log resets the denial. Both `session_id`s being absent also match (`None == None`).
- Tier criteria come from `CLAUDE.md` **in the config dir the run uses**, so under `control-jev` the real `~/.claude/CLAUDE.md` is never read and every live route proof silently runs on shipped defaults unless you plant the file.
- The toggle count rises by one row per hook run on a fake `sk-or-` key (an `HTTP 401` is logged once, not retried), but a network failure under `FAST_FAIL` (1.0 s) is retried and logs a row per attempt — two rows for one run on a host with no DNS. Assert "the count rises", not `+1`.
- Below `MIN_CONFIDENCE` (0.75) a live call also prints nothing — empty stdout is not only a missing-key signal. The tier answer is genuinely flaky on a terse brief: a `"search the repo for callers of parse_opt and report which ones break"` brief logged an answer and printed nothing, while an explicit read-only "grep for a literal, list the files" brief routed to `haiku` at conf 1.00. Use the explicit brief for a positive live proof; a null on the terse one is a routing result, not a broken hook.
- A brief-check denial is spent per `(session_id, prompt-head)` pair, read back from `jev-router-log.jsonl`. Reusing a `session_id` across live brief probes turns a later denial into `systemMessage` only.
- Do not mark the live route verified when the key was unset; that path is out-of-band.
