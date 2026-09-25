# Changelog

All notable changes to claude-jev. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the plugin manifest. `scripts/release.py` turns the `[Unreleased]` section into the next release.

## [Unreleased]

## [0.23.0] - 2026-09-25

- The scorer takes shell writes from Claude Code's own diff, not a regex. A Bash result's `toolUseResult` carries `bashEditDiff`, the file-state diff Claude Code took around the command, naming the git-visible project files it changed — the same notion of a write the live hook in `rules.py` already used, so the scorer and the hook now agree. `observed.walk_session` joins each Bash call to its result and hands `summarize` the changed paths; `summarize` treats that verdict as authoritative and lets it override the pattern in both directions, so a command that only wrote `/tmp` or a gitignored path no longer makes the turn an edit. Claude Code 2.1.274 is where the field first appears in the transcript corpus, so `BASH_DIFF_VERSION` gates it: below that, a missing field means "unknown" rather than "wrote nothing", and the patterns still decide.
- Measured against that diff as ground truth — 6,143 real Bash calls across the 145 sessions that record it — the command-text patterns score precision 0.25 and recall 0.84. Three quarters of the writes they claimed were a scratch file outside the project, a gitignored path, or a quoted string that happens to contain `>`, such as `curl -w '%{redirect_url}'`. The misses were writes the text cannot name at all: `docker compose run … pnpm add`, which edits `package.json` through a bind mount.
- The fallback patterns also lost two misses of their own, the same pair compact-adviser fixed in its PRs #52 and #53: `sed --in-place`, the GNU long form, which takes its backup suffix only attached with `=` and so is never ambiguous the way bare `-i` is; and a write, ops, or read command anchored after `then`, `else`, `do`, or `{`, or at the start of a line in a multi-line command, which the old `(^|[;&|]\s*)` position could not reach. `case $x in a) mkdir -p out ;; esac` still misses — a `)` prefix bought nothing on the corpus and would match subshells. Over the ground-truth set these move recall 0.843 to 0.846; they matter as correctness of the fallback, not as a measurement change.
- Labels moved on 262 of 4,857 rows (5.4%): `fix` 857 to 699, `lookup` 1634 to 1707, `feature` 793 to 840, `ops` 239 to 282, `chat` 1284 to 1297. Bash-changed files now count toward `n_files`, so a turn that wrote three files through the shell reaches the substantiality band the way a turn that wrote three through `Edit` already did. Re-scored over the whole current corpus with the same cached predictions (`eval/replay.py run --variant v7_no_unclear`, 2,449 of 2,464 rows cached, 15 new calls, 0 errors), holding the row set fixed to isolate the scorer: v7 accuracy 32.9% to 34.0% and lift +7.6 to +8.6, hinted-only accuracy 49.9% to 48.4% and lift +7.2 to +5.8, harmful hints 8 either way. Against the 120 hand labels in `eval/audit_labels.json` it is a wash — 52.5% to 51.7%, six rows changed, two toward the human label and three away.
- `README.md`'s router table is re-run on the current corpus rather than carried over: 2,464 prompts instead of 1,613, and every figure now reproduces from the commands printed beside it. The published coarse-taxonomy pair did not — 58.8% and 64.7% only come back at `--floor 0.5`, off the shipped 0.75 floor the rest of the table uses — so it is replaced by `v5_three_way` at the shipped floor, 65.0% against a constant 63.6%.

[0.23.0]: https://github.com/0x7067/claude-jev/compare/v0.22.0...v0.23.0

## [0.22.0] - 2026-09-25

