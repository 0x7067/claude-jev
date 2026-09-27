# eval

Three things get measured here: the routing hint, the subagent tier, and the
rule hook. They share nothing but the Jev client.

| Path | What it is | In git |
|---|---|---|
| `rules_eval.py` | Judges edits through the same `judge_edit` the hook calls | yes |
| `variants.py`, `replay.py`, `compare.py` | Router eval | yes |
| `subagent_eval.py` | Subagent tier against the model you named yourself | yes |
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

**Stop-hook turns.** `turns` reads the live log and transcripts, and asks Jev nothing. It splits every Stop-hook check by what that turn did since the user's prompt: its own edits, only Bash, or nothing. A check on a turn with no edits of its own judged an earlier turn's work (`docs/stop-hook-false-positive.md`).

```bash
python3 eval/rules_eval.py turns
```

Answers cache in `data/rules_cache.jsonl`, keyed by model, state and questions,
so re-running after an unrelated change costs nothing.

The calibration table at the end lists every rule's checks, median and max
probability, and fire count. A rule firing on most edits is too broad; a rule
that never clears the flag band is not earning its slot.

## The subagent tier

`extract` collects every Agent or Task spawn in `~/.claude/projects` whose
input names a model. That model is the label: it is what you picked for that
brief. `run` asks the shipped `subagent_bundle` about a seeded sample.
`report` lands every spawn on a concrete tier: the routed one, or the parent's
model when the gate holds back, since an unrouted spawn inherits it. It counts
matches, too-cheap picks (the costly miss), and too-dear picks.

```bash
python3 eval/subagent_eval.py extract
CLAUDE_PLUGIN_OPTION_PROVIDER=openrouter python3 eval/subagent_eval.py run --sample 300 --seed 0
python3 eval/subagent_eval.py report
```

The 2026-09-27 run on 300 spawns (labels: 156 sonnet, 96 opus, 25 haiku, 23
fable; parents: fable or opus):

| Gate | Routed | Match | Too cheap | Too dear |
|---|---|---|---|---|
| margin >= 0.75 (0.24.0) | 110 | 92 | 50 | 158 |
| top probability >= 0.70 | 160 | 114 | 65 | 121 |
| cumulative risk <= 0.10 (shipped) | 300 | 160 | 51 | 89 |
| cumulative risk <= 0.20 | 300 | 173 | 70 | 57 |
| argmax | 300 | 148 | 125 | 27 |

The cumulative rule picks the cheapest tier where the chance that the task
needs a stronger one is at most 0.10. Jev's argmax leans cheap: it called 47
of 96 opus-labelled briefs sonnet and 43 of 156 sonnet-labelled briefs haiku.
The rule offsets that lean; it does not remove it.

`run --variant judgment` asks with tier text rewritten toward the user's own
delegation rules: judgment-heavy work such as grading, verifying, auditing,
and analysis is opus even when it edits nothing. On all 300 spawns it trades
one lean for the other. Opus-labelled briefs called opus rise from 30 to 57
of 96, but sonnet-labelled briefs called opus rise from 22 to 59 of 156, and
fable-labelled briefs called fable fall from 3 to 0 of 23. No gate on the
rewrite beats the shipped text under the shipped gate (160 matches, 51 too
cheap, 89 too dear):

| Rewrite, gate | Match | Too cheap | Too dear |
|---|---|---|---|
| cumulative risk <= 0.10 | 146 | 46 | 108 |
| cumulative risk <= 0.20 | 156 | 54 | 90 |
| argmax | 161 | 76 | 63 |

The first 100 spawns alone showed a tie (54, 13, 33 against 55, 14, 31); the
full 300 do not. The shipped text stays.

```bash
CLAUDE_PLUGIN_OPTION_PROVIDER=openrouter python3 eval/subagent_eval.py run --variant judgment --sample 100 --seed 0
python3 eval/subagent_eval.py report --variant shipped --variant judgment
```

Limits: the numbers are in-sample, with no holdout. The labelled spawns are
the ones the router never touches live, because an explicit model wins. So
this measures agreement on your own choices as a stand-in for the unlabelled
spawns the hook actually routes.

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
