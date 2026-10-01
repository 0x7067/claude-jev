# Prompt routing

Prompt routing classifies each user prompt on `UserPromptSubmit` and may inject
a two-line routing hint into the agent's context. It prints no `systemMessage`
and no model tier: the tier hint was removed in 0.25.0. Short prompts, slash and `#` commands,
synthetic prompts, and failures must never block the session.

## Sub-features

- `router-skip-short` ignores prompts under three characters with no stdout.
- `router-skip-slash` ignores prompts starting with `/` or `#` with no stdout.
- `router-fail-open` exits 0 with empty stdout on malformed input or missing API key.
- `router-toggle-off` makes no Jev call when `promptRouter` ("Prompt routing hints" in `/claude-jev` or `/config`) is off.

## How to get to it (user POV)

- Type a normal prompt in Claude Code with the plugin installed (hook runs automatically).
- Type `/help` or a two-letter prompt (hook skips locally).
- Run with `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` unset (hook disables silently).

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` if the recipe needs `$CLAUDE_PLUGIN_ROOT` / `$EVIDENCE_DIR`.

- **Skip short.** Feed a two-character prompt. Run `control-jev hook prompt_router '{"prompt":"hi","transcript_path":""}'`. Exit code `0` and stdout empty.
- **Skip slash.** Feed a slash command. Run `control-jev hook prompt_router '{"prompt":"/help","transcript_path":""}'`. Exit code `0` and stdout empty.
- **Fail open empty.** Feed empty stdin. Run `printf '' | control-jev hook prompt_router`. Exit code `0` and stdout empty.
- **Fail open no key.** With `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` unset, feed a classifiable prompt. Run `control-jev hook prompt_router '{"prompt":"where is the retry timeout set?","transcript_path":""}'`. Exit code `0` and stdout empty (Jev call fails and the hook swallows it).
- **Toggle off.** Export a fake key so a call, if made, is logged: `export OPENROUTER_API_KEY=sk-or-v1-fake` (a bare assignment does not reach `control-jev`). Count lines in `$VERIFY_HOME/.claude/jev-calls.jsonl`, run `CLAUDE_PLUGIN_OPTION_PROMPTROUTER=false control-jev hook prompt_router '{"prompt":"where is the retry timeout set?","transcript_path":""}'`, and count again. Exit code `0`, stdout empty, and no line added. The same run without the variable adds one line (a failed call on the fake key), which proves the count can move. Save both counts as `prompt-routing/toggle-off.txt`. Run `unset OPENROUTER_API_KEY` afterward; the no-key recipes need it unset.
- **Live hint (out-of-band; needs a real `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, not Claude Code).** Feed a classifiable prompt with a real key in the environment: `control-jev hook prompt_router '{"prompt":"where is the retry timeout set?","transcript_path":""}'`. Exit `0` and stdout is `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[jev router] intent=lookup conf=0.96 scope=small\nFact-finding — one targeted search, concise answer, then stop."}}`. The hint appears only when the intent is `chat`, `lookup`, or `fix` (the whole of `GUIDANCE`) at confidence ≥ 0.75. An intent of `feature` or `ops` gets **no** hint however confident it is, and a `chat` hint appears only through the `needs_tools <= MAX_QUIET` (0.10) override, which rewrites the choice to `chat` at `conf = 1 - needs_tools`. `"fix the typo in the README title"` gives `intent=fix` at `scope=trivial` with ` Keep it minimal.` appended. Save the command, the JSON, and the matching `prompt` row in `jev-router-log.jsonl` as `prompt-routing/live-hint.txt`.
- **Proof.** Save the four transcripts and the toggle counts. Run `control-jev save prompt-routing/skip-short.txt -` (and likewise for the other three) with each command's `exit=` line and stdout length. Artifacts show exit `0` and empty bodies for every case. `prompt-routing/toggle-off.txt` shows 0 calls with the toggle off and 1 with it on.

## Gotchas

- Live classify with a real hint is **out-of-band** (needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`). In-band proof is skip + fail-open only.
- A classifiable prompt with a live key writes `jev-router-log.jsonl` under the disposable verify home only — still isolate.
- Do not treat empty stdout with a live key as proof the router is broken; confidence below `0.75`, or a `feature` / `ops` intent, also suppresses the hint, so a row can land in `jev-router-log.jsonl` with an answer and still print nothing.
- The router asks three questions (`intent`, `scope`, `needs_tools`). A log row with a `model_tier` answer, or with `tier_hint` / `model_now` fields, predates 0.25.0.
- The toggle count rises by exactly one row per hook run on a fake key. The hook calls Jev through `adapters/afk/src/shared/jev-client.ts`, which makes one attempt and logs one row whether the call fails with `HTTP 401` or a network error. The retry-once under `FAST_FAIL` lives only in `scripts/jev.py`, which no hook uses. Assert "stays flat" with the toggle off and "rises" with it on.
- Synthetic prompts are skipped by a case-insensitive prefix regex (`SYNTHETIC` in `adapters/afk/src/shared/synthetic.ts`), not by anything in the event. Read that regex for the full list rather than a copy here: it covers agent and session message injections (`Another Claude session sent a message:`, `Fabric actor message from`), skill and workspace banners, continuation and compaction-summary requests, security-review prompts, `Permission granted for:`, `[Image:`, `[Request interrupted`, `[Usage limit approaching`, and `reply with exactly:`. Any prompt whose first 200 characters contain `<teammate-message` or `<agent-message` also skips. A skipped synthetic prompt exits `0` with empty stdout and writes no log row — it is not a routing failure.
- An empty or missing `transcript_path` does not skip the router: it classifies the prompt with an empty conversation tail, so a router proof needs no transcript. A row for an event without `session_id` or `cwd` omits those keys entirely (it does not write `null`).
- `#`-prefixed prompts (memory shortcuts) skip alongside slash commands: the guard is `prompt[0] in "/#"`.
- The classifier also reads a conversation tail: the last 400 transcript lines supply the previous user message (≤300 chars) and the last assistant reply (≤600 chars) as Jev state. An empty `transcript_path` still classifies, on the prompt alone.
- `scope >= 1.5` appends ` Sketch the plan in a few bullets first.` to the hint — the mirror of the ` Keep it minimal.` trivial suffix. The row's `hint` field shows the exact emitted string.
