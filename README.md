# claude-jev

A Claude Code plugin that hands the small judgments in a session to
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model
that returns typed judgments instead of generating text. Per prompt it asks
four questions — what kind of request is this, how big is it, does it need
tools, which model tier does it deserve — and on compaction a fifth: which
transcript blocks still matter.
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
  only when a separate yes/no question is near-certain. The same call also
  asks Jev which model tier the prompt deserves (haiku / sonnet / opus); on
  a confident mismatch with the model you're running — read from the
  transcript — a `systemMessage` nudge lands in the transcript ("looks like
  haiku work; you're on opus"). Advisory only: a hook can't switch the
  model, so the hint targets you, not the agent.
- **`jev` skill** — offload snap decisions to the bundled CLI: pick between
  options (`choose`), yes/no gates (`noul`), rubric scores (`score`), or
  batched raw questions (`ask`).
- **`/jev:compact`** — the manual path. Jev judges every transcript block
  keep / truncate / drop in one batched request (~1 s at the 45-block cap),
  writes the survivors verbatim to a digest, and tells you to run `/clear`.
  A `SessionStart` (`clear`) hook then rebuilds the session from only that
  selection — no generated summary in the loop. The digest is hard-capped
  at 40k chars, so the kept set can't grow without bound over a long
  session.
- **`SessionStart` (`compact`) hook** — the automatic path. Claude Code's
  own compaction can't be replaced from a plugin, so when it runs — auto or
  manual `/compact` — the same judgment re-injects the kept blocks verbatim
  on top of its summary. Dropped-by-mistake is the costly failure, so a
  block Jev couldn't score is kept.
- **Cache discipline** — compaction replaces the prompt prefix, so every
  later request re-reads the kept context uncached. The plugin never
  compacts proactively, and applies nothing when the selection shrinks the
  transcript by less than 25%: a weak selection would pay a fresh uncached
  prompt for no win.
- **`/jev:stats`** — scores the hints it already gave. The hook logs every
  decision, including the ones it suppressed, then finds each prompt in its
  session transcript and compares the hint to what the session did. Also
  reports the predicted model-tier distribution and how many mismatch hints
  were shown.

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

`TYPESAFE_API_KEY` (or `TYPESAFE_AI_KEY`) is the only one — required;
without it the hooks silently disable. Every parameter the plugin uses is
a constant in the source, tuned against the eval below.

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

`v8_tier` scores the model-tier question the same way: the proxy truth is
the observed scale of the turn (substantial or feature → opus, trivial →
haiku, else sonnet), and a "harmful" hint is one that said haiku on a turn
that then churned through 5+ tool calls. `v8_shipped` re-scores intent on
the shipped bundle to confirm adding the tier question didn't move it.
Neither label measures capability — they measure whether the suggestion
tracks the size of what actually happened.

Reproduce on your own history:

```bash
python3 eval/replay.py extract                     # your transcripts -> dataset
python3 eval/replay.py run --variant v7_no_unclear # cached; re-runs are free
python3 eval/replay.py run --variant v8_tier       # tier question, cache-shared with v8_shipped
python3 eval/replay.py report --variant v8_tier --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai` — start with
`--sample 250` if that matters for your repos.

Replay measures what the router *would* have said. `/jev:stats` measures
what it did say, on sessions you actually ran.

## Default vs claude-jev, on real sessions

`eval/compare.py` pairs the plugin against default Claude Code on your own
transcripts.

**Compaction.** Every `compact_boundary` in `~/.claude/projects` is a
paired sample: the transcript records what the built-in summarizer
injected, and replaying the same pre-boundary blocks through the plugin
shows what Jev's selection would have injected. `--synth N` grows the
corpus past the handful of real boundaries: any session whose
judge-visible content passes ~100k chars with at least 30 blocks of
structure (the range the real boundaries fired at) gets a synthetic cut,
and `claude -p` generates the default-side summary from the same
conversation — a labeled replica, not the real routine.

Across 77 compaction points — 6 real boundaries + 71 synthetic cuts:

| | default: summary + tail | jev: selection digest |
|---|---|---|
| context injected per event | ~4.2k tok | ~0.8–1.8k tok |
| time to compact | ~2 min | ~1 s |
| re-fetch coverage | ~59–91% mentioned | ~60–82% verbatim |

After each point the agent re-fetched 818 files/searches/urls it had
already fetched. Under the six real compactions the default summary still
mentioned 91% of those paths — and the re-reads happened anyway, because
a mention is not the content. On the larger synthetic set both sides land
near 60% coverage, but of different kinds: the summary holds a pointer,
Jev's digest holds the bytes — the reads an agent wouldn't need to
repeat — at roughly 40% of the injected tokens and ~1% of the wall time.
The honest gap: ~40% of re-fetched artifacts fall outside Jev's 45-block
judgment window or its keep floor; a summary compresses everything, a
selection drops what didn't earn a place. Rows and per-event detail land
in `eval/data/compare_compact.jsonl`; summaries and judgments cache in
`eval/data/compact_cache.jsonl`, so re-runs and bigger `--synth` are
incremental.

**Router.** Joining the shipped hints to what the unhinted agent did next
(1,613 real prompts): hints fired on 42%. The one with a measurable
counterfactual is the no-tools gate — on the 70 prompts Jev would have
steered to "answer directly", default Claude made 151 tool calls across
17 prompts that used tools anyway. But the split matters: 13 of those
calls were light pokes the hint saves, and 138 sat in 8 sessions that
genuinely needed the tools — the harmful-hint failure the eval already
tracks. The gate pays for itself in prevented pokes and occasionally
costs a session real work, which is why it stays near-certain-only.

## Design notes

- **Fail open.** Any error, missing key, or timeout produces no output and
  never blocks a prompt. Prompts go to `api.typesafe.ai` for
  classification; slash commands, `#` lines, and prompts under 3 chars are
  skipped locally.
- **The tier nudge is advisory, not a switch.** Hooks can't change the
  model a session is running, so the tier answer surfaces as a
  `systemMessage` to you, and only on a confident mismatch with the model
  the transcript last recorded.
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
