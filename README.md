# claude-jev

A Claude Code plugin that hands the small judgments in a session to
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model
that returns typed judgments instead of generating text. Per prompt it asks
three questions — what kind of request is this, how big is it, does it need
tools — and on compaction a fourth: which transcript blocks still matter.
The kept blocks survive verbatim; nothing is summarized by another LLM.

Not a coding-agent replacement: it doesn't write code, it makes the small
judgments cheaper.

## What you get

- **`UserPromptSubmit` hook** — classifies each prompt in one API call
  (intent × scope × needs-tools) and injects a one-line routing hint. The
  previous turn goes into the classification, because most prompts are
  follow-ups. `lookup` → one targeted search; `fix` → focused edit + narrow
  verification; `feature` → brief plan first; `ops` → run it and report.
  Below 0.75 confidence, no hint. The "answer directly, no tools" hint fires
  only when a separate yes/no question is near-certain.
- **`jev` skill** — offload snap decisions to the bundled CLI: pick between
  options (`choose`), yes/no gates (`noul`), rubric scores (`score`), or
  batched raw questions (`ask`).
- **`/jev:compact`** — the manual path. Jev judges every transcript block
  keep / truncate / drop in one batched request (~1 s at the 45-block cap),
  writes the survivors verbatim to a digest, and tells you to run `/clear`.
  A `SessionStart` (`clear`) hook then rebuilds the session from only that
  selection — no generated summary in the loop. The digest is hard-capped
  (`JEV_COMPACT_TARGET_CHARS`), so the kept set can't grow without bound
  over a long session.
- **`SessionStart` (`compact`) hook** — the automatic path. Claude Code's
  own compaction can't be replaced from a plugin, so when it runs — auto or
  manual `/compact` — the same judgment re-injects the kept blocks verbatim
  on top of its summary. Dropped-by-mistake is the costly failure, so a
  block Jev couldn't score is kept.
- **Cache discipline** — compaction replaces the prompt prefix, so every
  later request re-reads the kept context uncached. The plugin never
  compacts proactively, and applies nothing when the selection shrinks the
  transcript by less than `JEV_COMPACT_MIN_REDUCTION` (default 25%): a weak
  selection would pay a fresh uncached prompt for no win.
- **`/jev:stats`** — scores the hints it already gave. The hook logs every
  decision, including the ones it suppressed, then finds each prompt in its
  session transcript and compares the hint to what the session did.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set your key (either name works):

```bash
export TYPESAFE_API_KEY="..."   # or TYPESAFE_AI_KEY
```

Requires `python3`, stdlib only.

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
| `JEV_COMPACT_PIN_TAIL` | `4` | newest blocks always kept verbatim, never judged |
| `JEV_COMPACT_CHUNK` | `20` | questions per API call; chunks run in parallel |
| `JEV_COMPACT_BLOCK_CHARS` | `1200` | chars of each block shown to Jev |
| `JEV_COMPACT_KEEP_CHARS` | `1500` | chars of each kept block in the digest |
| `JEV_COMPACT_HEAD_CHARS` | `400` | head retained on a truncated block |
| `JEV_COMPACT_TARGET_CHARS` | `40000` | hard cap on digest size; weakest keeps downgrade then drop |
| `JEV_COMPACT_MIN_REDUCTION` | `0.25` | below this reduction nothing is applied |
| `JEV_COMPACT_DIR` | `~/.claude/jev-compact` | where `/jev:compact` digests wait for `/clear` |
| `JEV_COMPACT_LOG` | `~/.claude/jev-compact-log.jsonl` | per-compaction stats incl. est. uncached tokens; `0` disables |

## Does it work?

`eval/` replays your own past sessions through the router and scores each
prediction against what the agent did next. On 1,613 real prompts:

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
hint followed by five or more tool calls.

The labels come from transcripts, not hand annotation, and they're noisy.
On a blind sample of 120 hand-labeled prompts, the derived labels agreed
52.5% of the time; the shipped router scored 48.8% against the hand labels
and 22.0% against the derived ones. Read 34.6% as a floor, not an estimate.
The hand labels live in `eval/audit_labels.json` keyed by record id —
override any of them and re-score.

Reproduce on your own history:

```bash
python3 eval/replay.py extract                     # your transcripts -> dataset
python3 eval/replay.py run --variant v7_no_unclear # cached; re-runs are free
python3 eval/replay.py report --variant v7_no_unclear --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai` — start with
`--sample 250` if that matters for your repos.

Replay measures what the router *would* have said. `/jev:stats` measures
what it did say, on sessions you actually ran.

## Design notes

- **Fail open.** Any error, missing key, or timeout produces no output and
  never blocks a prompt. Prompts go to `api.typesafe.ai` for
  classification; slash commands, `#` lines, and prompts under 3 chars are
  skipped locally.
- **The taxonomy is what survived measurement.** The question bundle
  dropped `refactor`, `unclear`, and `needs_repo`: the first two never
  reached usable precision, and a hardcoded "yes" beat `needs_repo` by 18
  points. A smaller taxonomy scores higher and helps less — collapsing to
  talk/read/act reaches 58.8%, but always guessing "act" reaches 64.7%.
  The model is reliable exactly where the default assumption already is.
- **`scripts/observed.py` is the scorer.** It decides what a past turn
  actually did — read, edit, ops, nothing — and both the eval harness and
  `/jev:stats` score against it, so changing it moves every number above.
  Routing logic lives in `scripts/prompt_router.py`, question definitions
  in `scripts/jev.py::intent_bundle`. Edit either and re-run `eval/` —
  the shipped bundle is meant to stay identical to the measured one.
- **Built-in compaction can't be replaced, so the pure path composes
  `/clear`.** `/compact` is excluded from the Skill tool and
  `PreCompact`/`PostCompact` output is discarded; `SessionStart` is the
  only post-compaction event that can inject context. So `/jev:compact`
  selects, `/clear` drops everything, and the `clear`-matched hook
  restores the selection. Digests are keyed by working directory with a
  10-minute TTL — they only ever land in the session they were made for.
- **Selection keeps bytes, not prose.** Sidechains, slash-command echoes,
  and one-word acks are filtered before Jev sees anything. Each remaining
  block gets two `noul` judgments — *still needed at all* and *needed
  verbatim*. A `no` on the second keeps a truncated head plus a re-read
  pointer: most of the bulk is tool output the agent can re-fetch, while
  exact errors and constraints stay whole. A kept `tool_result` pulls its
  `tool_use` in with it. Kept blocks are verbatim bytes, cut at paragraph
  breaks, and the digest is hard-capped (`TARGET_CHARS`) by downgrading
  the lowest-confidence keeps — selection can shrink history but can never
  let the compacted context grow without bound, which is the failure mode
  of keeping user/assistant text forever.
- **Nothing runs per turn.** There is no proactive compaction trigger:
  compaction's cost is a freshly-uncached prompt, worth paying only when
  Claude Code already compacted or the user asked, and applied only when
  the selection shrinks enough (`MIN_REDUCTION`) to cover it.
