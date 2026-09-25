# claude-jev

Stop paying frontier-model prices for small judgments.

A coding agent makes dozens of quick calls every turn. What kind of prompt is this? Does it need tools? Does this edit break a rule in `CLAUDE.md`? Which turns still matter when the context fills up? This plugin sends those questions to [TypeSafe's Jev](https://docs.typesafe.ai/introduction). Jev is a System One model: it returns typed answers, not text, and it doesn't write code.

What you get:

- **Rules that hold.** Edits that break your instruction files get blocked with a file:line citation. The v0.21.0 run over the current corpus blocked 22 of 247 real edits (8.9%), 17 of them under a single repo's own comment-ban rule.
- **Compaction in about a second instead of a minute or two.** Jev keeps the exact rows that matter instead of writing a summary. Planted user constraints survived 100% of the time.
- **Right-sized subagents.** Each spawn gets a model tier. A brief that changes files but leaves out paths, acceptance criteria, verification, or commit policy is sent back once.
- **Routing hints.** Each prompt gets a one-line hint such as "one search" or "focused edit, narrow verification."

Every hook fails open. An error, a missing key, or a timeout produces no output and never blocks a prompt. Compaction falls back to Claude Code's own summary.

## Install

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Then set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Without a key, the hooks switch off silently. The plugin needs only `python3` and its standard library.

To turn on compaction and the `/claude-jev` settings pane, start Claude Code 2.1.278 or later with:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

The other hooks work without this flag.

### Keys and providers

- If both variables are set, the plugin reads `TYPESAFE_API_KEY` first.
- A key that starts with `sk-or-`, in either variable, sends every call to [OpenRouter](https://openrouter.ai/docs/guides/community/jev)'s System One API instead of `api.typesafe.ai`.
- To use OpenRouter while both are set, pick it in the Provider row of `/claude-jev` or `/config`. A pinned provider reads only its own variable.

### The function-hooks flag

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is Claude Code's own switch for its experimental function hooks. It's off by default and undocumented. `docs/claude-code-compaction-research.md` records what was verified. Function-hook modules load only in a trusted workspace, and never for subagents.

Leave auto-compact on. It's the Auto-compact row in `/config`, stored as `autoCompactEnabled` in `~/.claude/settings.json`. With the flag set, auto-compaction goes through Jev like `/compact` does. With auto-compact off, a session runs until it hits the context limit, and then you must run `/compact` yourself.

### The `/claude-jev` pane

With the flag set, `/claude-jev` opens a settings pane. Use it to:

- save an API key for all sessions (a key in the launch environment wins over the saved one)
- pick the provider
- turn each hook on or off
- see the last Jev call
- read the Stats row: the `scripts/stats.py` report on router hints against what sessions did, rule calibration, and compaction

Without the flag, the four on/off rows are in `/config`.

### ast-grep (optional)

The rule hook's comparators use [ast-grep](https://ast-grep.github.io) 0.45.3. If it isn't on your PATH, a detached process fetches the pinned release to `~/.claude/jev-bin` the first time an edit needs it, and checks its sha256. Every hook works without it. To fetch it now, or to see which binary would run:

```bash
python3 scripts/comparators.py fetch
python3 scripts/comparators.py which
```

## The hooks

| Hook | Job |
|---|---|
| `UserPromptSubmit` | Classify the prompt and add a one-line routing hint |
| `PreToolUse` (`Agent\|Task`) | Pick the model tier a subagent spawns on, and check its brief |
| `PostToolUse` (edits) | Judge the edit against your instruction files |
| `PreToolUse` / `PostToolUse` (`Bash`) | Snapshot the git working tree around each command, so `Stop` sees what it changed |
| `Stop` | Judge the whole turn against the rules that need it |
| `session.compact` (experimental function hook) | Replace the compaction summary with the rows Jev keeps, so the summarizer never runs |

Slash commands, `#` lines, and prompts under 3 characters never reach Jev.

## Rules

Rules come from the instruction files you already keep:

- `CLAUDE.md` and `~/.claude/CLAUDE.md`
- nested `AGENTS.md`
- `.claude/rules/*` and `.cursor/rules/*`

Nothing needs compiling, and nothing extra gets committed.

### How a rule is read

The hook classifies each file once per hash and caches the result under `~/.claude`. Each rule gets four fields:

- **Kind:** an instruction about written code, or a fact, pointer, or process rule.
- **Scope:** per edit, or the whole turn.
- **Polarity:** forbid or require.
- **Subject:** imports, comments, naming, types, tests, errors, literals, files, process, or other.

The hook splits long prose paragraphs into sentences first, so a rule at the end of a paragraph is judged on its own.

### How an edit is judged

1. **Filter locally.** A cheap test per subject drops the rules a hunk can't break. For example, an import rule is never asked about an edit that touches no import line. The v0.21.0 run had the filter remove 36% of in-scope checks; the median edit carried 14 rules in scope and was asked 8 questions.
2. **Look up context with ast-grep.** Some violations can't be seen in a hunk. Three subjects get a deterministic search of the repository first. The search finds the constant that already holds a literal the edit inlines, an assertion whose two sides are identical, and the callers of a function whose error handling changed.
3. **Ask Jev once.** One batched call asks a yes/no question per remaining rule. Polarity picks the question: does the new code do the forbidden thing, or does it add a case the rule clearly covers without the required element? Jev scores each one as the probability the rule is broken. It sees the old→new hunk, your last prompt, and the lines around the edit. For import rules it also sees the sibling modules in the file's directory. An edit gets at most 40 questions, with path-scoped rules first and files taking turns.
4. **Decide.** At 0.80 the hook blocks the edit and cites file:line. Below 0.50 it says nothing.
5. **Escalate the unsure ones.** A rule between 0.50 and 0.80 gets a second call, with all such rules in one request. That call adds the enclosing function, read from disk after the edit, and the sentences around the rule in its instruction file. The second answer decides. Anything still uncertain is flagged to you only. About 14% of edits pay for that second call.

The ast-grep binary is 51 MB, pinned by sha256, and fetched once in a detached process. Until it lands, or if anything fails, every lookup returns nothing.

### Limits and whole-turn rules

- A rule blocks the same file at most twice per session and only flags after that, because an unlandable repair would loop.
- Vendored, generated, and out-of-project paths are never judged.
- Whole-turn rules skip the per-edit check. Examples: minimal changes, no single-caller abstraction, no unrelated refactoring. The `Stop` hook judges them against all of the turn's hunks, where scope creep shows.
- `Stop` sees only hunks made since the latest user prompt, and skips a turn with none.
- Bash commands count too. The hook snapshots the git working tree, untracked files included, before each command and diffs it after. When a snapshot fails, for example outside a git repository, Jev is told the diff is partial.

## Compaction

`hooks/register.ts` hooks `session.compact`. On `/compact`, auto-compaction, and `/rewind` summaries, it hands the conversation to Jev as rows. The rows Jev keeps become the whole post-compaction context. No summary is written. Compaction takes under a second instead of 30–60 s. Without the flag, Claude Code compacts as it always has, and the plugin adds nothing to that path.

The hook keeps bytes, not prose:

- Harness rows (slash-command wrappers, caveats) and one-word acks are dropped locally.
- Every other row gets five yes/no checks. Does it state a user constraint? Record a decision and its reason? Hold an exact error? Name open work? Would a rerun print the same output again?
- Code turns the answers into a verdict. The keep score is the strongest of the four keep checks.
- A row with a high constraint or error score stays verbatim — unless rerunnable answers yes, in which case the rerun would print it again and a head with the re-run pointer stands in for the whole dump. Any other kept row becomes a truncated head plus a pointer to re-read it.
- Kept plain messages come back byte-identical. Kept tool calls and results come back as text. Unscored rows are kept.
- A fixed one-line header opens the compacted context. Any text you type after `/compact` is named in the state, and every check defers to it.

Jev judges only the newest 150 rows with all five checks, plus the 150 before them with the constraint check alone, so a requirement stated early in a long session still reaches Jev. Kept text is capped at 16k chars, and the lowest-confidence keeps are downgraded first. Jev's rows replace the summary however much they shrink it. Only a missing key, a Jev outage, or an error in the bridge falls through to the built-in summary.

To see which path ran, start Claude Code with `-d` and read `~/.claude/debug/<session-id>.txt` after a compaction:

- `a hook's N messages stand (hooked by claude-jev); core never ran` means Jev's rows replaced the summary.
- `jev-compact: ... built-in summary runs` means the bridge fell through, and the line says why.

## Routing

### Prompts

Each prompt costs one API call. It asks for intent, scope, whether tools are needed, and a model tier. The call includes the previous turn, because most prompts are follow-ups.

- A `lookup` gets the hint "one search".
- A `fix` gets "focused edit, narrow verification".
- `feature` and `ops` get no hint. Live and in replay, those hints were wrong more often than right.
- Below 0.75 confidence, the router stays silent.
- The no-tools hint fires only on a near-certain yes/no answer, because skipping needed work is the expensive mistake.
- The tier answer is advisory. When it confidently disagrees with the recorded model, the hook emits a `systemMessage`, which the agent never sees.

### Subagents

For subagent spawns, the hook sets `model` through `updatedInput`, unless the call already names a model. An explicit model always wins.

The tier question has four options. Its shipped text calls `fable` rare: meant for work where a cheaper tier would likely return a confident wrong answer, and never for implementation. To replace that text, add a `## Delegating to sub-agents` section to `~/.claude/CLAUDE.md` with `- haiku: …`, `- sonnet: …`, `- opus: …`, and `- fable: …` bullets.

The same call reviews the brief. When Jev is confident the task changes files, four yes/no checks ask whether the brief:

- names the paths
- states acceptance criteria
- names a verification command
- states a commit policy

Any part scored at or below 0.25 counts as missing. The hook denies the spawn once and lists the missing parts, so the parent can rewrite the prompt. If the same brief comes back in that session, it goes through with a `systemMessage`. Read-only briefs skip the checks.

## Does it work?

### Rule hook

The rule eval judges edits inside real repos, against those repos' own rules, so its corpora aren't committed. `eval/rules_eval.py extract` pulls the reachable Edits and Writes from `~/.claude/projects`. Those edits were accepted at the time, so any block counts as a measured false positive.

The v0.21.0 run judged a fresh 250-edit extract, each edit at its own commit, with the AskUserQuestion answers of the 22 edits that had them composed into the request the way the hook sends them:

| | v0.21.0 |
|---|---|
| Real edits blocked | 22 (8.9%) |
| Real edits flagged only | 8 |
| Hand-written violations blocked | 17/29 |
| Compliant near-misses blocked | 0/24 |
| Rules asked per edit, median | 8 |
| Latency, median | 0.80s |

Most of the v0.21.0 blocks come from one repo's own `code-comments-are-banned-in` rule firing on 17 accepted edits (0.82–0.91): the current corpus reaches repos the old sample never did, so conflicts between a rule and the practice it governs are now visible in the number instead of hidden by the sample.

Both corpora are weak labels. A real edit counts as compliant because nobody objected at the time. The hand-written set is small enough that one case swings the score five points. The live decision log now records what happened after each block: repaired, retried identical, ignored, or abandoned. That's the signal for growing the case set. See the Stats row in `/claude-jev`, or run `python3 scripts/stats.py`.

```bash
python3 eval/rules_eval.py extract
python3 eval/rules_eval.py run --sample 250
python3 eval/rules_eval.py report
```

Stats also reports failures by HTTP status or timeout, recent call health, and last failure and success timestamps per caller. Its rule outcome labels are heuristics. "Repaired" means a later edit touched the flagged text. "Abandoned" means no later edit to that file. Neither verifies final compliance. Post-edit blocks do not undo writes. Calls alone cannot measure coverage, because disabled hooks and missing keys produce no API call.

### Router

`eval/replay.py` replays your past prompts, and `scripts/observed.py` scores them. Change the scorer and every number here moves.

Whether a shell command wrote anything is not guessed from its text. A Bash result in the transcript carries `bashEditDiff`, the file-state diff Claude Code took around the command, and it names the git-visible project files that changed — the same notion of a write the live hook uses, and the reason `then tee out`, `{ sed … ; }` and `perl -pi` all count while a scratch file in `/tmp` does not. Claude Code 2.1.274 started recording it. On older transcripts the command-text patterns still decide, and against that diff they measure precision 0.25 over 6,143 real Bash calls.

| 2,464 prompts, taxonomy v7 | Coverage | Accuracy | Lift over always guessing | Harmful hints |
|---|---|---|---|---|
| Every hint v7 predicts | 43.1% | 33.8% | **+8.3** | **8** |
| Only hints the hook shows | 14.1% | 48.0% | **+5.2** | **8** |

A harmful hint is "no tools" followed by 5+ tool calls. The first row counts the `feature` and `ops` hints the hook never shows. The second scores the hook as it ships:

```bash
python3 eval/replay.py run --variant v7_no_unclear
python3 eval/replay.py report --variant v7_no_unclear
python3 eval/replay.py report --variant v9_hinted_only --preds eval/observed/pred_v7_no_unclear.jsonl
```

Humans labeled 16 of the hints the hook shows, and agreed with 11.

33.8% is a floor, because the labels come from transcripts. On 120 hand-labeled prompts (`eval/audit_labels.json`), humans agreed with the derived labels only 51.7% of the time. Coarser taxonomies score higher and help less: collapsing to talk/read/act reaches 65.0%, but always guessing `act` gets 63.6%, so the three-way router earns 1.4 points over a constant (`python3 eval/replay.py report --variant v5_three_way`, over the 1,627 prompts its predictions are cached for).

### Compaction

`eval/compare.py` takes the pre-compaction blocks at each `compact_boundary` in recorded transcripts (12 real, 60 synthetic). It runs them through the selection the hook uses.

| | Jev selection | Default summary |
|---|---|---|
| Context after compaction | 3.2–3.9k tok | 2.4–5.0k tok |
| Time to compact | ~0.9–1.1s | ~117s |
| Of 710 artifacts re-fetched afterward | 76–82% held verbatim | 73–91% mentioned |

A mention isn't the content. The artifacts the kept blocks lacked fell outside the judgment window or below the keep floor.

`eval/planted.py` tests whether what the user said survives. On 56 recorded sessions, it plants a constraint mid-transcript and buries a restatement at the end of a later reply. The planted prompt survived 100% of the time, up from 77% under the earlier two aggregate questions. The buried restatement survived 98%, up from 35%.

The live hook has run on Claude Code 2.1.278, one session each rather than a sweep. A 15-row session compacted in 0.7s with 7 rows kept. The live hook runs the same selection code the eval measures, so trust the eval numbers.
