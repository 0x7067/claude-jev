# claude-jev

Claude Code spends part of every turn on small questions: what kind of request
is this, how big is it, does it need tools, which model should answer.
claude-jev sends those four to [TypeSafe's
Jev](https://docs.typesafe.ai/introduction), a System One model that answers
with typed judgments instead of text. Their answers become a routing hint, a
model tier for subagents, and checks on edits. Compaction adds a fifth
question, which transcript blocks still matter. Jev hands those back verbatim,
with no model summary over them. Jev writes no code. It makes the small
judgments cheap.

## What it does

- **`UserPromptSubmit` hook** classifies each prompt in one API call (intent ×
  scope × needs-tools) and injects a one-line hint. The previous turn is
  included, since most prompts are follow-ups. `lookup` → one targeted search;
  `fix` → focused edit plus narrow verification; `feature` → plan first; `ops`
  → run it and report. Below 0.75 confidence, no hint. The "answer directly, no
  tools" hint waits for a separate yes/no gate to be near-certain. Sending the
  agent past work it needed costs more than a wasted lookup. The same call asks
  which tier the prompt deserves (haiku, sonnet or opus). On a confident
  mismatch with the model in the transcript, you get a `systemMessage`: "looks
  like haiku work; you're on opus". A hook can't switch models, so the nudge is
  for you, and the agent never sees it.
- **`PreToolUse` hook (`Agent|Task`)** puts the tier answer to work. Before a
  subagent starts, Jev reads its prompt and picks the cheapest tier that can do
  the job, then `updatedInput` sets `model` on the call. The subagent starts on
  that tier instead of inheriting the session model. A `model` the caller set
  always wins, and permission rules still run against the rewritten input.
  Below the confidence floor, the spawn goes through untouched.
- **`PostToolUse` hook (`Edit|Write|MultiEdit|NotebookEdit`)** enforces the
  rules a linter can't. They come from a compiled rubric
  (`.claude/jev-rubric.json`, from `/claude-jev:rules-compile`) if one exists,
  else from `CLAUDE.md`, `AGENTS.md` (nested ones scoped to their directory),
  `.claude/rules/*`, `~/.claude/CLAUDE.md` and `~/.claude/jev-rules.md`. Jev
  reads each bullet once and sorts it: an instruction to the agent, a fact, or
  a pointer. The verdict is cached by file hash, so only instructions become
  questions. A rule is a typed question (boolean, choice or score) whose answer
  maps to a violation probability, and one batched call judges each edit. Only
  `model` rules are judged; `lint` rules name what a real linter owns and never
  reach the model. Jev sees the old→new hunk and your last prompt, so "don't
  touch generated files" means something on a given edit. At most 40 questions
  per edit, after scope filtering: rules for the edited path, then the repo's,
  then global. Rule files take turns, so one long file can't use every slot. At
  0.80 or above, the rule blocks the edit and is cited by id and line ("Repair
  `logout.ts` now, then continue"). Between 0.50 and 0.80, you get a notice and
  the agent gets nothing. Below that, nothing at all. A rule can block one file
  twice per session, then only flags: a repair that can't land is a loop.
  Vendored and generated paths are never judged. No rules, no judgment.
- **`Stop` hook** runs the rules that need the whole change. Rubric rules
  marked `when: "turn"` judge the session's hunks together, where scope creep
  or an abstraction with one caller shows up. Same bands, same loop guard (2
  blocks per session, and `stop_hook_active` prevents re-blocks).
- **`/claude-jev:rules-compile`** turns your instruction files into the rubric.
  The agent reads `AGENTS.md` and `CLAUDE.md` (root and nested), rules files,
  and `CONTRIBUTING.md`, extracts every statement that instructs, and files
  each as `model`, `lint`, `deferred` or `unenforceable`. Each `model` rule
  becomes a typed question, with `when` chosen per rule. Then
  `scripts/rubric.py --validate` fills source hashes and prints the bucket
  table. You commit the file and can edit it by hand. Edit a source afterwards
  and the rubric goes stale, which the hook says.
- **`jev` skill** offloads snap decisions to the bundled CLI: `choose` between
  options, `noul` for yes/no gates, `score` on a rubric, `ask` for batched raw
  questions.
- **`/claude-jev:stats`** scores the hints it already gave. The hook logs every
  decision, including the suppressed ones, and the command finds each prompt in
  its session transcript to compare the hint with what the session did. It
  reports the predicted tier distribution and how many mismatch hints were
  shown. It also prints a calibration table per rule: checks, median/min/max
  probability, fire count, and a verdict (decisive, weak or noisy). A weak rule
  can then be rewritten, or disabled with `status` in the rubric, instead of
  deleted.
- **Compaction** has two entry points and one mechanism. `/claude-jev:compact`
  is manual. Jev judges every transcript block keep / truncate / drop in one
  batched request (~1 s at the 45-block cap) and writes the survivors verbatim
  to a digest. Then it tells you to run `/clear`. A `SessionStart` (`clear`)
  hook rebuilds the session from that selection. The automatic entry fires on
  Claude Code's own compaction, auto or `/compact`, which a plugin can't
  replace. A `SessionStart` (`compact`) hook re-injects the kept blocks
  verbatim over the built-in summary. Either way no generated summary enters
  the loop, and a block Jev couldn't score is kept, because dropping the wrong
  block costs more than keeping it.

Two limits bound it. The digest is capped at 40k chars, so the kept set can't
grow without bound. And compaction replaces the prompt prefix, so later
requests re-read the kept context uncached. That cost is why the plugin
compacts only when Claude Code already has, or when you ask. It also skips any
selection that shrinks the transcript by less than 25%: a weak selection would
pay a fresh uncached prompt for no win.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set `TYPESAFE_API_KEY` (or `TYPESAFE_AI_KEY`). It is the only env var, and it
is required: without it the hooks silently disable. Every other parameter is a
constant in the source, tuned against the eval below. Requires `python3`,
stdlib only.

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

A harmful hint sends the agent past work it then needed: a "no tools" hint
followed by five or more tool calls.

The labels come from transcripts, not hand annotation, so they are noisy. On a
blind sample of 120 prompts labeled by hand, the derived labels agreed 52.5% of
the time. The shipped router scored 48.8% against the hand labels and 22.0%
against the derived ones. Read 34.6% as a floor. The hand labels live in
`eval/audit_labels.json`, keyed by record id; override any of them and
re-score.

`v8_tier` scores the tier question the same way. Its proxy truth is the
observed size of the turn: substantial or feature → opus, trivial → haiku, else
sonnet. A hint is harmful when it said haiku on a turn that then made 5+ tool
calls. `v8_shipped` re-scores intent on the shipped bundle, confirming the tier
question didn't move it. Neither label measures capability; both measure
whether the suggestion tracks the size of what happened.

**Rule enforcement.** `eval/rules_eval.py` runs two corpora through the same
`judge_edit` the hook calls. The first is every edit in your local transcripts.
Those were accepted at the time, so a block there is a false positive against
the repo's current instruction files. The second is `eval/rules_cases.jsonl`:
hand-written violations of the *real* rules in real local repos, each paired
with a compliant near-miss. Those repos are a k3s GitOps repo, a Next.js/tRPC
monorepo with `.claude/rules/*`, a Flue app, two smaller projects, and the
user-level `CLAUDE.md`. The judge sees the exact PostToolUse payload, and
nothing is written to those repos.

| | blocked (≥0.80) | blocked or flagged (≥0.50) |
|---|---|---|
| 25 violations | 23, 22 by the rule the case targets | 24 |
| 16 compliant near-misses | 1 false block | 5 |
| 108 real edits | 0 | 8 (7.4%) |

Median 0.70 s per edit with a median of 20 questions.

`eval/rules_stress.py` goes further. It inserts a violating needle (start,
middle or end) into real files from those repos, and writes the change as an
Edit and as a whole-file Write. Each case comes with a benign twin of similar
size, and the user's prompt *asks for* the violation. On 588 cases: 261 of 294
violations blocked (260 by the targeted rule), 291 flagged, and 51 of 294
benign twins blocked. Two changes cut that from 86. Whole-file Writes are
judged as a `git diff` instead of the whole file, so the judge stops reading
existing lines as the agent's work. And the per-file classification asks one
question: could a reviewer tell from this single diff that the rule was
followed? That drops process rules ("read the owning module first", "run the
checks") which a hunk can never satisfy. In a live session those had blocked
the agent's own repair edits.

Live, the plugin ran under `--plugin-dir` in throwaway worktrees of two of
those repos. A leaf `kustomization.yaml` given a `namespace:` was blocked at
0.92, and a `status === 'pending'` helper at 0.83. Each cited the right rule. A
memory-limit bump passed. Two other requested violations never reached the
hook, because the agent refused them itself, citing the same files. The hook is
for the cases the agent doesn't notice.

**Markdown fallback vs a compiled rubric.** The same corpus ran against a
rubric compiled from one of those repos with `/claude-jev:rules-compile`. It
held 336 rules from 13 instruction files: 137 filed under `lint`, 71 left for
the judge (44 per edit, 27 at Stop), the rest deferred or unenforceable. The
judge asked fewer questions per edit (22–33 instead of the 40 cap) and raised
no false block on the hand-written near-misses. Detection on the needles fell
from 156 to 48 of 168. Every drop traced to a rule the rubric had filed under
`lint`: magic strings, `as any`, bare TODOs, a migration moved into `start.sh`.
That is the design working. The judge does not redo the linter's job.

It also names the one thing the plugin can't check for you. **A `lint` rule is
enforced only if that repo's linter actually runs it.** In that repo, 81 of the
137 lint rules named an ESLint rule, ast-grep pattern, or grep that nothing was
configured to run. With the rubric in place, neither the linter nor the judge
enforced them. Wiring the linter is the repo owner's job, and so is leaving a
rule in `model` until then (`status` and `check.type` are hand-editable). The
engine takes no position: it never runs a lint rule, in any repo, and never
rewrites a rubric.

```bash
python3 eval/rules_eval.py extract    # your transcripts -> real edits
python3 eval/rules_eval.py run        # cases + real edits, cached
python3 eval/rules_eval.py report
```

Reproduce the router numbers on your own history:

```bash
python3 eval/replay.py extract                     # your transcripts -> dataset
python3 eval/replay.py run --variant v7_no_unclear # cached; re-runs are free
python3 eval/replay.py run --variant v8_tier       # tier question, cache-shared with v8_shipped
python3 eval/replay.py report --variant v8_tier --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai`. Start with `--sample 250`
if that matters for your repos.

Replay measures what the router *would* have said. `/claude-jev:stats` measures
what it did say, on sessions you actually ran.

## Default vs claude-jev, on real sessions

`eval/compare.py` pairs the plugin against default Claude Code on your own
transcripts.

**Compaction.** Every `compact_boundary` in `~/.claude/projects` is a paired
sample. The transcript records what the built-in summarizer injected. Replaying
the same pre-boundary blocks through the plugin shows what Jev's selection
would have injected. `--synth N` grows the corpus past the handful of real
boundaries. Any session whose judge-visible content passes ~100k chars with at
least 30 blocks of structure gets a synthetic cut. That is the range the real
boundaries fired at. `claude -p` writes the default-side summary from the same
conversation, which gives a labeled copy of the built-in routine.

Across 77 compaction points (6 real boundaries and 71 synthetic cuts):

| | default: summary + tail | jev: selection digest |
|---|---|---|
| context injected per event | ~4.2k tok | ~0.8–1.8k tok |
| time to compact | ~2 min | ~1 s |
| re-fetch coverage | ~59–91% mentioned | ~60–82% verbatim |

After each point the agent re-fetched 818 files/searches/urls it had already
fetched. Under the six real compactions the default summary still mentioned 91%
of those paths, and the re-reads happened anyway, because a mention is not the
content. On the larger synthetic set both sides land near 60% coverage, but
they carry different things. The summary holds a pointer. Jev's digest holds
the bytes, the reads an agent wouldn't need to repeat, at roughly 40% of the
injected tokens and ~1% of the wall time. Scope explains the gap: ~40% of
re-fetched artifacts fall outside Jev's 45-block judgment window or its keep
floor. A summary compresses everything; a selection drops what scored low.
Per-event rows land in `eval/data/compare_compact.jsonl`, and summaries and
judgments cache in `eval/data/compact_cache.jsonl`, so re-runs and bigger
`--synth` are incremental.

**Router.** Joining the shipped hints to what the unhinted agent did next
(1,613 real prompts): hints fired on 42%. Only the no-tools gate has a
measurable counterfactual. On the 70 prompts Jev would have steered to "answer
directly", default Claude made 151 tool calls across 17 prompts that used tools
anyway. The split matters. 13 of those calls were small lookups the hint saves.
138 sat in 8 sessions that needed the tools, the harmful-hint failure the eval
already tracks. The gate saves small lookups and sometimes costs a session real
work, which is why it stays near-certain-only.

## Design notes

- **Fail open.** Any error, missing key, or timeout produces no output and
  never blocks a prompt. Prompts go to `api.typesafe.ai` for classification;
  slash commands, `#` lines, and prompts under 3 chars are skipped locally.
- **The taxonomy is what survived measurement.** The bundle dropped `refactor`,
  `unclear`, and `needs_repo`. The first two never reached usable precision,
  and a hardcoded "yes" beat `needs_repo` by 18 points. A smaller taxonomy
  scores higher and helps less: collapsing to talk/read/act reaches 58.8%, but
  always guessing "act" reaches 64.7%. The model is reliable exactly where the
  default assumption already is.
- **`scripts/observed.py` is the scorer.** It decides what a past turn did
  (read, edit, ops, nothing), and both the eval harness and `/claude-jev:stats`
  score against it, so changing it moves every number above. Routing lives in
  `scripts/prompt_router.py`, question definitions in
  `scripts/jev.py::intent_bundle`. Edit either and re-run `eval/`; the shipped
  bundle is meant to stay identical to the measured one.
- **Why the manual path composes `/clear`.** `/compact` is excluded from the
  Skill tool, and `PreCompact`/`PostCompact` output is discarded.
  `SessionStart` is the only post-compaction event that can inject context, so
  `/claude-jev:compact` selects, `/clear` drops everything, and the
  `clear`-matched hook restores the selection. Digests are keyed by working
  directory with a 10-minute TTL, so they only ever land in the session they
  were made for.
- **Selection keeps bytes, not prose.** Sidechains, slash-command echoes, and
  one-word acks are filtered before Jev sees anything. Each remaining block
  gets two `noul` judgments: *still needed at all* and *needed verbatim*. A
  `no` on the second keeps a truncated head plus a re-read pointer. Most bulk
  is tool output the agent can re-fetch, while exact errors and constraints
  stay whole. A kept `tool_result` pulls its `tool_use` in with it. Kept blocks
  are verbatim bytes, cut at paragraph breaks. The 40k cap is enforced by
  downgrading the lowest-confidence keeps. So selection can shrink history, but
  it can never let the compacted context grow without bound, the failure mode
  of keeping user and assistant text forever.