- Compaction asks a fifth `rerunnable` check: output a rerun would print again — a listing, a passing check's log, build or install output, warnings a rebuild repeats. A rerunnable answer at `KEEP_THRESHOLD` silences `error`'s verbatim claim, so a regenerable dump keeps as a `HEAD_CHARS` head with the re-run pointer instead of `KEEP_CHARS` whole; an exact error no command would repeat, and any user constraint, still hold verbatim. The four keep reasons are unchanged, so pure noise still drops and its ref stays in the row list. Replaces rule-based scrubbing of verbose output with the same judgment Jev already makes per block. Gate behind it (`eval/compare.py compact --synth 60` on this source, 60 events, live re-judgment): re-fetch verbatim coverage 76.8% (floor 70%, n=760 reads — inside the standing 76-82% band), planted user constraint 100% (n=87), buried restatement 98.8% (n=82).
- `jev.ask` accepts a `deadline` (monotonic timestamp) alongside `timeout`, and retries once when a network failure returns in under a second — a refused connection costs milliseconds, a timeout costs the budget.
- The rules hook now works inside its 10s `hooks.json` budget instead of hoping two sequential Jev calls fit: `main` stamps a 9s deadline, every `ask` gets the time left, and the escalation pass is skipped when under 3s remain — the first-pass verdict still lands instead of the hook being killed with no output.
- Rule classification runs its per-chunk requests in parallel and caches by chunk content hash instead of whole-file hash. A large instruction file no longer serializes into a hook timeout, a killed classification keeps the chunks that landed, and editing one paragraph re-judges only its chunk.
- Compaction chunks ask with a 4s timeout instead of the 8s default, so one slow request can't stretch a ~1s compaction; a timed-out chunk's blocks are kept unscored, as before.
- Compaction asks four checks per block instead of five: the `artifact` check ("could this be re-fetched?") fed no decision — `verdicts` reads only the keep and verbatim scores — so it cost a fifth of every compaction request for a diagnostic nobody consumed. The `/compact <text>` directive moved from a suffix on every question to one line in the shared state header, where `session_context` already names it.
- Blocks just older than the 150-row judgment window are no longer dropped unseen: the 150 before them get the constraint check alone, and any that score a user requirement are kept verbatim ahead of the window's rows. A constraint stated early in a long session now reaches Jev instead of falling off the window silently.

- Ruff formats and lints the Python sources. `ruff.toml` selects pycodestyle errors (`E4`, `E7`, `E9`), Pyflakes (`F`), and import sorting (`I`), at a line length of 100, and skips `eval/observed` and `eval/authored`. It is tool config, not a dependency: hooks still import only the standard library. `ruff format --check` and `ruff check` run in release preflight and in GitHub Actions, next to `compileall` and the two `check_no_*.py` scripts. A machine with only `python3` can still claim those stdlib checks.
- `eval/data/` is now `eval/observed/` and `eval/private/` is now `eval/authored/` — the names say what they hold: machine-extracted transcripts and predictions vs hand-written cases. Both stay gitignored.

[0.22.0]: https://github.com/0x7067/claude-jev/compare/v0.21.0...v0.22.0

## [0.21.0] - 2026-09-24

- The rules eval now measures the AskUserQuestion answers the way the hook sends them. Its corpora carried only the typed request, so no rerun could see the v0.20.0 answers feature: `extract` records each edit's answers since its request, and `run` composes the request through the same `request_with_answers` the hook calls; the rules decision log rows gained a `user_answers` count, so live outcomes can split by whether the user answered questions. Extraction collects answers unconditionally, like the hook: an AskUserQuestion's result line normally carries no tool name, so the substring gate this replaces saw 5 answers-bearing edits where the corpus has 140 of 1,569 — enough that a normal 250-sample now measures the feature (~22 records). Records without answers compose to the old request text, so their cache entries still hit. The hook itself gains a fix: a transcript that could not be opened made `last_user_prompt` return a 2-tuple, crashing the handler before any rule was asked. `scripts/check_no_stubs.py` joins the Verify contract: `.ask =` assignments are banned everywhere except the `cached_ask` wiring shapes in `cmd_run`, so a probe cannot fake the client and present the result as verification. Live evidence through the real client: a313bcf9#932 ("rspec check in CI failed") reached the judge with its picked option and none acted, its re-judgment hitting at 0.0s the cache key only its answers-carrying state could produce; a synthetic result line with no tool name rides in the request exactly as the hook composes it. Records whose directory stopped being a git checkout drop their sha and join the live-checkout bucket the report already counts, instead of killing the run. The rerun on the new corpus: 300/303 judged, 0 errors; 22/247 real-edit blocks (8.9%), 17 of them symphony's own `code-comments-are-banned-in` rule (0.82–0.91) on accepted edits from before this change — none of the blocked rows carry answers; 17/29 violations blocked, 0/24 compliant; 22/247 edits carried AskUserQuestion answers, the line this change adds.

