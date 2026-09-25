# Session compaction

Session compaction replaces Claude Code's built-in summary when function hooks
are enabled. The Python bridge `compactor.py rows` reads a `session.compact`
event on stdin and prints either `{"messages": ...}` or `{"fallback": ...}`.
Failures must fall back, never leave the session uncompacted.

## Sub-features

- `rows-fallback-bad` answers `fallback` and exit 0 on unreadable input.
- `rows-fallback-shape` names which `fallback` reason each bad input produces, all exit 0.
- `rows-usage-exit` exits 2 with a stderr usage line when the `rows` argv is absent.
- `rows-pin-tail` keeps sessions with ≤4 judgeable rows without calling Jev.
- `rows-pin-heads` truncates a long pinned row to `KEEP_CHARS` in that same no-call path.
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
- `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, and `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`
  are all unset for `rows-fallback-no-key` (in-band). The third is the pane-saved
  key, and it wins on its own: with only it set, `status` reports `"key": "saved"`
  and this fixture stops being a no-key proof.

- **Bad input fallback.** Feed empty stdin. Run `printf '' | control-jev rows`. Exit code `0` and stdout is JSON containing `"fallback"`.
- **Three bad-input reasons.** Assert on `fallback`, never on the word `unreadable`, which only appears in the first: `''` / non-JSON → `unreadable event: <json error>`; `[]` or `null` (valid JSON, not an object) → `event is not an object`; a non-iterable `messages` such as `{"messages":5}` → `compactor.py: 'int' object is not iterable`; `{}` → `no judgeable rows`. All four exit `0`.
- **Usage exit.** Run `python3 scripts/compactor.py` with the `rows` argv missing (under the run's `HOME`). Exit code **2** with stderr `usage: compactor.py rows  (reads a session.compact event on stdin)` — the only non-zero exit in the script.
- **Pin-tail keep.** Feed two plain messages (under the pin-tail window). Write the event and run `control-jev rows "$EVENT_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"'"$CLAUDE_PLUGIN_ROOT"'","session_id":"verify-compact","messages":[{"role":"user","text":"hello world this is a real prompt"},{"role":"assistant","text":"hi there","toolUses":[],"toolResults":[]}]}`.
  Exit code `0`. Stdout JSON has `messages` whose texts include the fixed compaction header and both original strings, and a `summary` mentioning `manual compaction` — the observed line is `manual compaction replaced by 3 rows (kept 2, 0 truncated, 0% smaller, 0 ms)`. Count `messages` as `kept + 1`: element 0 is always the injected header, role `user`, whatever the first real row was. A kept row that carried no `toolUses`/`toolResults` and survived byte-for-byte comes back as **the same object**, extra keys intact (give one row `"handle":"h-1"` and `handle` is in its output keys with no `toolUses` added); tool rows are rebuilt as text with `[tool_use …]` / `[tool_result]` markup instead. `instructions` is **not** observable here — send the event with and without it and stdout is byte-identical, because the directive only enters the Jev request state and no request is made; `trigger` is the one field that reaches `summary` (drop it and the line starts `compaction replaced by …`, and any host string interpolates, e.g. `auto compaction …`). Prove the "no Jev call" half properly: run the same event with `OPENROUTER_API_KEY=sk-or-v1-fake` exported and confirm the line count of `$VERIFY_HOME/.claude/jev-calls.jsonl` does not move. A run with both keys unset proves nothing there — `jev.ask` raises before the HTTP request, so a call that never happened also logs nothing. Do read `$VERIFY_HOME/.claude/jev-compact-log.jsonl`: a keep appends a `"source": "rows"` row **even with zero Jev calls**, so that file is evidence, not a live-call counter.
- **Pinned-row truncation (in-band, no key).** Send two rows where one `text` is ~2000 characters. With no call made, that row comes back cut to `KEEP_CHARS` (1500) plus a trailing `[… <n> chars elided by jev-compact — re-read the file or re-run the command if needed]`, and `summary` reports a non-zero `% smaller` while `truncated` stays **0**, because pinned rows are kept whole-in-kind. This is the only place the elision marker is reachable without a key; every other fixture here uses short strings.
- **No-key multi-row fallback.** With `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` unset, feed **five** judgeable plain messages so at least one falls outside `PIN_TAIL` (4) and must be scored. Write the event and run `control-jev rows "$NOKEY_FILE"` with:
  `{"trigger":"manual","instructions":null,"cwd":"'"$CLAUDE_PLUGIN_ROOT"'","session_id":"verify-compact-nokey","messages":[{"role":"user","text":"turn one needs a real sentence"},{"role":"assistant","text":"reply one needs a real sentence","toolUses":[],"toolResults":[]},{"role":"user","text":"turn two needs a real sentence"},{"role":"assistant","text":"reply two needs a real sentence","toolUses":[],"toolResults":[]},{"role":"user","text":"turn three needs a real sentence"}]}`.
  Exit code `0`. Stdout is JSON whose **only** top-level key is `"fallback"`, with the reason exactly `jev: every chunk failed` — not a `messages` replacement, and no mention of a key. That reason is cause-blind: a rejected key or a timed-out chunk produces the same string, so it proves "Jev did not answer", never "why". Only `SKILL.md` quotes it correctly; do not rewrite it as a missing-key message.
