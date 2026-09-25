# Prompt routing

Prompt routing classifies each user prompt on `UserPromptSubmit` and may inject
a short routing hint (one or two lines). Short prompts, slash and `#` commands,
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
- **Live hint (out-of-band; needs a real `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, not Claude Code).** Feed a classifiable prompt with a real key in the environment. At confidence ≥ 0.75 exit is `0` and stdout is `{"systemMessage": "[jev router] model=<tier> conf=<0.xx> — ..."}`, where `<tier>` is one of `haiku|sonnet|opus|fable`. A guidance line is a **different** condition: `hookSpecificOutput.additionalContext` appears only when the intent is `chat`, `lookup`, or `fix` (the whole of `GUIDANCE`) and clears the floor, and it is two lines — `[jev router] intent=<x> conf=<0.xx>[ scope=<y>]` plus a tip. An intent of `feature` or `ops` gets **no** guidance line however confident it is, and a `chat` line appears only through the `needs_tools <= MAX_QUIET` (0.10) override, which rewrites the choice to `chat` at `conf = 1 - needs_tools`. A probe that logged intent `chat` at conf 0.35 satisfied none of these and printed only the tier line. Save the command, the JSON, and the matching `prompt` row in `jev-router-log.jsonl` as `prompt-routing/live-hint.txt`.
- **Proof.** Save the four transcripts and the toggle counts. Run `control-jev save prompt-routing/skip-short.txt -` (and likewise for the other three) with each command's `exit=` line and stdout length. Artifacts show exit `0` and empty bodies for every case. `prompt-routing/toggle-off.txt` shows 0 calls with the toggle off and 1 with it on.

## Gotchas

- Live classify with a real hint is **out-of-band** (needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`). In-band proof is skip + fail-open only.
- A classifiable prompt with a live key writes `jev-router-log.jsonl` under the disposable verify home only — still isolate.
- Do not treat empty stdout with a live key as proof the router is broken; confidence below `0.75` also suppresses the hint. The tier question and the intent question each have their own `0.75` floor, so a row can land in `jev-router-log.jsonl` with an answer and still print nothing.
- The toggle count normally rises by exactly one row on a fake key, because an `sk-or-` key reaches OpenRouter and comes back `HTTP 401`, which is logged once and not retried. Do not hard-code `+1`: `jev.ask` retries a network failure that returns under `FAST_FAIL` (1.0 s) and logs one row per attempt, so on a host with no DNS or a refused connection the same recipe adds **two** rows. Assert "the count rises" off, "stays flat" on.
- Synthetic prompts are skipped by prefix match (`observed.is_synthetic`), not by anything in the event: teammate/agent message injections, skill base-directory banners, "Continue from where you left off", the compaction-summary request ("Your task is to create a detailed summary"), `[Image:`, `[Request interrupted`, and `reply with exactly:` all skip, as does any prompt whose first 200 characters contain `<teammate-message` or `<agent-message>`. A skipped synthetic prompt exits `0` with empty stdout and writes no log row — it is not a routing failure.
- An empty or missing `transcript_path` does not skip the router: it classifies the prompt with an empty conversation tail. The row it logs then has `session_id: null` and `cwd: null`, so a router proof needs no transcript.
- `#`-prefixed prompts (memory shortcuts) skip alongside slash commands: the guard is `prompt[0] in "/#"`.
