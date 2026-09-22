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

Each file is classified once per hash and cached under `~/.claude`: instruction about written code vs. fact/pointer/process rule, and per-edit vs. whole-turn. Each edit is one batched call, one yes/no question per rule in your own wording, scored as probability broken. Jev sees the old→new hunk plus your last prompt. At most 40 questions per edit, path-scoped rules first with files taking turns.

At 0.80 the edit is blocked with a file:line cite; 0.50–0.80 flags to you only; below that, silence. A rule blocks the same file at most twice per session, then flags — an unlandable repair is a loop. Vendored, generated, and out-of-project paths are never judged. Whole-turn rules (minimal changes, no single-caller abstraction, no unrelated refactoring) skip per-edit and judge accumulated hunks at `Stop`, where scope creep is visible.

### Compaction

Requires Claude Code 2.1.278 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (an undocumented, gated feature; see `docs/claude-code-compaction-research.md` for what was verified). `hooks/register.ts` hooks `session.compact`: `/compact`, auto-compaction, and the `/rewind` summaries hand the conversation to Jev as rows, and the rows it keeps become the whole post-compaction context. No summary is written, and compaction takes under a second instead of 30-60 s. Without the flag, Claude Code compacts as it always did; the plugin adds nothing to that path.

Bytes, not prose: harness rows (slash-command wrappers, caveats) and one-word acks are dropped locally. Each row gets two judgments — needed at all, needed verbatim. Kept plain messages come back byte-identical; kept tool calls and results come back as text, and a no on the second question keeps a truncated head plus a re-read pointer. Unscored rows are kept. A fixed one-line header opens the compacted context. Text typed after `/compact` is named in the state, and both judgments defer to it.

Limits: newest 150 rows judged, kept text capped at 16k chars (lowest-confidence keeps downgraded first). Jev's rows replace the summary whatever the shrink; only a missing key, a Jev outage, or an error in the bridge falls through to the built-in summary.

To see which path ran, start Claude Code with `-d` and read `~/.claude/debug/<session-id>.txt` after a compaction: `a hook's N messages stand (hooked by claude-jev); core never ran` means Jev's rows replaced the summary; `jev-compact: ... built-in summary runs` names why it fell through.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set `TYPESAFE_API_KEY` — the plugin's only variable, required; without it hooks disable silently. Needs `python3`, stdlib only.

Compaction additionally needs Claude Code 2.1.278 or later started with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. That is Claude Code's own switch for its experimental function hooks, off by default; the four other hooks work without it. Function-hook modules also load only in a trusted workspace, and not for subagents.

## Does it work?

### Rule hook

Judged inside real repos against those repos' own rules, on corpora that aren't committed (they need the repos). `eval/rules_eval.py extract` pulls reachable Edits/Writes from `~/.claude/projects`; those were accepted at the time, so any block is a measured false positive.

250-edit sample, 248 judged: **3 blocked (1.2%)**, 38 flagged, median 0.70s at median 10 questions. Hand-written violations of real rules: 14 of 19 blocked, all by the targeted rule; **0 of 13 near-misses blocked**. Two of those catches came from rewriting prose `AGENTS.md` paragraphs as bullets, not from tuning: a rule at the tail of a 600-character paragraph is truncated before Jev sees it. The remaining misses cluster under the bar (0.56–0.78) or target rules no instruction file states.

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
