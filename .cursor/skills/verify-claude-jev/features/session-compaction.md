# Session compaction

Session compaction replaces Claude Code's built-in summary when function hooks
are enabled. The Python bridge `compactor.py rows` reads a `session.compact`
event on stdin and prints either `{"messages": ...}` or `{"fallback": ...}`.
Failures must fall back, never leave the session uncompacted.

## Sub-features

- `rows-fallback-bad` answers `fallback` and exit 0 on unreadable input.
- `rows-pin-tail` keeps sessions with ≤4 judgeable rows without calling Jev.
- `rows-fallback-no-key` answers `fallback` with a Jev error when more than
  `PIN_TAIL` rows need judging and `TYPESAFE_API_KEY` is unset.

## How to get to it (user POV)

- Run `/compact` in Claude Code 2.1.278+ with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
  and the plugin loaded (module calls `compactor.py rows`).
- Drive the bridge directly for verification without Claude Code.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.

- **Bad input fallback.** Feed empty stdin. Run `printf '' | control-jev rows`. Exit code `0` and stdout is JSON containing `"fallback"`.
- **Pin-tail keep.** Feed two plain messages (under the pin-tail window). Write the event to a temp file and run `control-jev rows "$EVENT_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"<plugin root>","session_id":"verify-compact","messages":[{"role":"user","text":"hello world this is a real prompt"},{"role":"assistant","text":"hi there","toolUses":[],"toolResults":[]}]}`.
  Exit code `0`. Stdout JSON has `messages` whose texts include the fixed compaction header and both original strings, and a `summary` mentioning `manual compaction`.
- **Proof.** Save stdout as `session-compaction/rows-out.json` via `control-jev save session-compaction/rows-out.json -`. The artifact contains `"hello world this is a real prompt"` and `"hi there"`. Also save the bad-input fallback line as `session-compaction/fallback.json`.

## Gotchas

- Newest `PIN_TAIL` (4) rows are never judged; a short fixture proves the bridge without an API key.
- One-word acks (`ok`, `yes`, …) are not judgeable and can yield `fallback: no judgeable rows`.
- A live Claude Code proof needs function hooks and a trusted workspace; the stdin bridge is the supported agent path when `claude` is unavailable.
- Cleanup must not delete `artifacts/<RUN_ID>/session-compaction/`.
