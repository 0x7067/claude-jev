# Compaction: current state and remaining design

`scripts/compactor.py` replaces Claude Code's LLM summary with a selection of
verbatim transcript blocks chosen by Jev. This document records what the
selection does today, what is measured, and the work that is designed but
not built, in priority order. `AGENTS.md` lists the invariants; none of the
proposals below relaxes them. In particular nothing here generates prose:
every kept byte is a transcript byte or a truncated head of one.

Since 0.10.0 the selection runs inside Claude Code's `session.compact`
function hook (`hooks/register.ts` -> `compactor.py rows`) and replaces the
summary outright. "Digest" below means the rows handed back. The harness side
is in `docs/claude-code-compaction-research.md`.

## Current state

### Pipeline

1. `rows` receives the conversation as `session.compact` rows and renders
   each through `row_text`: the same `[tool_use`/`[tool_result]` markers as
   a transcript line, and the same `judgeable` gate (not tagged by
   `META_PREFIXES`, not a one-word ack; the engine already drops `isMeta`
   rows). For the eval, `transcript_blocks` applies the same rules to a
   recorded transcript, plus the harness-injection flags (`injected`) and
   `compaction_marker`, which cuts the pre-0.10 `/claude-jev:compact` turn.
2. `select_blocks` takes the newest `MAX_BLOCKS = 150` blocks. The newest `PIN_TAIL = 4`
   are kept unjudged. The rest are judged in chunks of `BLOCKS_PER_CHUNK = 10`,
   each request carrying a `HEADER_CHARS = 1500` goal header plus only its own
   blocks (`compact_state`), up to `MAX_WORKERS = 16` requests in flight.
3. `keep_questions` asks two `noul` questions per block: still needed, and
   needed verbatim. Keep at `KEEP_THRESHOLD = 0.5`; a low "verbatim" answer
   keeps a `HEAD_CHARS = 400` head plus a re-read pointer. Unscored blocks and
   failed chunks are kept whole.
4. A kept `tool_result` pulls its `tool_use` in.
5. `fit_kept` enforces `TARGET_CHARS = 16000`: downgrade lowest-confidence
   whole keeps to heads, then drop the weakest blocks. Pinned blocks are
   exempt.
6. `rows_out` passes a plain row whose text survived untouched back by
   handle, so the engine restores the original message; tool rows and cut
   blocks return as text rows. Under `MIN_REDUCTION` the bridge answers
   `{"fallback": ...}` and the built-in summary runs.

### Measured baseline

`eval/compare.py compact --synth`, 72 points (12 real, 60 synthetic), cache
keyed on transcript lines plus a hash of `compactor.py`:

| | default: summary + tail | jev: selection digest |
|---|---|---|
| context injected per event | 2.4-5.0k tok | 3.2-3.9k tok |
| time to compact | ~117 s | ~1.3-1.7 s |
| re-fetch coverage | 73-91% mentioned | 76-81% verbatim |

Coverage means: after the compaction point the agent re-fetched a file,
grep, glob or URL it had already fetched; the path string is present in the
injected context (`refetch_default_covered`, `refetch_jev_covered`), or
present in a non-truncated kept block (`refetch_jev_full`).

### What the numbers say about the remaining gap

Two facts drive everything below.

- `TARGET_CHARS = 16000` binds on every long session. `KEEP_CHARS = 1500`
  means ten whole blocks fill the cap, and `PIN_TAIL = 4` whole blocks can
  take 6,000 of the 16,000 chars before any judged block is placed. The
  digest's content is therefore decided mostly by `fit_kept`'s ordering and
  by the pin, not by the keep threshold.
- The two questions do not ask whether a block's content exists anywhere but
  the transcript. Committed code, file contents and command output are on
  disk; reasoning, rejected alternatives and unverified follow-ups are not.
  The selection cannot prefer the second group because it never asks.

## Proposed work, in priority order

| Rank | Item | Value | Complexity |
|---|---|---|---|
| 1 | Question set: `kind` + `recoverable` for prose, `tool_value` for judged tool units, policy table | Decides the digest's content now that the cap binds | question text, ~40 lines in `judge` |
| 2 | Tool units: merge `tool_use`+`tool_result`, classify read/edit tools locally, pointer lines | Halves unit count, removes ~60% of tool questions, raises path coverage cheaply | ~40 lines in `transcript_blocks`/`judge` |
| 3 | `fit_kept` by kind priority, pin capped to heads | Makes the 16k cap spend on reasoning and open threads first | ~15 lines |
| 4 | Stratified `MAX_QUESTIONS`/`REGIONS` budget above `MAX_BLOCKS` | Fair chance for old blocks on sessions past ~350 blocks; bounds cost at any length | ~60 lines |

Items 1-3 change what a bounded digest contains. Item 4 changes which blocks
compete for it. Do 1-3 first; item 4 only pays once 1-3 make an old block
worth judging.

