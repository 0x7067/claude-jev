# claude-jev

A Claude Code plugin that hands three questions about every prompt — what kind
of request is this, how big is it, does it need tools — to
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model that
returns typed judgments instead of generating text. On compaction it hands Jev
a fourth question — which blocks of the transcript still matter — and the
kept ones survive verbatim; nothing is summarized by another LLM.

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
- **`/jev:compact`** — the post-style path: Jev judges every transcript block
  keep / truncate / drop in one batched request (~150 ms), writes the survivors
  verbatim to a digest, and tells you to run `/clear`. A `SessionStart`
  (`clear`) hook then rebuilds the session from *only* Jev's selection — no
  generated summary anywhere in the loop. The digest has a hard size cap
  (`JEV_COMPACT_TARGET_CHARS`), so the kept set can't grow without bound over
  a long session.
- **`SessionStart` (`compact`) hook** — the automatic path: when Claude Code's
  own compaction runs (auto or manual `/compact`, which can't be replaced from
  a hook), the same judgment re-injects the kept blocks verbatim on top of the
  generated summary. Dropped-by-mistake is the costly failure, so a block Jev
  couldn't score is kept.
- **Cache discipline** — compaction replaces the prompt prefix, so every later
  request re-reads the kept context uncached. The plugin therefore never
  compacts proactively, and applies nothing when Jev's selection doesn't
  shrink the transcript by at least `JEV_COMPACT_MIN_REDUCTION` (default
  25%): a weak selection would pay a massive uncached prompt for no win.
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
- Claude Code's own compaction can't be replaced from a plugin: `/compact`
  is excluded from the Skill tool, `PreCompact`/`PostCompact` output is
  discarded, and `SessionStart` is the only post-compaction event that can
  inject context. So the pure path composes `/clear` instead: `/jev:compact`
  selects, `/clear` drops everything, the `clear`-matched hook restores the
  selection. Digests are keyed by working directory with a 10-minute TTL, so
  they only ever land in the session they were made for.
- Sidechains, slash-command echoes, and one-word acks are filtered locally
  before Jev sees anything.
- Each block gets two `noul` judgments: *still needed at all* and *needed
  verbatim*. A `no` on the second keeps a truncated head plus a re-read
  pointer instead of the full text — most of the bulk lives in tool output
  that can be re-fetched, while exact errors and constraints stay whole.
- Kept blocks are always verbatim bytes, never reworded. The digest is
  hard-capped (`TARGET_CHARS`) by deterministically downgrading the
  lowest-confidence keeps — selection can shrink history but can never let
  the compacted context grow without bound, which is the failure mode of
  keeping user/assistant text forever.
- Nothing runs per turn: there is no proactive compaction trigger, because
  compaction's cost is a freshly-uncached prompt — it is only worth paying
  when Claude Code already compacted or the user asked for it, and only
  applied when the selection shrinks enough (`MIN_REDUCTION`) to cover it.
