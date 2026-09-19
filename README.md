# claude-jev

A Claude Code plugin that hands three questions about every prompt — what kind
of request is this, how big is it, does it need tools — to
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model that
returns typed judgments instead of generating text. On compaction it hands Jev
a fourth question — which blocks of the transcript still matter — and
re-injects the kept ones verbatim instead of relying only on the generated
summary.

Not an agentic-coding replacement: it doesn't write code. It makes the small
judgments cheaper.

## What you get

- **`UserPromptSubmit` hook** — each prompt is classified in one API call
  (intent × scope × needs-tools) and a one-line routing hint is injected as
  context. The previous turn goes into the classification, because most
  prompts are follow-ups. `lookup` → one targeted search; `fix` → focused edit
  + narrow verification; `feature` → brief plan first; `ops` → run it and
  report. Below 0.75 confidence, no hint. The "answer directly, no tools" hint
  fires only when a separate yes/no question is near-certain.
- **`jev` skill** — teaches the agent to offload snap decisions to the bundled
  CLI: choose between options (`choose`), yes/no gates (`noul`), rubric scores
  (`score`), or batched raw questions (`ask`).
- **`SessionStart` compaction hook** — after Claude Code compacts, the
  transcript still holds the pre-compaction history (it's append-only), so a
  single `compact`-matched hook gives every block a keep-or-drop judgment from
  Jev in one batched request (~150 ms) and injects the kept blocks as context —
  as they were written, not paraphrased. The built-in summary still runs; this
  adds back what it would have lost. Dropped-by-mistake is the costly failure,
  so a block Jev couldn't score is kept.
- **`/jev:stats`** — scores the hints it already gave. The hook logs every
  decision, including the ones it suppressed; this finds each prompt in its
  session transcript and compares the hint to what the session then did.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set your key (either name works):

```bash
export TYPESAFE_API_KEY="..."   # or TYPESAFE_AI_KEY
```

Requires `python3` (stdlib only, no pip installs).

## Env vars

| Var | Default | Effect |
|---|---|---|
| `TYPESAFE_API_KEY` / `TYPESAFE_AI_KEY` | — | required; hook silently disables without it |
| `JEV_MODEL` | `jev-latest` | model id |
| `JEV_TIMEOUT` | `8` | HTTP timeout (s) |
| `JEV_MIN_CONFIDENCE` | `0.75` | intent confidence floor for injecting hints |
| `JEV_MAX_QUIET` | `0.10` | a "no tools needed" hint requires needs_tools at or below this |
| `JEV_LOG` | `~/.claude/jev-router-log.jsonl` | decision log path; `0` disables logging |
| `JEV_OFF` | unset | `1` disables all hooks |
| `JEV_COMPACT_KEEP` | `0.5` | keep-probability floor for a transcript block |
| `JEV_COMPACT_MAX_BLOCKS` | `45` | max blocks judged per compaction; older ones drop unjudged |
| `JEV_COMPACT_CHUNK` | `20` | questions per API call; chunks run in parallel |
| `JEV_COMPACT_BLOCK_CHARS` | `1200` | chars of each block shown to Jev |
| `JEV_COMPACT_KEEP_CHARS` | `1500` | chars of each kept block in the digest |
| `JEV_COMPACT_LOG` | `~/.claude/jev-compact-log.jsonl` | per-compaction stats; `0` disables |

## Does it work?

`eval/` replays your own past sessions through the router and scores each
prediction against what the agent actually did next. On 1,613 real prompts:

| Variant | Coverage | Accuracy | Best constant guess | Lift | Harmful hints |
|---|---|---|---|---|---|
| v0 — as first published | 68% | 19.6% | 27.8% | −8.2 | 68 |
| v1 — + previous turn as context | 66% | 28.3% | 28.8% | −0.5 | 108 |
| v2 — − `needs_repo` | 65% | 28.3% | 28.4% | −0.1 | 111 |
| v3 — − `refactor` | 65% | 30.4% | 29.0% | +1.3 | 85 |
| v4 — gate the no-tools hint | 53% | 31.1% | 30.4% | +0.7 | 3 |
| v5 — 3-way / binary taxonomy | 66% / 39% | 58.8% / 75.4% | 64.7% / 82.6% | −5.9 / −7.2 | 102 / 69 |
| **v7 — shipped** | 42% | 34.6% | 29.3% | **+6.0** | **8** |

A harmful hint tells the agent to skip work it then needed: a "no tools"
routing hint followed by five or more tool calls.

Those labels are derived from transcripts, not written by hand, and they are
noisy. On a blind sample of 120 prompts labeled by hand, the derived labels
agreed 52.5% of the time; the shipped router scored 48.8% against the hand
labels and 22.0% against the derived ones. Read 34.6% as a floor rather than an
estimate. The hand labels are in `eval/audit_labels.json`, keyed by record id,
so you can override any of them and re-score.

Reproduce it on your own history:

```bash
python3 eval/replay.py extract                     # your transcripts -> dataset
python3 eval/replay.py run --variant v7_no_unclear # cached; re-runs are free
python3 eval/replay.py report --variant v7_no_unclear --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai`. Start with `--sample 250`
if that matters for your repos.

Replay measures what the router *would* have said. `/jev:stats` measures what it
did say, against sessions you actually ran.

## Design notes

- The hook **fails open**: any error, missing key, or timeout produces no
  output and never blocks a prompt.
- Prompts are sent to `api.typesafe.ai` for classification. Slash commands,
  `#` lines, and prompts under 3 chars are skipped locally.
- The question bundle dropped `refactor`, `unclear`, and `needs_repo`.
  The first two never reached usable precision; a hardcoded "yes" beat
  `needs_repo` by 18 points.
- A smaller taxonomy scores higher and helps less. Collapsing to talk/read/act
  reaches 58.8%, but always guessing "act" reaches 64.7% — the model is
  reliable exactly where the default assumption already is.
- `scripts/observed.py` decides what a past turn actually did — read, edit,
  ops, nothing. Both the eval harness and `/jev:stats` score against it, so
  changing it moves every number in this README.
- All routing logic lives in `scripts/prompt_router.py`; question definitions
  in `scripts/jev.py::intent_bundle`. If you edit either, re-run `eval/` —
  the shipped bundle is meant to stay identical to the measured one.
- The compactor is one `SessionStart` hook, not a `/compact` replacement:
  built-in commands can't be invoked programmatically (the Skill tool excludes
  `/compact`), a command can't cover auto-compaction, and `SessionStart` with
  the `compact` matcher is the only post-compaction event that can inject
  context — `PreCompact`/`PostCompact` output is discarded. The generated
  summary still runs; Jev's keep-list lands on top of it, verbatim.
- Sidechains, slash-command echoes, and one-word acks are filtered locally
  before Jev sees anything; blocks after the last compact boundary are
  excluded, so the new summary can't talk itself into being kept.