## 1. The question set

Jev sees only `instructions` and `criteria`; key names are invisible. Three
question shapes are available: `noul` (yes/no probability), `choice`
(returns `choice` and `confidence`), `score` (ordered rubric).

### 1.1 Prose units: user prompts and assistant text

Two questions per unit, the same count as today.

```python
f"kind_{i}": {
    "type": "choice",
    "instructions": f"Block [{i}] is one message from a coding session that is "
                    "being compacted. What does it mainly contain?",
    "criteria": {
        "request":    "The user asking for work, setting a goal, or changing direction",
        "decision":   "A choice between approaches with the reason, or an alternative "
                      "considered and rejected",
        "constraint": "A rule, fact, path, version, or limit the work must respect",
        "open":       "A task, check, or follow-up that is promised, deferred, or "
                      "flagged as not yet done or not yet verified",
        "evidence":   "An exact error, test result, or observed behavior that "
                      "explains why something happened",
        "status":     "A report of work already completed, a summary of what was "
                      "just done, or a plan that was then carried out",
        "chatter":    "Acknowledgment, courtesy, or conversation with no lasting content",
    },
},
f"recoverable_{i}": {
    "type": "noul",
    "instructions": f"Could an agent starting fresh in this working directory "
                    f"reconstruct what block [{i}] says by reading the repository, "
                    "running a command, or reading the files it names? Answer yes "
                    "if the content is on disk or reproducible. Answer no if it "
                    "exists only in this conversation, such as a reason, a "
                    "rejected option, a user preference, or a thing left unverified.",
},
```

### 1.2 Judged tool units

One question per unit. Only tool units the local classifier (section 2)
marks `judge` are asked.

```python
f"tool_{i}": {
    "type": "choice",
    "instructions": f"Block [{i}] is a command and its output from a coding session "
                    "being compacted. What is the output worth to an agent "
                    "continuing the work?",
    "criteria": {
        "evidence":   "An error message, failing test, or unexpected result the "
                      "agent would need to see exactly",
        "verified":   "Confirmation that something works or a check passed; the "
                      "fact matters, the full output does not",
        "rerunnable": "Output the agent can regenerate by running the command again",
        "noise":      "Progress output, listings, or installation logs with no "
                      "lasting content",
    },
},
```

### 1.3 Policy table

Four digest forms: **whole** (up to `KEEP_CHARS`), **head** (`truncate_block`,
`HEAD_CHARS` plus pointer), **pointer** (the `[tool_use …]` line only), **drop**.

| `kind` | `recoverable` >= `KEEP_THRESHOLD` | Form |
|---|---|---|
| request | any | whole |
| decision, open | no | whole |
| decision, open | yes | head |
| constraint, evidence | no | whole |
| constraint, evidence | yes | head |
| status | any | head |
| chatter | any | drop |
| unscored (chunk failed, missing answer) | - | whole |

| `tool_value` | Form |
|---|---|
| evidence | whole |
| verified | head |
| rerunnable, noise | pointer |
| unscored | whole |

Confidence rule: a `choice` with `confidence < MIN_CHOICE_CONF` moves one row
toward keeping: `chatter` becomes a `status` head, `rerunnable`/`noise` stay
a pointer (already a keep), `verified` becomes whole. A low-confidence answer
never turns a keep into a drop.

Why a `choice` rather than a third `noul`: `fit_kept` (section 3) needs an
order over kinds, and one choice yields it at the same question cost as the
current pair.

### 1.4 The failure mode to test before shipping the wording

`recoverable` will tend to answer "yes" to assistant reasoning that names
files, because the files are on disk even though the reasoning is not. The
symptom is a long-session digest that is every user prompt whole, plus
pointers, plus nothing the assistant thought. Test: in the eval's digest
composition column (section 6), `decision` + `open` kept chars on sessions
over 100 blocks. If under ~10% of digest chars, lean the wording harder on
"the reason, not the artifact", for example append: "A message that explains
why a file was changed is not recoverable even though the file is."

## 2. Tool units and local classification

### 2.1 Merge

In `transcript_blocks`, merge each `[tool_use …]` block with the
`[tool_result]` that follows it into one unit whose text is the tool line
then the result. This is what the orphan-pairing loop in `judge` approximates
after the fact, and it removes that loop. In one observed 660-block session
(243 tool pairs, 134 assistant, 40 user) this yields 417 units.

Keep the tool name and `is_error` on the unit (`block_text` currently has
them in hand and discards them).

### 2.2 Classify by tool name, no Jev call

