# Stats

`scripts/stats.py` scores the hooks' live decisions against what the
sessions did: router hints against the tools used, rule calibration, rule
outcomes, Jev call latency, and compaction re-fetches. Users read it in the
Stats row of the `/claude-jev` pane; `python3 scripts/stats.py` prints the same
report.

## Sub-features

- `stats-empty` says no decisions are logged yet when the home has no logs.
- `stats-report` (out-of-band; needs real logs) prints the router, rule, call, and compaction sections.

## How to get to it (user POV)

- Open `/claude-jev` and press Enter on Stats; PgUp/PgDn scroll the report.
- Run `python3 scripts/stats.py [--days N] [--examples N]` from a checkout.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.

- **Empty home.** Run `control-jev stats` right after launch. Exit code `0` and stdout starts with `No decisions logged yet at $VERIFY_HOME/.claude/jev-router-log.jsonl`.
- **Proof.** Save stdout and the exit code as `stats/empty.txt`.

## Gotchas

- `control-jev stats` reads the isolated home, not `~/.claude`; a real report needs real logs, so `stats-report` is out-of-band.
- Stats only reads logs; it never calls Jev.
