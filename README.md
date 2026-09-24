# claude-jev

Coding agents spend the expensive model on small judgments. What kind of prompt is this, and how big? Does it need tools? Which rule does this edit break? Which turns still matter when the context fills up? This plugin sends those questions to [TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model that answers with typed judgments instead of text. Jev doesn't write code.

| Hook | Job |
|---|---|
| `UserPromptSubmit` | Classify the prompt and add a one-line routing hint |
| `PreToolUse` (`Agent\|Task`) | Pick the model tier a subagent spawns on, and check its brief |
| `PostToolUse` (edits) | Judge the edit against your instruction files |
| `PreToolUse` / `PostToolUse` (`Bash`) | Snapshot the git working tree around each command, so `Stop` sees what it changed |
| `Stop` | Judge the whole turn against the rules that need it |
| `session.compact` (experimental function hook) | Replace the compaction summary with the rows Jev keeps, so the summarizer never runs |

Every hook fails open. An error, a missing key, or a timeout produces no output and never blocks a prompt, and the compaction hook falls back to Claude Code's own summary. Slash commands, `#` lines, and prompts under 3 characters never reach Jev.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Then set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Without a key, the hooks turn themselves off silently. The plugin needs `python3` and nothing outside its standard library.

If both variables are set, the plugin reads `TYPESAFE_API_KEY` first. A key that starts with `sk-or-`, in either variable, sends every call to [OpenRouter](https://openrouter.ai/docs/guides/community/jev)'s System One API instead of `api.typesafe.ai`. To use OpenRouter while both are set, pick it in the Provider row of `/claude-jev` or `/config`; a pinned provider reads only its own variable.

Compaction needs Claude Code 2.1.278 or later, started with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. That flag is Claude Code's own switch for its experimental function hooks. It's off by default and undocumented; `docs/claude-code-compaction-research.md` records what was verified. Function-hook modules load only in a trusted workspace, and never for subagents. The other hooks work without the flag.

Leave auto-compact on (the Auto-compact row in `/config`, stored as `autoCompactEnabled` in `~/.claude/settings.json`). With the flag set, auto-compaction goes through Jev like `/compact` does. With auto-compact off, a session runs until it hits the context limit, and then you have to run `/compact` yourself.

The same flag turns `/claude-jev` into a settings pane. There you can save an API key for all sessions, pick the provider, turn each hook on or off, and see the last Jev call. A key in the launch environment wins over the saved one. The Stats row shows the `scripts/stats.py` report: how the router's hints matched what sessions did, rule calibration, and compaction. Without the flag, the four on/off rows are in `/config`.

The rule hook's comparators use [ast-grep](https://ast-grep.github.io) 0.45.3. If it isn't on your PATH, a detached process fetches the pinned release to `~/.claude/jev-bin` the first time an edit needs it, and checks its sha256. Every hook works without it. To fetch it now, or to see which binary would run:

```bash
python3 scripts/comparators.py fetch
python3 scripts/comparators.py which
```

## Routing

Each prompt costs one API call, which asks for intent, scope, whether tools are needed, and a model tier. The call includes the previous turn, because most prompts are follow-ups. A `lookup` gets the hint "one search", and a `fix` gets "focused edit, narrow verification". `feature` and `ops` get no hint at all: live and in replay, those hints were wrong more often than right. Below 0.75 confidence, the router stays silent.

The no-tools hint has a higher bar. It fires only on a near-certain yes/no answer, because skipping work that was needed is the expensive mistake. The tier answer is advisory: when it confidently disagrees with the recorded model, the hook emits a `systemMessage`, which the agent never sees.

Subagent spawns are different. There the hook sets `model` through `updatedInput`, unless the call already names a model; an explicit model always wins. The tier question has four options. Its shipped text calls `fable` rare, meant for work where a cheaper tier would likely return a confident wrong answer, and never for implementation. You can replace that text with a `## Delegating to sub-agents` section in `~/.claude/CLAUDE.md` that has `- haiku: …`, `- sonnet: …`, `- opus: …`, and `- fable: …` bullets.

The same call reviews the brief. When Jev is confident the task changes files, four yes/no checks ask whether the brief names the paths, states acceptance criteria, names a verification command, and states a commit policy. Any part scored at or below 0.25 counts as missing. The hook denies the spawn once and lists the missing parts, so the parent can rewrite the prompt. If the same brief comes back in that session, it goes through with a `systemMessage`. Read-only briefs skip the checks.

## Rules

Rules come from the instruction files you already keep: `CLAUDE.md`, nested `AGENTS.md`, `.claude/rules/*`, `.cursor/rules/*`, and `~/.claude/CLAUDE.md`. Nothing needs compiling, and nothing extra gets committed.

The hook classifies each file once per hash and caches the result under `~/.claude`. A rule is either an instruction about written code or a fact, pointer, or process rule, and it applies per edit or to the whole turn. Two more fields shape the question Jev gets: polarity (forbid or require) and subject (imports, comments, naming, types, tests, errors, literals, files, process, other). Long prose paragraphs are split into sentences first, so a rule at the end of a paragraph is judged on its own.

Before asking anything, a cheap local test per subject drops the rules a hunk can't break. An import rule, for instance, is never asked about an edit that touches no import line. On 250 real edits, this removed 40% of in-scope checks and cut the median from 10 questions to 4.

Each edit then costs one batched call, with a yes/no question per remaining rule. Polarity picks the question: does the new code do the forbidden thing, or does it add a case the rule clearly covers without the required element? Jev scores each one as the probability the rule is broken. It sees the old→new hunk, your last prompt, and the lines around the edit. For import rules it also sees the sibling modules in the file's directory. An edit gets at most 40 questions, with path-scoped rules first and files taking turns.

Some violations can't be seen in a hunk. Three subjects get a deterministic ast-grep search of the repository first. The search looks for the constant that already holds a literal the edit inlines, an assertion whose two sides are identical, and the callers of a function whose error handling changed. On the hand-written cases, the lookups moved a swallowed error from 0.54 to 0.82 and turned a tautological test from silent to flagged, and no compliant edit moved. A fourth lookup, the declaration of the type a cast names, was measured and dropped, because Jev read it as evidence the cast was sound. The lookups reach 7 of 250 real edits and cost a median 0.05 s on those. The binary is 51 MB, pinned by sha256, and fetched once in a detached process. Until it lands, or if anything fails, every lookup returns nothing.

At 0.80 the hook blocks the edit and cites file:line. Below 0.50 it says nothing. A rule that lands between the two gets a second call, with all such rules in one request. That call adds the enclosing function, read from disk after the edit, and the sentences around the rule in its instruction file. The second answer decides, and anything still uncertain is flagged to you only. About 8% of edits pay for that second call.

A rule blocks the same file at most twice per session and only flags after that, since an unlandable repair would loop. Vendored, generated, and out-of-project paths are never judged. Whole-turn rules, such as minimal changes, no single-caller abstraction, and no unrelated refactoring, skip the per-edit check. The `Stop` hook judges them against all of the turn's hunks, where scope creep shows. It sees only hunks made since the latest user prompt, and skips a turn with none. Bash commands count too: a snapshot of the git working tree, untracked files included, is taken before each command and diffed after it. When a snapshot fails, for example outside a git repository, Jev is told the diff is partial.

## Compaction

`hooks/register.ts` hooks `session.compact`. On `/compact`, auto-compaction, and `/rewind` summaries, it hands the conversation to Jev as rows, and the rows Jev keeps become the whole post-compaction context. No summary is written. Compaction takes under a second instead of 30–60 s. Without the flag, Claude Code compacts as it always has, and the plugin adds nothing to that path.

The hook keeps bytes, not prose. Harness rows (slash-command wrappers, caveats) and one-word acks are dropped locally. Every other row gets five concrete yes/no checks: does it state a user constraint, record a decision and its reason, hold an exact error, name open work, or show re-fetchable tool output? Code then turns the answers into a verdict. The keep score is the strongest of the first four checks. A row with a high constraint or error score stays verbatim, and any other kept row becomes a truncated head plus a pointer to re-read it.

Kept plain messages come back byte-identical, and kept tool calls and results come back as text. Unscored rows are kept. A fixed one-line header opens the compacted context. Any text you type after `/compact` is named in the state, and every check defers to it.

Jev judges only the newest 150 rows. Kept text is capped at 16k chars, and the lowest-confidence keeps are downgraded first. Jev's rows replace the summary however much they shrink it. Only a missing key, a Jev outage, or an error in the bridge falls through to the built-in summary.

To see which path ran, start Claude Code with `-d` and read `~/.claude/debug/<session-id>.txt` after a compaction. `a hook's N messages stand (hooked by claude-jev); core never ran` means Jev's rows replaced the summary. `jev-compact: ... built-in summary runs` means the bridge fell through, and the line says why.

## Does it work?

### Rule hook

The rule eval judges edits inside real repos, against those repos' own rules, so its corpora aren't committed. `eval/rules_eval.py extract` pulls the reachable Edits and Writes from `~/.claude/projects`. Those edits were accepted at the time, so any block counts as a measured false positive.

The table compares the same 250-edit sample, judged at each edit's commit, before and after the structured-rule change in v0.15.0:

| | v0.13.0 | v0.15.0 |
|---|---|---|
| Real edits blocked | 4 (1.6%) | **1 (0.4%)** |
| Real edits flagged only | 32 | 20 |
| Hand-written violations blocked | 14/19 | 14/19 |
| Compliant near-misses blocked | 0/13 | **0/14** |
| Rules asked per edit, median | 10 | 4 |
| Latency, median | 0.71s | 0.71s |

With escalation on, real flags drop from 20 to 14 and p90 latency from 0.85s to 0.73s, at 2 real blocks. `report --sweep` shows the real-block rate flat from 0.70 to 0.85, so `ACT` sits on a plateau, not a cliff. The misses that remain either score just under the bar (0.56–0.78) or break rules that no instruction file states.

On 20 more hand-written pairs from three repos, the judge caught every violation visible in the added text: a bare constant, a missing annotation, a hand-rolled mock, a narrating comment. It caught none of the ones that need a comparison with something outside the hunk: a literal that duplicates an existing constant, an unsound `as` cast, a swallowed error, a test that can't fail. Slicing the hunk by subject didn't help and cost a catch, so it's out. Per-rule thresholds didn't help either, and they're opt-in via `report --write-calib`.

The one near-miss added in v0.15.0 is a live false positive. A sibling-module import was blocked at 0.86 under a "standard library only" rule. With the sibling list in the state, it scores 0.74, which flags it without blocking.

Both corpora are weak labels. A real edit counts as compliant because nobody objected at the time, and the hand-written set is small enough that one case swings the score five points. The live decision log now records what happened after each block (repaired, retried identical, ignored, abandoned), and that's the signal for growing the case set. See the Stats row in `/claude-jev`, or run `python3 scripts/stats.py`.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

Stats also reports failures by HTTP status or timeout, recent call health, and last failure/success timestamps per caller. Its rule outcome labels are heuristics: “repaired” means a later edit touched the flagged text, and “abandoned” means no later edit to that file. Neither verifies final compliance. Post-edit blocks do not undo writes. Calls alone cannot measure coverage because disabled hooks and missing keys produce no API call.

### Router

`eval/replay.py` replays your past prompts, and `scripts/observed.py` scores them. Change the scorer and every number here moves.

| 1,613 prompts, taxonomy v7 | Coverage | Accuracy | Lift over always guessing | Harmful hints |
|---|---|---|---|---|
| Every hint v7 predicts | 42% | 34.6% | **+6.0** | **8** |
| Only hints the hook shows | 13.8% | 50.2% | **+18.4** | **8** |

A harmful hint is "no tools" followed by 5+ tool calls. The first row counts the `feature` and `ops` hints the hook never shows. The second scores the hook as it ships:

```bash
python3 eval/replay.py report --variant v9_hinted_only --preds eval/data/pred_v7_no_unclear.jsonl
```

Humans labeled 16 of the hints the hook shows, and agreed with 11.

34.6% is a floor, because the labels come from transcripts. On 120 hand-labeled prompts (`eval/audit_labels.json`), humans agreed with the derived labels only 52.5% of the time. Coarser taxonomies score higher and help less: talk/read/act gets 58.8%, while a constant guess gets 64.7%.

### Compaction

`eval/compare.py` takes the pre-compaction blocks at each `compact_boundary` in recorded transcripts (12 real, 60 synthetic) and runs them through the selection the hook uses.

| | Jev selection | Default summary |
|---|---|---|
| Context after compaction | 3.2–3.9k tok | 2.4–5.0k tok |
| Time to compact | ~0.9–1.1s | ~117s |
| Of 710 artifacts re-fetched afterward | 76–82% held verbatim | 73–91% mentioned |

A mention isn't the content. The artifacts the kept blocks lacked fell outside the judgment window or below the keep floor.

`eval/planted.py` tests whether what the user said survives. On 56 recorded sessions, it plants a constraint mid-transcript and buries a restatement at the end of a later reply. The planted prompt survived 100% of the time, up from 77% under the earlier two aggregate questions. The buried restatement survived 98%, up from 35%.

The live hook has run on Claude Code 2.1.278, one session each rather than a sweep. A 15-row session compacted in 0.7s with 7 rows kept. A 5-row session fell through to the built-in summary at 0% reduction, under a 25% shrink gate that has since been removed. The live hook runs the same selection code the eval measures, so the eval numbers are the ones to trust.