| Tool | Class | Form | Why |
|---|---|---|---|
| Read, Grep, Glob, WebFetch; Bash whose first word is `ls`, `cat`, `sed`, `head`, `tail`, `find`, `git log`, `git diff`, `git status` | refetch | pointer | Content is on disk or the web. The path is the only fact worth a line |
| Edit, Write, MultiEdit, NotebookEdit | on-disk | pointer | The result is in the file; the line records which file the session changed |
| any other Bash; any unit with `is_error: true` | judge | per section 1.2 | Test output, build failures, verification results may exist nowhere else |
| Agent, Task*, TodoWrite, SendMessage | drop | none | Orchestration; the outcome is in the main thread's own text |

In the 660-block session about 100 of 243 tool units remain for Jev.

Pointer lines are `tool_use` transcript bytes, so the verbatim claim holds.
Cap them with `MAX_POINTER_LINES = 60`, newest first, and count them against
`TARGET_CHARS`. Without the cap a 200-read session adds ~15k chars of index.

Pointers are cheap coverage: `refetch_jev_covered` checks for the path string
in the digest, and a pointer satisfies it. Report `refetch_jev_full`
separately as the honest "bytes survived" number (section 6).

## 3. `fit_kept` by kind, and the pin

With `TARGET_CHARS = 16000` the cap binds on every session that reaches it,
so the order in which `fit_kept` downgrades and drops is the selection.
Today it downgrades by lowest `full` confidence and drops by lowest `keep`
confidence, with age as the implicit tiebreak. Replace with a kind order.

Downgrade whole -> head, lowest confidence first within each group:

1. `status`
2. tool `verified`
3. `constraint`, `evidence` with recoverable=yes
4. `decision`, `open` with recoverable=yes
5. `constraint`, `evidence` with recoverable=no
6. `decision`, `open` with recoverable=no
7. `request` (last, and never dropped)

Drop heads, in order: `status`, tool `verified`, pointers beyond
`MAX_POINTER_LINES`, `constraint`/`evidence` heads. Never drop an `open` head
or a `request`. Unscored units downgrade after group 4 and drop after
`constraint`/`evidence`: they are unknowns, not proven keeps.

The pin: `PIN_TAIL = 4` whole blocks at `KEEP_CHARS` can take 6,000 of the
16,000 chars before a judged block is placed. That is the worst case, not the
common one — measured over 1,130 real sessions against the earlier 8k cap,
the pinned tail took a median of 24% of the budget, p90 31%, p99 40%, and
never more than half, because blocks average well under `KEEP_CHARS`; at 16k
those shares halve. Treat this as a tail risk on sessions
ending in long tool output, not a routine loss.

If it is worth changing, `PIN_TAIL_TURNS = 1` keeps the last user prompt whole
and the assistant text that answered it as a head. The compaction turn is
no longer in the rows the engine hands over, so this is the turn the user
was mid-way through.

## 4. Stratified budget above `MAX_BLOCKS`

### 4.1 When it starts paying

Across 1,612 transcripts, 470 exceed 45 blocks; among those the median is
116, p75 203, p90 349, max 1,632. `MAX_BLOCKS = 150` judges the median long
session whole and fits one wave of `MAX_WORKERS = 16` requests. It leaves
the oldest 25% unjudged at p75 and the oldest 57% at p90. The stratified
budget pays from about 350 blocks (p90) upward: below that, raising
`MAX_BLOCKS` to 300 (two waves) is simpler and equivalent.

### 4.2 Mechanism

Replace `MAX_BLOCKS` with `MAX_QUESTIONS`, allocated over the whole
transcript by region:

1. Split units (after section 2 merging) into `REGIONS = 8` equal spans by
   position.
2. Priority within a region: user prompts, then assistant text, then judged
   tool units. Every user prompt anywhere is judged before any tool unit
   anywhere.
3. Each region gets `MAX_QUESTIONS / REGIONS`. Unused budget in a sparse
   region flows to the next.
4. Units over budget in a region fall back to their local class: user
   prompts become heads (never dropped unjudged), assistant text and tool
   units are dropped unjudged.

Stratified rather than sampled: sampling is nondeterministic, so the eval
cache (keyed on input lines and code) would stop reproducing a result, and
two compactions of the same rows would keep different things.

Not hierarchical (judge regions, then units in winning regions): two round
trips, and "is this 60-unit span important" is cross-block reasoning a
System One model is weakest at.

### 4.3 Cost at 500 and 2,000 blocks

Observed mix scaled to 500 blocks: ~30 user, ~100 assistant, ~185 tool pairs,
so 315 units and ~75 judged tool units. Questions: 30x2 + 100x2 + 75 = 335,
under `MAX_QUESTIONS = 600`; nothing dropped unjudged. Requests: 17 at
`CHUNK = 20`, each ~1.5k header + 10 x 1.2k bodies = ~13.5k chars, ~230k
total, one wave. Latency about one round trip; the current 150-block run
judges in ~900 ms.

