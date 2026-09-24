# Changelog

All notable changes to claude-jev. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the plugin manifest. `scripts/release.py` turns the `[Unreleased]` section into the next release.

## [Unreleased]

- The rules eval now measures the AskUserQuestion answers the way the hook sends them. Its corpora carried only the typed request, so no rerun could see the v0.20.0 answers feature: `extract` records each edit's answers since its request, and `run` composes the request through the same `request_with_answers` the hook calls; the rules decision log rows gained a `user_answers` count, so live outcomes can split by whether the user answered questions. Extraction collects answers unconditionally, like the hook: an AskUserQuestion's result line normally carries no tool name, so the substring gate this replaces saw 5 answers-bearing edits where the corpus has 140 of 1,569 — enough that a normal 250-sample now measures the feature (~22 records). Records without answers compose to the old request text, so their cache entries still hit. The hook itself gains a fix: a transcript that could not be opened made `last_user_prompt` return a 2-tuple, crashing the handler before any rule was asked. `scripts/check_no_stubs.py` joins the Verify contract: `.ask =` assignments are banned everywhere except the `cached_ask` wiring shapes in `cmd_run`, so a probe cannot fake the client and present the result as verification. Live evidence through the real client: a313bcf9#932 ("rspec check in CI failed") reached the judge with its picked option and none acted, its re-judgment hitting at 0.0s the cache key only its answers-carrying state could produce; a synthetic result line with no tool name rides in the request exactly as the hook composes it; the full rerun on the pre-fix corpus reproduced the prior run's every number (2/248 real-edit blocks at 0.81 and 0.83, 19/29 violations blocked, 0/24 compliant).

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
