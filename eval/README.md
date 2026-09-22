# eval

Two things get measured here: the routing hint and the rule hook. They share
nothing but the Jev client.

| Path | What it is | In git |
|---|---|---|
| `rules_eval.py` | Judges edits through the same `judge_edit` the hook calls | yes |
| `variants.py`, `replay.py`, `compare.py` | Router eval | yes |
| `audit_labels.json` | Hand labels for the router eval | yes |
| `private/` | Cases that need repos not in this repo | no |
| `data/` | Extracted edits, predictions, caches | no |

## The rule hook

Both corpora judge edits inside real repos, so the judge can read those repos'
own instruction files. Neither is reproducible from a clone, and neither is
committed.

**Real edits.** `extract` walks `~/.claude/projects` for every Edit and Write
you have made, keeping only the ones the judge can reach: a repo that still
exists, a path the hook does not exclude, inside its own project. Those edits
were accepted at the time, so a block is a false positive under that repo's
current rules. This is the honest false-positive measure.

**Hand-written cases.** `private/rules_cases.jsonl` pairs a violation of a real
rule in one of your repos with a compliant near-miss. `run` picks the file up
when it is there and carries on when it is not.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py pin
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

`pin` records the HEAD of every repo the corpora reference in
`private/pins.json`. `run` then judges each edit from a detached worktree of
that commit under `data/pinned/`, so rules edited in a live checkout do not
move the numbers until you `pin --move <repo>` on purpose (`--move-all` for
every repo). Each prediction records the `sha` it was judged at. Only
committed rules are pinned; a dirty tree is reported. Unpinned repos fall
back to the live checkout.

`~/.claude/CLAUDE.md` is outside any repo, so `pin` snapshots it to
`eval/global_CLAUDE.md` (committed) and `run` reads the snapshot instead of
the live file. `pin --move global` refreshes it.

Answers cache in `data/rules_cache.jsonl`, keyed by model, state and questions,
so re-running after an unrelated change costs nothing.

The calibration table at the end lists every rule's checks, median and max
probability, and fire count. A rule firing on most edits is too broad; a rule
that never clears the flag band is not earning its slot.

## The router

`replay.py` replays your past prompts through the router and scores each
prediction against what the session did next. `compare.py` pairs the plugin
against default Claude Code on the same transcripts.

```bash
python3 eval/replay.py extract
python3 eval/replay.py run --variant v7_no_unclear
python3 eval/replay.py report --variant v8_tier --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai`. Start with `--sample 250`
if that matters for your repos.
