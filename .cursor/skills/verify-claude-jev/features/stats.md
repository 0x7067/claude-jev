# Stats

`scripts/stats.py` scores the hooks' live decisions against what the
sessions did: router hints against the tools used, rule calibration, rule
outcomes, Jev call latency, and compaction re-fetches. Users read it in the
Stats row of the `/claude-jev` pane; `python3 scripts/stats.py` prints the same
report.

## Sub-features

- `stats-empty` says no decisions are logged yet when the home has no logs.
- `stats-report` (needs real decision rows, not Claude Code) prints the router, rule, call, and compaction sections.

## How to get to it (user POV)

- Open `/claude-jev` and press Enter on Stats; PgUp/PgDn scroll the report.
- Run `python3 scripts/stats.py [--days N] [--examples N]` from a checkout.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.

- **Empty home.** Run `control-jev stats` right after launch. Exit code `0` and stdout starts with `No decisions logged yet at $VERIFY_HOME/.claude/jev-router-log.jsonl.` (the path ends with a period) followed by `The hook writes one line per prompt. Use Claude Code for a while, then re-run.`
- **The empty test is router-log only.** `stats` bails when the *router* log has no rows in the window, so a home whose `jev-calls.jsonl` and `jev-compact-log.jsonl` are full but whose `jev-router-log.jsonl` is missing still prints the two-line message and never reaches the call, rule-outcome, or compaction sections. A `--days` window that matches nothing looks identical, and `--days 0` means **no cutoff** (falsy), not "today".
- **Report over real rows.** The other recipes in this skill fill `$VERIFY_HOME/.claude/` with genuine router, subagent, rules, call, and compaction rows, so once a few of them have run the report is drivable with no Claude Code: `control-jev stats -- --days 7`. Exit `0`, and stdout carries, in order: the "N decisions logged" header with `hints injected` and `suppressed` (plus `Nothing scorable yet — come back after a few more sessions.` when nothing scored); `Model tier (cheapest tier Jev thinks each prompt needs):`; `Rule calibration (N checks logged):` with one row per rule id and a verdict column; `Jev calls (N logged at <path>):` with one row per caller, then `Failures by caller (...)` when any call failed; `Rule outcomes (what happened after an edit was blocked):`; and `Compaction (N logged at <path>):` with `median reduction`, `median ms`, `triggers`, and per-row `dropped` / `truncated` re-fetch counts. A rule judged fewer than 5 times shows `skipped (need 5)` instead of a verdict. There is no "most recently blocked rule" line.
- **Proof.** Save stdout and the exit code as `stats/empty.txt`, and the full report as `stats/report.txt`.

## Gotchas

- Flags are `--log PATH` (default: the router log), `--days N`, and `--examples N`.
  `--log` redirects **only** the router log: the calls, compaction, and transcript
  paths are fixed to `config_dir()`, so pointing `--log` elsewhere does not isolate
  a report — pin `CLAUDE_CONFIG_DIR` (or use `control-jev`, which pins it) instead.
- `control-jev stats` reads the isolated home, not `~/.claude`; a real report needs real logs, so `stats-report` is out-of-band.
- `--examples N` lists up to N scored-intent mismatches and nothing else changes; the default 0 omits the block. It is not clamped.
- The report's header line is the wording the empty-home case does NOT print, and vice versa — assert on the first line to tell them apart.
- `Failures by caller` counts failed calls, not HTTP status codes, and a failed call still costs a `jev-calls.jsonl` row: a fake-key toggle proof shows up as `HTTP 401` failures in the report of the same home.
- Rows written by hand-fed test events have no transcript behind them, so rule outcomes report them as `unscorable: no transcript for the session` rather than repaired or ignored.
- Stats only reads logs; it never calls Jev.
