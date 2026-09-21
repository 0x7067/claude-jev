# eval

Two things get measured here: the routing hint and the rule hook. They share
nothing but the Jev client.

## Layout

| Path | What it is | In git |
|---|---|---|
| `rules_corpus.jsonl` | Rules and the needles that violate them | yes |
| `rules_stress.py` | Turns the corpus into cases and writes the fixture rules | yes |
| `rules_eval.py` | Judges cases and real edits, then reports | yes |
| `fixtures/` | Host repos the cases land in | yes |
| `variants.py`, `replay.py`, `compare.py` | Router eval | yes |
| `audit_labels.json` | Hand labels for the router eval | yes |
| `private/` | Corpora that need repos not in this repo | no |
| `data/` | Generated cases, predictions, caches | no |

## The public rule corpus

One row per rule. A row with `bad`, `good` and `task` also carries a needle;
a row with `kind: "distractor"` carries only a rule, so the judge has to weigh
rules that nothing in the edit violates. A row with `rule_ref` hangs another
needle off an existing rule without restating it.

### Two modes

The same corpus runs two ways, and they answer different questions.

**Integration (default).** Every rule in the fixture is in scope, so the judge
weighs the whole instruction file against one edit. This is what the hook
actually does. A benign twin blocked here is a real false positive — which
means a twin has to be clean against *every* rule in its fixture, not just the
one it is paired with. Adding a rule can silently break twins written earlier.

**Isolated (`--isolated`).** Each pair is judged against its own rule and
nothing else. This scores the rule and its needle on their own, the way a unit
test scores one function. Cross-rule interference cannot reach it, so a miss
here is the rule's wording or the needle's subtlety, never competition.

Run integration to know what ships. Run isolated to find which rule is weak.

```bash
python3 eval/rules_stress.py
HOME=/tmp/jev-home python3 eval/rules_eval.py run \
  --cases eval/data/rules_stress.jsonl --cases-only \
  --out eval/data/rules_stress_pred.jsonl
python3 eval/rules_eval.py report --pred eval/data/rules_stress_pred.jsonl --by-tag
```

Point `HOME` at a scratch directory. `rules.load_rules()` also reads
`~/.claude/CLAUDE.md`, so your own global rules would otherwise join every
fixture and the numbers would differ per machine.

Adding a language means adding rows with a new `lang`, host files under
`eval/fixtures/<lang>/`, and an entry in `EXTENSIONS`. Nothing else in the
harness is per-language.

## The private corpora

Two corpora cannot be committed, for the same reason: they judge edits inside
real repos, and the judge needs those repos on disk to read their instruction
files.

- `private/rules_cases.jsonl` — hand-written violations of the real rules in
  the author's own repos, each paired with a compliant near-miss. `run` picks
  it up automatically when present and says so and carries on when it isn't.
- `data/rules_edits.jsonl` — every edit in your local transcripts, via
  `rules_eval.py extract`. Those edits were accepted at the time, so a block
  is a false positive under the repo's current instruction files. Only edits
  whose `cwd` still exists can be judged.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

Run these with your real `HOME`: for real edits, your global rules are part of
the rule set the hook would actually apply.

## Reading the report

`--by-tag` cuts detection and false blocks by needle, form (Edit vs Write),
host file size, and insert position. The calibration table at the end lists
every rule's checks, median and max probability, and fire count — a rule that
fires on most edits is too broad, and a rule that never clears the flag band
is not earning its slot.