- **Proof.** Save pin-tail stdout as `session-compaction/rows-out.json` via `control-jev save session-compaction/rows-out.json -`. Save bad-input fallback as `session-compaction/fallback.json`. Save the no-key multi-row stdout as `session-compaction/fallback-nokey.json` via `control-jev save session-compaction/fallback-nokey.json -`. The last artifact contains `"fallback"` and does not contain a top-level `"messages"` array of kept rows.

## Gotchas

- Newest `PIN_TAIL` (4) rows are never judged; a short fixture proves the bridge without an API key (in-band). Five or more **judgeable** rows force a Jev call — `PIN_TAIL + 1` is the real threshold, and it counts judgeable rows, not messages, so a fixture needs five rows that survive `judgeable()`. Without the key that is the `rows-fallback-no-key` path.
- Only 300 blocks reach judging at all: the newest `MAX_BLOCKS` (150) get the full check set and the `RESCUE_BLOCKS` (150) before them get the constraint check alone, so a fixture long enough to cross 300 blocks exercises a path these recipes never touch. `rows()` itself keeps only the newest 300 judgeable rows, and the pin tail is the newest 4 *judgeable* rows, not the last 4 messages.
- The check set is **five** (`constraint`, `decision`, `error`, `open`, `rerunnable`); four of them (`KEEP_CHECKS`) feed the keep score and `rerunnable` only silences `error`. `compactor.py`'s own "full four checks" docstring is stale — do not copy the count from it.
- One-word acks (`ok`, `yes`, `no`, `thanks`, `continue`, optional trailing `.`) are not judgeable — but the filter is **role-gated to `user`**, so an assistant `"ok"` **is** judgeable and gets kept. A whole-assistant-ack fixture never yields `no judgeable rows`. `fullmatch` also means `"ok ok"` is judgeable while `"no."` is not; use full sentences in the no-key fixture.
- A live Claude Code `/compact` through `hooks/register.ts` is **out-of-band** (needs Claude Code 2.1.278+, function hooks, trusted workspace). The stdin `rows` bridge is the in-band path. The bridge returns only `messages` to Claude Code — the `summary` string exists solely on the bridge's stdout and in the debug log — so an out-of-band proof must assert on the log line. Two lines, both printed by Claude Code rather than the plugin, carry the whole verdict; a four-turn session then `/compact` produced:
  `[claude-jev] $.ui.log: jev-compact: manual compaction replaced by 9 rows (kept 8, 0 truncated, 55% smaller, 331 ms)` and
  `session.compact (manual): a hook's 9 messages stand (hooked by claude-jev+compact-adviser); core never ran`.
  "core never ran" **is** the pass condition. `register.ts`'s other wording, `<reason>; built-in summary runs`, means the bridge ran and gave up — it is not what a disabled toggle looks like. A second `/compact` over the same content reported `0 ms`: that is the answer cache, not a broken timing.
- **The `compaction` toggle is not enforced in Python.** The other three hooks call `jev.enabled(field)`; `compactor.py` has no such gate — `register.ts` returns `next(e)` before the bridge runs. So `CLAUDE_PLUGIN_OPTION_COMPACTION=false` fed to `control-jev rows` still tries Jev (verified: same `jev: every chunk failed`), and no in-band recipe can prove that toggle. Do not write "toggle off → no call" for compaction; it is only true end-to-end through a real session, and it was proved there once: with `pluginConfigs["claude-jev@claude-jev"].options.compaction` set to `false` by the pane, `/compact` logged **no** `jev-compact` line at all (register.ts:414 returns `next(e)` before the `$.ui.log` at 416), and restoring it to `true` brought both lines back (`replaced by 4 rows (kept 3, …)`, `core never ran`). So treat plugin silence as the off signal and a logged fallback as a failure — reading them the other way round would call a broken bridge a disabled one.
- Cleanup must not delete `artifacts/<RUN_ID>/session-compaction/`.
- Skipping `eval "$(control-jev env)"` leaves `$CLAUDE_PLUGIN_ROOT` empty in the event `cwd`.
