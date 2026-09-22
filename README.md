# claude-jev

Agents burn the expensive model on small judgments: what is this prompt, how big is it, does it need tools, which rule does this edit break, which turns still matter when the context fills up. This plugin hands those to [TypeSafe's Jev](https://docs.typesafe.ai/introduction) — a System One model that returns typed judgments, not text. It doesn't write code.

## What it does

| Hook | Job |
|---|---|
| `UserPromptSubmit` | Classify the prompt, inject a one-line routing hint |
| `PreToolUse` (`Agent\|Task`) | Pick the model tier a subagent spawns on |
| `PostToolUse` (edits) | Judge the edit against your instruction files |
| `Stop` | Judge the whole turn against the rules that need it |
| `session.compact` (experimental function hook) | Replace the compaction summary with the rows Jev kept; the summarizer never runs |

All five fail open: any error, missing key, or timeout produces no output and never blocks a prompt; the compaction hook falls through to Claude Code's own summary. Slash commands, `#` lines, and prompts under 3 characters are skipped locally.

### Routing

One API call per prompt — intent, scope, needs-tools, tier — plus the previous turn, since most prompts are follow-ups. `lookup` → one search. `fix` → focused edit, narrow verification. `feature` → brief plan first. `ops` → run it and report. Below 0.75 confidence, nothing.

The no-tools hint is gated harder: it fires only on a near-certain yes/no answer, because skipping needed work is the expensive mistake. The tier answer is advisory — a confident mismatch with the recorded model surfaces as a `systemMessage` the agent never sees — except on subagent spawn, where `updatedInput` sets `model`. An explicitly set model always wins.

### Rules

Rules are the instruction files you already keep (`CLAUDE.md`, nested `AGENTS.md`, `.claude/rules/*`, `.cursor/rules/*`, `~/.claude/CLAUDE.md`). Nothing to compile, nothing extra to commit.

Each file is classified once per hash and cached under `~/.claude`: instruction about written code vs. fact/pointer/process rule, per-edit vs. whole-turn, and two more fields that shape the question — polarity (forbid or require) and subject (imports, comments, naming, types, tests, errors, literals, files, process, other). Long prose paragraphs are split into sentences first, so a rule at the tail of a paragraph is judged on its own. Before asking, a cheap local test per subject drops rules the hunk cannot break: an import rule is not asked about an edit that touches no import line. On 250 real edits that removed 40% of in-scope checks and cut the median from 10 questions to 4.

Each edit is one batched call, one yes/no question per remaining rule, asked as a concrete check by polarity — does the new code do the forbidden thing, or add a case the rule clearly covers without the required element — with criteria, scored as probability broken. Jev sees the old→new hunk, your last prompt, the surrounding lines after the edit, and for import rules the sibling modules in the file's directory. At most 40 questions per edit, path-scoped rules first with files taking turns.

Three subjects also get a deterministic lookup first: the repository is searched with ast-grep for the constant that already holds a literal the edit inlines, an assertion whose two sides are identical, and the callers of a function whose error handling changed. A fourth, the declaration of a type a cast names, was measured and dropped: it read as evidence the cast was sound. This is the comparison the judge cannot make from a hunk, and on the hand-written cases it turned a swallowed error from 0.54 to 0.82 and a tautological test from silent to flagged, with no compliant edit moving. It reaches 7 of 250 real edits and costs a median 0.05 s on those. The 51 MB binary is pinned by sha256 and fetched once on first use, in a detached process; until it lands, and on any failure, every lookup returns nothing.

At 0.80 the edit is blocked with a file:line cite; below 0.50, silence. A rule landing between the two gets one more call, all such rules in one request, with the enclosing function read from disk after the edit and the sentences around the rule in its instruction file; the second answer decides, and what is still uncertain flags to you only. About 8% of edits pay for the second call. A rule blocks the same file at most twice per session, then flags — an unlandable repair is a loop. Vendored, generated, and out-of-project paths are never judged. Whole-turn rules (minimal changes, no single-caller abstraction, no unrelated refactoring) skip per-edit and judge accumulated hunks at `Stop`, where scope creep is visible.

### Compaction

Requires Claude Code 2.1.278 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (an undocumented, gated feature; see `docs/claude-code-compaction-research.md` for what was verified). `hooks/register.ts` hooks `session.compact`: `/compact`, auto-compaction, and the `/rewind` summaries hand the conversation to Jev as rows, and the rows it keeps become the whole post-compaction context. No summary is written, and compaction takes under a second instead of 30-60 s. Without the flag, Claude Code compacts as it always did; the plugin adds nothing to that path.

Bytes, not prose: harness rows (slash-command wrappers, caveats) and one-word acks are dropped locally. Each row gets five concrete yes/no checks — states a user constraint, records a decision and its reason, holds an exact error, names open work, shows re-fetchable tool output — and the policy in code turns them into a verdict: the strongest of the first four is the keep score; constraint or error high means verbatim, otherwise a truncated head plus a re-read pointer. Kept plain messages come back byte-identical; kept tool calls and results come back as text. Unscored rows are kept. A fixed one-line header opens the compacted context. Text typed after `/compact` is named in the state, and every check defers to it. On 56 recorded sessions with a constraint planted mid-transcript and a restatement buried at the end of a later reply, the planted prompt survived 100% (was 77% under the earlier two aggregate questions) and the buried restatement 98% (was 35%); see `eval/planted.py`.

Limits: newest 150 rows judged, kept text capped at 16k chars (lowest-confidence keeps downgraded first). Jev's rows replace the summary whatever the shrink; only a missing key, a Jev outage, or an error in the bridge falls through to the built-in summary.

To see which path ran, start Claude Code with `-d` and read `~/.claude/debug/<session-id>.txt` after a compaction: `a hook's N messages stand (hooked by claude-jev); core never ran` means Jev's rows replaced the summary; `jev-compact: ... built-in summary runs` names why it fell through.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set `TYPESAFE_API_KEY` — the plugin's only variable, required; without it hooks disable silently. Needs `python3`, stdlib only.

The rule hook's comparators use [ast-grep](https://ast-grep.github.io) 0.45.3. If it is not on your PATH the plugin fetches the pinned release once to `~/.claude/jev-bin`, verified by sha256, in a detached process the first time an edit needs it; every hook works without it. To warm it up or see which binary would run:

```bash
python3 scripts/comparators.py fetch
python3 scripts/comparators.py which
```

Compaction additionally needs Claude Code 2.1.278 or later started with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. That is Claude Code's own switch for its experimental function hooks, off by default; the four other hooks work without it. Function-hook modules also load only in a trusted workspace, and not for subagents.

## Does it work?

### Rule hook

Judged inside real repos against those repos' own rules, on corpora that aren't committed (they need the repos). `eval/rules_eval.py extract` pulls reachable Edits/Writes from `~/.claude/projects`; those were accepted at the time, so any block is a measured false positive.

Same 250-edit sample, judged at each edit's commit, before and after the structured-rule change (v0.15.0):

| | v0.13.0 | v0.15.0 |
|---|---|---|
| Real edits blocked | 4 (1.6%) | **1 (0.4%)** |
| Real edits flagged only | 32 | 20 |
| Hand-written violations blocked | 14/19 | 14/19 |
| Compliant near-misses blocked | 0/13 | **0/14** |
| Rules asked per edit, median | 10 | 4 |
| Latency, median | 0.71s | 0.71s |

With escalation on, real flags fall from 20 to 14 and p90 latency from 0.85s to 0.73s at 2 real blocks. The remaining misses cluster under the bar (0.56–0.78) or target rules no instruction file states. On 20 further hand-written pairs from three repos, the judge caught every violation visible in the added text itself (a bare constant, a missing annotation, a hand-rolled mock, a narrating comment) and none that need a comparison with something outside the hunk (a literal that duplicates an existing constant, an unsound `as` cast, a swallowed error, a test that cannot fail). Slicing the hunk by subject and per-rule thresholds were both measured; neither moved those, and slicing cost a catch, so it is out and thresholds are opt-in via `report --write-calib`. The one near-miss added in v0.15.0 is a live false positive: a sibling-module import blocked at 0.86 under a "standard library only" rule; with the sibling list in the state it scores 0.74, flagged but not blocked. `report --sweep` shows the real-block rate flat from 0.70 to 0.85, so `ACT` sits on a plateau, not a cliff.

Both corpora are weak labels. A real edit counts as compliant because nobody objected at the time, and the hand-written set is small enough that one case is a five-point swing. The live decision log now records what happened after each block (repaired, retried identical, ignored, abandoned), which is the signal for growing the case set; see `/claude-jev:stats`.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

### Router

`eval/replay.py` replays your past prompts, scored by `scripts/observed.py` (change it and every number moves). On 1,613 prompts the shipped taxonomy (v7) gives 42% coverage, 34.6% accuracy, **+6.0 lift** over always guessing, and **8 harmful hints** — "no tools" followed by 5+ tool calls. Coarser taxonomies score higher and help less (talk/read/act: 58.8% vs. a 64.7% constant guess). 34.6% is a floor: labels come from transcripts, and on 120 hand-labeled prompts (`eval/audit_labels.json`) humans agreed with derived labels only 52.5% of the time.

### Jev selection vs. default summary

`eval/compare.py` replays the pre-compaction blocks at each `compact_boundary` in recorded transcripts (12 real, 60 synthetic) through the same selection the hook runs: 3.2–3.9k tok of kept context vs. the 2.4–5.0k tok summary it replaces, ~0.9–1.1s vs. ~117s to compact. Of 710 artifacts the agent re-fetched post-compaction, the summary mentioned 73–91% and the kept blocks held 76–82% verbatim — a mention isn't the content. The rest fell outside the judgment window or below the keep floor.

Live, through the `session.compact` hook on Claude Code 2.1.278 (one session each, not a sweep): a 15-row session compacted in 0.7s with 7 rows kept, and a 5-row session fell through to the built-in summary at 0% reduction under the since-removed 25% shrink gate. The selection is the same code the eval measures; the eval numbers are the ones to trust.
