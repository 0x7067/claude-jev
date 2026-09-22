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
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

A record's `sha` is the commit it is judged at: `run` checks that commit out
as a detached worktree under `data/at/` and reads rules and file contents
from there, so editing a repo's rules does not move old numbers. `extract`
stamps each edit with the repo's HEAD; a hand-written case carries the sha
its rule was written against. A record without a sha is judged at the live
checkout. `~/.claude/CLAUDE.md` has no sha, so the committed copy at
`eval/global_CLAUDE.md` stands in for it.

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