[0.21.0]: https://github.com/0x7067/claude-jev/compare/v0.20.0...v0.21.0

## [0.20.0] - 2026-09-24

- The rules hook counts the user's `AskUserQuestion` answers as part of the request. Jev saw only typed prompts, so an approval given by picking an option never reached it. In one session that blocked three approved edits: two to an axe spec (0.83, 0.85) and one to `feature_flag_spec.rb` (0.91), each under "do not weaken tests", after the user had picked the option that said the test expectation would change. The request now lists each answer since the latest prompt, as the question, the picked label and that option's description, capped at `MAX_ANSWER_CHARS`. Subagent results are skipped. The rules eval has not been rerun on this change.

[0.20.0]: https://github.com/0x7067/claude-jev/compare/v0.19.2...v0.20.0

## [0.19.2] - 2026-09-24

- The rules hook records what a Bash command changes. A `PreToolUse` hook snapshots the git working tree, untracked files included, in a scratch index. The matching `PostToolUse` diffs it and records each changed file as a hunk, so the `Stop` check judges shell writes like edits. A turn whose snapshot fails, such as outside a git repo, still tells Jev its diff is partial. Snapshots took under 0.7s on the five slowest repos checked.
- A failed Bash command's writes are recorded too, through a `PostToolUseFailure` hook. A turn with no recorded hunks but a partial diff still gets the `Stop` check, and so does a Bash write to a git-ignored path, which marks the diff partial.

[0.19.2]: https://github.com/0x7067/claude-jev/compare/v0.19.1...v0.19.2

## [0.19.1] - 2026-09-24

- The rules `Stop` check judges only the edits made since the latest user prompt, and skips a turn with none. It had pooled every edit since the session began and judged them against the newest prompt. In session `ccb4b920`, that blocked twice on approved `.zprofile`/`.zshenv` edits from an earlier turn (0.91, 0.92) and spent the session's block budget. Hunks are keyed by the transcript uuid of the prompt they were made under. The request and the repair message now name this turn's files. See `docs/stop-hook-false-positive.md`.
- When a turn with recorded edits also ran Bash, the `Stop` request tells Jev the diff is partial, since shell writes never reach the recorded hunks.
- The rules hook reads and writes its session state under a file lock. Twenty parallel writers kept 20 of 20 hunks; without the lock they kept 5. It logs a swallowed exception as a `rules-error` row, which stats never scores, so a missing decision row can be explained.
- `python3 eval/rules_eval.py turns` splits live Stop-hook checks by whether the turn made an Edit/Write of its own. It is offline and free. On the live log before the fix: 216 checks. 82 judged the turn's own edits (0 blocks, 30 flags). 107 came after Bash-only turns (2 blocks, 23 flags) and 27 after turns with no changes (0 blocks, 6 flags). Both blocks were the `ccb4b920` false positives. Under the turn scoping, those 134 checks and 29 flags no longer run.


- Add a bounded rule-prompt comparison tool and document a reviewed live false positive, evidence limits, and candidate questions. Shipped rule prompts and thresholds are unchanged.

- Stats breaks down failed calls by HTTP status or timeout for each caller, shows recent call health and last failure/success timestamps, and explains that rule outcomes are edit heuristics rather than verified repairs.

- `scripts/stats.py` lists `~/.claude/projects` once instead of globbing it for every session. On this machine the report went from 9.1s to 0.9s cold and from 2.15s to 0.59s warm, with byte-identical output on a frozen copy of the logs.
- The Status row in `/claude-jev` shows the status the pane already loaded as soon as it is pressed, then refreshes it from `jev.py status`.