At 2,000 blocks: ~1,260 units, ~1,300 questions wanted, capped at 600. All
~120 user prompts judged, most assistant text, a slice of Bash units per
region. 30 requests, two waves, under 3 s.

## 5. Constants

| Constant | Value | Status | Reason |
|---|---|---|---|
| `MIN_CHOICE_CONF` | 0.5 | guess, eval | Same floor as `KEEP_THRESHOLD`; the router's choice fallbacks sit there too |
| `KEEP_THRESHOLD` | 0.5 | reused | Becomes the `recoverable` cut. Meaning flips (yes = recoverable), value stays |
| `MAX_POINTER_LINES` | 60 | guess, eval | ~4.5k chars of index at most; more than that crowds the 16k cap |
| `PIN_TAIL` -> `PIN_TAIL_TURNS` | 1 | derived | The user's last real turn; the compaction turn is already cut |
| `BLOCKS_PER_CHUNK` | derived from question mix | derived | Prose units cost 2 questions, tool units 1; pack by question count, not block count |
| `MAX_QUESTIONS` | 600 | guess, eval | 30 requests; judges a 500-block session in full |
| `REGIONS` | 8 | guess, eval | Keeps the first hour of a session in play; a region still holds a full exchange |
| `MAX_BLOCKS` | removed with item 4 | derived | Replaced by `MAX_QUESTIONS`; until then 150 stands |
| `TAIL_LINES` | 5000 -> 20000, or count only user/assistant lines | check | non-message lines outnumber messages ~2.4:1 (median, measured); an 832-message transcript lands near 2,800 lines, inside 5000 but not comfortably |
| `TARGET_CHARS`, `KEEP_CHARS`, `HEAD_CHARS`, `BLOCK_CHARS`, `HEADER_CHARS`, `MAX_WORKERS`, `MIN_REDUCTION` | unchanged | | |

Bump `version` in `.claude-plugin/plugin.json` for each shipped item.

## 6. Measurement

All runs: `python3 eval/compare.py compact --synth 60`. The cache re-judges
when `compactor.py` changes, so each item costs one run. Ask before running.

| Item | Column | Baseline | Expect |
|---|---|---|---|
| 1 question set | new `digest_kinds`: kept chars by kind | none | `decision`+`open` >= 10% of digest chars on sessions over 100 blocks (section 1.4) |
| 1 question set | `refetch_jev_full` | 76-81% | Hold or rise. This is the verbatim number; a drop means the policy trades paths for reasoning, and the README must say so |
| 1, 3 | `jev_tok` | 3.2-3.9k | Stay under the default's summary |
| 2 tool units | `refetch_jev_covered` | at least the 76-81% verbatim | Rise toward 85-90% from pointers. Report as "path survived", not verbatim |
| 2 tool units | `jev_ms` and a new `req_chars` column | ~1.3-1.7 s | Fall: fewer questions per session |
| 3 fit_kept | `digest_kinds` share of `status` and pinned chars | none | Pinned under 25% of digest chars |
| 4 budget | new `reach`: fraction of user prompts judged; fraction of judged units older than block 150 | 0% past 150 | 100% of user prompts at any length |
| 4 budget | `jev_ms` on the p90+ synthetic cuts | | Under 3 s |

README sentences that a shipped item changes: the coverage row of the
comparison table (item 1 and 2), and any sentence describing the two
questions or the 150-block window (items 1 and 4).

## 7. Risks and degradation

What each item can make worse:

- Item 1: a `choice` is a stronger claim than a `noul`. Poor `kind`
  calibration makes `chatter` drop real content. Mitigation: low-confidence
  and unscored answers move toward keeping, never toward drop. Watch the
  `chatter` share per session in `STATS_LOG`; above ~40% of assistant text is
  suspicious.
- Item 2: the digest can read as a file index. `MAX_POINTER_LINES` bounds it.
  Bash classification by first word will misfile some read commands as
  `judge`; that costs one question, not content.
- Item 3: the kind order is a hand-written prior. If the eval shows `status`
  heads carrying the paths the session re-fetched, move `status` above
  pointers in the drop order.
- Item 4: the region allocation drops assistant text unjudged when over
  budget. On a 2,000-block session that is most of it. This is a bound, not
  a selection; say so in the `summary` line the bridge logs (`judged N of
  M units`).

API slow or down:

- The bridge fails open: `jev.JevError` and any exception answer
  `{"fallback": ...}` with exit 0, and the built-in summary runs.
- `ask_chunked` already returns `{}` for a failed chunk and raises only when
  every chunk fails. Unscored units are kept whole, so partial failure grows
  the digest; `fit_kept` still caps it at `TARGET_CHARS`, and under item 3
  unscored units downgrade after proven keeps. The `summary` line should
  say how many chunks failed.
- More requests per compaction (17 at 500 blocks under item 4) means more
  chances of one timeout. Each costs one chunk of judgment, not the run.
