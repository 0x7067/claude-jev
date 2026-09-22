# Prompt routing

Prompt routing classifies each user prompt on `UserPromptSubmit` and may inject
a one-line routing hint. Short prompts, slash commands, and failures must never
block the session.

## Sub-features

- `router-skip-short` ignores prompts under three characters with no stdout.
- `router-skip-slash` ignores slash commands with no stdout.
- `router-fail-open` exits 0 with empty stdout on malformed input or missing API key.

## How to get to it (user POV)

- Type a normal prompt in Claude Code with the plugin installed (hook runs automatically).
- Type `/help` or a two-letter prompt (hook skips locally).
- Run with `TYPESAFE_API_KEY` unset (hook disables silently).

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable `HOME` is set by `control-jev launch`.

- **Skip short.** Feed a two-character prompt. Run `control-jev hook prompt_router '{"prompt":"hi","transcript_path":""}'`. Exit code `0` and stdout empty.
- **Skip slash.** Feed a slash command. Run `control-jev hook prompt_router '{"prompt":"/help","transcript_path":""}'`. Exit code `0` and stdout empty.
- **Fail open empty.** Feed empty stdin. Run `printf '' | control-jev hook prompt_router`. Exit code `0` and stdout empty.
- **Fail open no key.** With `TYPESAFE_API_KEY` unset, feed a classifiable prompt. Run `control-jev hook prompt_router '{"prompt":"where is the retry timeout set?","transcript_path":""}'`. Exit code `0` and stdout empty (Jev call fails and the hook swallows it).
- **Proof.** Save the four transcripts. Run `control-jev save prompt-routing/skip-short.txt -` (and likewise for the other three) with each command's `exit=` line and stdout length. Artifacts show exit `0` and empty bodies for every case.

## Gotchas

- A classifiable prompt with a live key writes `~/.claude/jev-router-log.jsonl` under the disposable `HOME` only — still isolate.
- Do not treat empty stdout with a live key as proof the router is broken; confidence below `0.75` also suppresses the hint.
- Synthetic harness prompts and compaction summary prompts are skipped; do not use them as positive routing cases.
