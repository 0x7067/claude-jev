# claude-jev

Agents burn the expensive model on small judgments: what is this prompt, how big is it, does it need tools, which rule does this edit break. This plugin hands those to [TypeSafe's Jev](https://docs.typesafe.ai/introduction) — a System One model that returns typed judgments, not text. It doesn't write code.

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

Bytes, not prose: harness rows (slash-command wrappers, caveats) and one-word acks are dropped locally. Each row gets two judgments — needed at all, needed verbatim. Kept plain messages come back byte-identical; kept tool calls and results come back as text, and a no on the second question keeps a truncated head plus a re-read pointer. Unscored rows are kept. A fixed one-line header opens the compacted context.

Limits: newest 150 rows judged, kept text capped at 8k chars (lowest-confidence keeps downgraded first), nothing replaced under a 25% shrink — a weak selection falls through to the built-in summary. So does a missing key, a Jev outage, or any error in the bridge.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set `TYPESAFE_API_KEY` — the only variable, required; without it hooks disable silently. Needs `python3`, stdlib only.

## Does it work?

### Rule hook

Judged inside real repos against those repos' own rules, on corpora that aren't committed (they need the repos). `eval/rules_eval.py extract` pulls reachable Edits/Writes from `~/.claude/projects`; those were accepted at the time, so any block is a measured false positive.

250-edit sample, 248 judged: **3 blocked (1.2%)**, 38 flagged, median 0.70s at median 10 questions. Hand-written violations of real rules: 12 of 19 blocked, all by the targeted rule; **0 of 13 near-misses blocked**. The misses cluster under the bar (0.52–0.76) plus rules buried in dense prose `AGENTS.md`, which classifies poorly.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

### Router

`eval/replay.py` replays your past prompts, scored by `scripts/observed.py` (change it and every number moves). On 1,613 prompts the shipped taxonomy (v7) gives 42% coverage, 34.6% accuracy, **+6.0 lift** over always guessing, and **8 harmful hints** — "no tools" followed by 5+ tool calls. Coarser taxonomies score higher and help less (talk/read/act: 58.8% vs. a 64.7% constant guess). 34.6% is a floor: labels come from transcripts, and on 120 hand-labeled prompts (`eval/audit_labels.json`) humans agreed with derived labels only 52.5% of the time.

### Jev selection vs. default summary

`eval/compare.py` replays pre-compaction blocks at each `compact_boundary` (12 real, 60 synthetic): 1.8–2.0k tok injected vs. 2.4–5.0k, ~0.9s vs. ~117s to compact. Of 710 artifacts the agent re-fetched post-compaction, the summary mentioned 72–91% and the digest held 60–71% verbatim — a mention isn't the content. The rest fell outside the judgment window or below the keep floor.