[0.19.1]: https://github.com/0x7067/claude-jev/compare/v0.19.0...v0.19.1

## [0.19.0] - 2026-09-23

- The prompt router no longer shows an `ops` hint. Live, 18 of 60 were right; on the 120 hand-labeled prompts humans agreed with 6 of 18. With `feature` already silent, replaying 1,613 prompts through the shipped rule goes from 31.1% accuracy and −0.9 lift to 50.2% and +18.4, at 13.8% coverage. The cleaned live log goes from 49.5% (111 hints) to 72.5% (51 hints). An intent is silent by having no entry in `GUIDANCE`; `SILENT_INTENTS` is gone. `eval/variants.py` gains `v9_hinted_only`, which scores v7 answers only where the hook shows a hint.
- The `feature` silence (commit 0f67b21) cited 67 predictions against 6 observed; most of those predictions were compaction requests. It stays silent on current evidence: 8 of 28 right in the cleaned live log.
- `scripts/stats.py` scores only prompt-router entries; rule checks and subagent decisions were counted as suppressed prompts (1,040 reported, 351 real). It prints how many entries were Claude Code's own requests, reports the confidence floor as held-back count and hit rate (35 held back, 15 of them right, against 72.5% for the hints the router now shows) instead of counting `chat` predictions that never show, and calls a block with no transcript `unscorable` instead of `unknown`.
- `eval/replay.py report` and `compare` default `--floor` to `prompt_router.MIN_CONFIDENCE` (0.75) instead of 0.55, so the documented command reproduces the README row.
- `scripts/check_no_comments.py` scans only files git tracks or would track. It had been failing on the gitignored `eval/data/at/` checkouts.
- `AGENTS.md`: run hand-fed hook events with `CLAUDE_CONFIG_DIR` set to a temp directory. Test events with session ids like `t1` had landed in the live log, and were the 15 "unknown" rule outcomes.

- `scripts/stats.py` no longer scores Claude Code's own pre-compact request ("Your task is to create a detailed summary…") as a user prompt. Older plugin versions logged 73 of them with a hint, and the session that followed used no tools, so the report counted them as wrong `feature` hints against an inflated always-`chat` baseline. On the same log (1,316 decisions), the report moved from 72/195 agreed (36.9%) against 48.7% for always `chat`, to 58/122 (47.5%) against 26.2% for always `lookup`. The weak class is now `ops`: 60 hints, 20 observed.
- The prefix lives in `SYNTHETIC` in `scripts/observed.py`, so the router, stats, and `eval/replay.py` share one filter; `COMPACT_PROMPT` in `scripts/prompt_router.py` is gone. `eval/replay.py report --variant v7_no_unclear` is unchanged (1,613 scored, 33.7% accuracy, +4.4 lift): none of its predictions were compaction prompts. Derived labels still agree with `eval/audit_labels.json` on 63/120.

[0.19.0]: https://github.com/0x7067/claude-jev/compare/v0.18.0...v0.19.0

## [0.18.0] - 2026-09-23

