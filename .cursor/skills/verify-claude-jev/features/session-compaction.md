# Session compaction

Session compaction replaces Claude Code's built-in summary when function hooks
are enabled. The Python bridge `compactor.py rows` reads a `session.compact`
event on stdin and prints either `{"messages": ...}` or `{"fallback": ...}`.
Failures must fall back, never leave the session uncompacted.

## Sub-features

- `rows-fallback-bad` answers `fallback` and exit 0 on unreadable input.
- `rows-pin-tail` keeps sessions with ≤4 judgeable rows without calling Jev.
- `rows-fallback-no-key` answers `fallback` with a Jev error when more than
  `PIN_TAIL` rows need judging and both `TYPESAFE_API_KEY` and
  `OPENROUTER_API_KEY` are unset.

## How to get to it (user POV)

- Run `/compact` in Claude Code 2.1.278+ with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
  and the plugin loaded (module calls `compactor.py rows`) — **out-of-band**.
- Drive the bridge directly for in-band verification without Claude Code.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` so `$CLAUDE_PLUGIN_ROOT` is set for the event `cwd`.
- `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` are unset for `rows-fallback-no-key` (in-band).

- **Bad input fallback.** Feed empty stdin. Run `printf '' | control-jev rows`. Exit code `0` and stdout is JSON containing `"fallback"`.
- **Pin-tail keep.** Feed two plain messages (under the pin-tail window). Write the event and run `control-jev rows "$EVENT_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"'"$CLAUDE_PLUGIN_ROOT"'","session_id":"verify-compact","messages":[{"role":"user","text":"hello world this is a real prompt"},{"role":"assistant","text":"hi there","toolUses":[],"toolResults":[]}]}`.
  Exit code `0`. Stdout JSON has `messages` whose texts include the fixed compaction header and both original strings, and a `summary` mentioning `manual compaction`.
- **No-key multi-row fallback.** With `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` unset, feed **five** judgeable plain messages so at least one falls outside `PIN_TAIL` (4) and must be scored. Write the event and run `control-jev rows "$NOKEY_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"'"$CLAUDE_PLUGIN_ROOT"'","session_id":"verify-compact-nokey","messages":[{"role":"user","text":"turn one needs a real sentence"},{"role":"assistant","text":"reply one needs a real sentence","toolUses":[],"toolResults":[]},{"role":"user","text":"turn two needs a real sentence"},{"role":"assistant","text":"reply two needs a real sentence","toolUses":[],"toolResults":[]},{"role":"user","text":"turn three needs a real sentence"}]}`.
  Exit code `0`. Stdout is JSON containing `"fallback"` and a reason that mentions `jev` (missing key / Jev error) — not a `messages` replacement.
- **Proof.** Save pin-tail stdout as `session-compaction/rows-out.json` via `control-jev save session-compaction/rows-out.json -`. Save bad-input fallback as `session-compaction/fallback.json`. Save the no-key multi-row stdout as `session-compaction/fallback-nokey.json` via `control-jev save session-compaction/fallback-nokey.json -`. The last artifact contains `"fallback"` and does not contain a top-level `"messages"` array of kept rows.

## Gotchas

- Newest `PIN_TAIL` (4) rows are never judged; a short fixture proves the bridge without an API key (in-band). Five or more judgeable rows force a Jev call — without the key that is the `rows-fallback-no-key` path.
- One-word acks (`ok`, `yes`, …) are not judgeable and can yield `fallback: no judgeable rows` instead of a Jev error; use full sentences in the no-key fixture.
- A live Claude Code `/compact` through `hooks/register.ts` is **out-of-band** (needs Claude Code 2.1.278+, function hooks, trusted workspace). The stdin `rows` bridge is the in-band path.
- Cleanup must not delete `artifacts/<RUN_ID>/session-compaction/`.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty in the event `cwd`.
