# claude-jev

A Claude Code plugin that hands the small judgments in a session to
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model
that returns typed judgments instead of generating text.

Per prompt it asks four questions: what kind of request is this, how big is
it, does it need tools, which model tier does it deserve. On compaction it
asks a fifth — which transcript blocks still matter — and the ones it keeps
survive verbatim. Nothing is summarized by another LLM. It doesn't write
code. It makes the small judgments cheaper.

## What it does

| Hook | Job |
|---|---|
| `UserPromptSubmit` | Classify the prompt, inject a one-line routing hint |
| `PreToolUse` (`Agent\|Task`) | Pick the model tier a subagent spawns on |
| `PostToolUse` (edits) | Judge the edit against your instruction files |
| `Stop` | Judge the whole turn against the rules that need it |
| `SessionStart` (`compact`, `clear`) | Re-inject the blocks Jev kept |

### Routing

One API call per prompt: intent, scope, needs-tools, model tier. The previous
turn goes in too, because most prompts are follow-ups. `lookup` → one targeted
search. `fix` → focused edit, narrow verification. `feature` → brief plan
first. `ops` → run it and report. Below 0.75 confidence you get nothing.

The "answer directly, no tools" hint is gated harder than the rest. It fires
only when a separate yes/no question comes back near-certain, because telling
the agent to skip work it turned out to need is the expensive mistake — see
the counterfactual below, where it cost eight sessions real work.

The tier answer is advisory. A hook can't change the model a session runs on,
so on a confident mismatch with the model the transcript last recorded you get
a `systemMessage`: "looks like haiku work; you're on opus". The agent never
sees it. The one place the tier answer acts is subagent spawning, where
`updatedInput` sets `model` on the call before it happens. A model the caller
set explicitly always wins.

### Rules

Rules come from the instruction files you already keep: `CLAUDE.md`,
`AGENTS.md` (nested ones scoped to their directory), `.claude/rules/*`,
`.cursor/rules/*`, `~/.claude/CLAUDE.md`, `~/.claude/jev-rules.md`. There is
nothing to compile and nothing extra to commit.

The first time the hook meets one of those files, Jev classifies every bullet
and paragraph in a single batched call. Is this an instruction about the code
the agent writes, or a fact, a pointer, a process rule? And if it is an
instruction, can one edit break it, or does judging it need the whole change?
Verdicts cache under `~/.claude` by file hash, so a file is classified once
until it changes.

Every edit is then one batched call, one yes/no question per rule, in your own
wording. The answer is the probability the rule is broken. Jev sees the
old→new hunk plus your last prompt, so "don't touch generated files" means
something. At most 40 questions go out per edit: rules scoped to the edited
path first, then the repo's, then global ones, with rule files taking turns so
one long file can't use every slot.

Verdicts are banded. At 0.80 the edit is blocked and the rule is cited by file
and line. Between 0.50 and 0.80 you get a notice and the agent gets nothing.
Below that, silence. A rule blocks the same file at most twice per session and
then only flags, because a repair that can't land is a loop. Vendored paths,
generated paths, and files outside the project are never judged.

Rules Jev classified as whole-turn — keep changes minimal, no abstraction with
a single caller, don't refactor unrelated code — are skipped per edit, where
they have no answer yet. They judge the session's accumulated hunks at `Stop`,
which is where scope creep becomes visible.

### Compaction

Two entry points, one mechanism. `/claude-jev:compact` is manual: Jev judges
every transcript block keep, truncate or drop in one batched request, writes
the survivors verbatim to a digest, and tells you to run `/clear`. A
`SessionStart` hook then rebuilds the session from that selection alone. The
automatic path covers Claude Code's own compaction, which a plugin can't
replace: a second `SessionStart` hook re-injects the kept blocks on top of the
built-in summary.

Either way no generated summary enters the loop, and a block Jev couldn't
score is kept — dropping by mistake is the costly failure.

Two limits bound it. The digest is capped at 40k chars, so the kept set can't
grow without bound across a long session. And compaction replaces the prompt
prefix, which means every later request re-reads that context uncached. So the
plugin never compacts proactively, and applies nothing when the selection
shrinks the transcript by less than 25%. A weak selection would buy a freshly
uncached prompt for no gain.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set `TYPESAFE_API_KEY` (or `TYPESAFE_AI_KEY`). It is the only environment
variable and it is required — without it the hooks disable silently. Every
other parameter is a constant in the source. Needs `python3`, stdlib only.

## Does it work?

### The rule hook

Two corpora, both judging edits inside real repos so the judge can read those
repos' own instruction files. Neither is committed, because neither works
without the repos present.

**Real edits, the honest false-positive measure.** `eval/rules_eval.py
extract` pulls every Edit and Write out of `~/.claude/projects`, keeping the
ones the judge can actually reach. Those edits were accepted at the time, so
anything the hook blocks is a block it would have imposed on you wrongly.

On a 250-edit sample, 248 judged: **3 blocked (1.2%)**, 38 flagged (15.3%),
median 0.70s per edit at a median of 10 questions.

That number was 2.8% until this corpus found the bug behind it. Thirty-one
percent of sampled edits were files outside their repo — scratch files under
`/private/tmp` written during a session — and the hook was judging them
against that repo's rules. One blocked at 0.94 for breaking a TypeScript style
rule, in a file that had nothing to do with the project. `outside()` in
`scripts/rules.py` now rejects any path that climbs out of the working
directory.