- OpenRouter as a second Jev provider. Set `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` to an OpenRouter key (`sk-or-...`), and every call goes to `https://openrouter.ai/api/v1/systemone`, which takes the same request, model IDs, and answer shape. `TYPESAFE_API_KEY` is read first. A TypeSafe key still calls `api.typesafe.ai`. The Provider row in `/claude-jev` (`provider` in `/config`: `auto`, `typesafe`, `openrouter`) pins one provider and reads only its variable, so OpenRouter works with both variables set. Live through OpenRouter: a `noul` answered 0.99, and the prompt router answered in 472 ms. Each `jev-calls.jsonl` line records its `provider`.
- `/claude-jev` settings pane (needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`): save an API key for all sessions, see which provider it calls, turn the prompt router, subagent router, rule checks, and compaction on or off, and see the last Jev call. The on/off rows also appear in `/config`. A key in the environment wins over a saved key. `jev.py status` prints what the pane shows. The pane's Stats row shows the `scripts/stats.py` report.
- Removed the `/claude-jev:jev` and `/claude-jev:stats` skills. No session outside this repository ever called the first, and it could not see a key saved in the pane. Stats moved into the pane; `python3 scripts/stats.py` still prints the full report.
- `scripts/compactor.py` changed only its docstring; `hooks/register.ts` now passes the saved key and provider to it. Compaction gate, run through OpenRouter: re-fetch verbatim coverage 79.8% (floor 70%, n=678); planted user constraint survival 100.0% (floor 95%, n=72); planted buried restatement survival 97.1% (floor 90%, n=69).

[0.18.0]: https://github.com/0x7067/claude-jev/compare/v0.17.0...v0.18.0

## [0.17.0] - 2026-09-22

- Subagent briefs are checked before the spawn: a brief that changes files but omits paths, acceptance criteria, a verification command, or a commit policy is denied once per session with the missing parts listed, then goes through with a `systemMessage`. Read-only briefs are exempt. Live, a thin rename brief scored 0.06–0.16 on all four parts and a complete one 0.97+.
- Subagent tier criteria rewritten with sharper boundaries and a fourth `fable` option for adversarial review and cross-system debugging with conflicting evidence, never implementation. On seven hand-written briefs the live-vs-eval bug moved from opus 0.44 to 0.77, above the routing gate. The prompt router's advisory tier hint recognizes `fable` model names. Tier text can be overridden by a `## Delegating to sub-agents` section with `- tier: text` bullets in the user's global `CLAUDE.md`.
- Every file under the user's config directory (logs, caches, ast-grep binary, global `CLAUDE.md`) resolves through `CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
- `scripts/compactor.py` changed only its log path. Compaction gate: re-fetch verbatim coverage 76.5% (floor 70%, n=727); planted user constraint survival 100.0% (floor 95%, n=72); planted buried restatement survival 98.6% (floor 90%, n=69).

[0.17.0]: https://github.com/0x7067/claude-jev/compare/v0.16.1...v0.17.0

## [0.16.1] - 2026-09-22

- The release skill and script moved out of the plugin into `.claude/skills/release`; `/claude-jev:release` no longer exists for plugin users.

[0.16.1]: https://github.com/0x7067/claude-jev/compare/v0.16.0...v0.16.1

## [0.16.0] - 2026-09-22

- Compaction judges each block with five concrete checks instead of two aggregate questions. The checks: user constraint, decision with reason, exact error, open work, re-fetchable output; keep and verbatim scores derive from them in code. A constraint planted mid-session survives 100% (was 77%); a restatement buried in a later reply survives 98% (was 35%). Scores in the 0.35–0.65 band fall from 54% to 21%.
- `eval/compare.py compact` gates both compaction goals at once: re-fetch verbatim coverage (floor 70%) and planted-constraint survival (floors 95% and 90%), exiting 2 below either. `eval/sweep.py` and `eval/planted.py` added as diagnostics.
- Rule hook escalates the uncertain band with one focused second call and adds ast-grep comparators so the fact outside the hunk reaches the judgment.
- Rules are structured with a local relevance gate and violation-framed questions; every Jev call and every compaction row is logged for `/claude-jev:stats`.
- Code comments are banned in `scripts/`, `eval/`, and `hooks/`, enforced by `scripts/check_no_comments.py`.
- Docs: `docs/prompt-craft.md` records measured effects of question wording; Pstack verify skill under `.cursor/skills/verify-claude-jev`.
- New `/claude-jev:release` skill and `scripts/release.py`.

[0.16.0]: https://github.com/0x7067/claude-jev/compare/v0.12.0...v0.16.0

## [0.12.0] - 2026-09-21

- Compaction through the experimental `session.compact` function hook: Jev's kept rows replace the built-in summary.

[0.12.0]: https://github.com/0x7067/claude-jev/releases/tag/v0.12.0
