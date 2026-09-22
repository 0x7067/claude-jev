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
  and the plugin loaded (module calls `compactor.py rows`) — **out-of-band**.
- Drive the bridge directly for in-band verification without Claude Code.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` so `$CLAUDE_PLUGIN_ROOT` is set for the event `cwd`.

- **Bad input fallback.** Feed empty stdin. Run `printf '' | control-jev rows`. Exit code `0` and stdout is JSON containing `"fallback"`.
- **Pin-tail keep.** Feed two plain messages (under the pin-tail window). Write the event and run `control-jev rows "$EVENT_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"'"$CLAUDE_PLUGIN_ROOT"'","session_id":"verify-compact","messages":[{"role":"user","text":"hello world this is a real prompt"},{"role":"assistant","text":"hi there","toolUses":[],"toolResults":[]}]}`.
  Exit code `0`. Stdout JSON has `messages` whose texts include the fixed compaction header and both original strings, and a `summary` mentioning `manual compaction`.
- **Proof.** Save stdout as `session-compaction/rows-out.json` via `control-jev save session-compaction/rows-out.json -`. The artifact contains `"hello world this is a real prompt"` and `"hi there"`. Also save the bad-input fallback line as `session-compaction/fallback.json`.

## Gotchas

- Newest `PIN_TAIL` (4) rows are never judged; a short fixture proves the bridge without an API key (in-band).
- One-word acks (`ok`, `yes`, …) are not judgeable and can yield `fallback: no judgeable rows`.
- A live Claude Code `/compact` through `hooks/register.ts` is **out-of-band** (needs Claude Code 2.1.278+, function hooks, trusted workspace). The stdin `rows` bridge is the in-band path.
- Cleanup must not delete `artifacts/<RUN_ID>/session-compaction/`.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty in the event `cwd`.