**Hand-written cases.** Violations of the real rules in real repos, each
paired with a compliant near-miss: 12 of 19 violations blocked, all by the
rule the case targets, and **0 of 13 near-misses falsely blocked**.

Seven misses is a lot, and three scored nothing at all. Two of those were
rules living in a dense prose `AGENTS.md`, which is the failure I'd look at
first — a rule buried in a paragraph about product scope classifies poorly.
The other four landed between 0.52 and 0.76: seen, under the bar.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

### The router

`eval/replay.py` replays your own past prompts and scores each prediction
against what the agent did next. On 1,613 real prompts:

| Variant | Coverage | Accuracy | Best constant guess | Lift | Harmful hints |
|---|---|---|---|---|---|
| v0 — as first published | 68% | 19.6% | 27.8% | −8.2 | 68 |
| v1 — + previous turn as context | 66% | 28.3% | 28.8% | −0.5 | 108 |
| v2 — − `needs_repo` | 65% | 28.3% | 28.4% | −0.1 | 111 |
| v3 — − `refactor` | 65% | 30.4% | 29.0% | +1.3 | 85 |
| v4 — gate the no-tools hint | 53% | 31.1% | 30.4% | +0.7 | 3 |
| v5 — 3-way / binary taxonomy | 66% / 39% | 58.8% / 75.4% | 64.7% / 82.6% | −5.9 / −7.2 | 102 / 69 |
| **v7 — shipped** | 42% | 34.6% | 29.3% | **+6.0** | **8** |

A harmful hint is one that told the agent to skip work it then needed: "no
tools", followed by five or more tool calls.

Read 34.6% as a floor, not a score. The labels come from transcripts rather
than hand annotation, and they are noisy. On a blind sample of 120
hand-labeled prompts the derived labels agreed with the humans 52.5% of the
time; the shipped router scored 48.8% against the hand labels and 22.0%
against the derived ones. The hand labels live in `eval/audit_labels.json`,
keyed by record id — override any of them and re-score.

### Default Claude Code vs claude-jev

`eval/compare.py` pairs the two on your own transcripts. Every
`compact_boundary` is a natural experiment: the transcript records what the
built-in summarizer injected, and replaying the same pre-boundary blocks shows
what Jev would have injected instead. `--synth N` grows the sample past the
handful of real boundaries by cutting long sessions at comparable points and
generating the default-side summary with `claude -p`.

Across 77 compaction points, 6 real and 71 synthetic:

| | default: summary + tail | jev: selection digest |
|---|---|---|
| context injected per event | ~4.2k tok | ~0.8–1.8k tok |
| time to compact | ~2 min | ~1 s |
| re-fetch coverage | ~59–91% mentioned | ~60–82% verbatim |

After each point the agent re-fetched 818 files, searches and URLs it had
already fetched. Under the six real compactions the default summary still
mentioned 91% of those paths and the re-reads happened anyway, because a
mention is not the content.

On the larger synthetic set both sides land near 60% coverage. The kinds
differ. A summary holds a pointer; the digest holds the bytes. The gap is the
honest part — about 40% of re-fetched artifacts fall outside Jev's 45-block
judgment window or below its keep floor, and a selection drops what scored
low.

The router's one measurable counterfactual is the no-tools gate. On the 70
prompts Jev would have steered to "answer directly", default Claude made 151
tool calls across 17 prompts that used tools anyway. The split is what
matters: 13 of those calls were small lookups the hint saves, and 138 sat in 8
sessions that genuinely needed the tools. The gate saves lookups and
occasionally costs a session real work, which is why it stays
near-certain-only.

## Design notes

**Fail open.** Any error, missing key or timeout produces no output and never
blocks a prompt. Slash commands, `#` lines and prompts under 3 characters are
skipped locally, before anything leaves the machine.

**The taxonomy is sized for lift, not accuracy.** A coarser one scores
higher and helps less: collapsing to talk/read/act reaches 58.8% accuracy,
but always guessing "act" reaches 64.7%. The shipped taxonomy is the one with
the widest margin over its own best constant guess.

**`scripts/observed.py` is the scorer.** It decides what a past turn actually
did — read, edit, ops, nothing — and both the eval harness and
`/claude-jev:stats` score against it. Change it and every number above moves.
Routing logic is in `scripts/prompt_router.py`, question definitions in
`scripts/jev.py::intent_bundle`.

**Why the manual path composes `/clear`.** `/compact` is excluded from the
Skill tool and `PreCompact`/`PostCompact` output is discarded, so
`SessionStart` is the only post-compaction event that can inject context.
Hence: select, `/clear` to drop everything, and the `clear`-matched hook
restores the selection. Digests are keyed by working directory with a
10-minute TTL, so one can only ever land in the session it was made for.

**Selection keeps bytes, not prose.** Sidechains, slash-command echoes and
one-word acks are filtered before Jev sees anything. Each remaining block gets
two judgments: still needed at all, and needed verbatim. A no on the second
keeps a truncated head plus a re-read pointer, because most of the bulk is
tool output the agent can fetch again, while exact errors and constraints stay
whole. A kept `tool_result` pulls its `tool_use` in with it. The 40k cap is
enforced by downgrading the lowest-confidence keeps first.
