# Changelog

All notable changes to claude-jev. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the plugin manifest. `scripts/release.py` turns the `[Unreleased]` section into the next release.

## [Unreleased]

- OpenRouter as a second Jev provider. Set `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` to an OpenRouter key (`sk-or-...`), and every call goes to `https://openrouter.ai/api/v1/systemone`, which takes the same request, model IDs, and answer shape. `TYPESAFE_API_KEY` is read first. A TypeSafe key still calls `api.typesafe.ai`. The Provider row in `/claude-jev` (`provider` in `/config`: `auto`, `typesafe`, `openrouter`) pins one provider and reads only its variable, so OpenRouter works with both variables set. Live through OpenRouter: a `noul` answered 0.99, and the prompt router answered in 472 ms. Each `jev-calls.jsonl` line records its `provider`.
- `/claude-jev` settings pane (needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`): save an API key for all sessions, see which provider it calls, turn the prompt router, subagent router, rule checks, and compaction on or off, and see the last Jev call. The on/off rows also appear in `/config`. A key in the environment wins over a saved key. `jev.py status` prints what the pane shows. The pane's Stats row shows the `scripts/stats.py` report.
- Removed the `/claude-jev:jev` and `/claude-jev:stats` skills. No session outside this repository ever called the first, and it could not see a key saved in the pane. Stats moved into the pane; `python3 scripts/stats.py` still prints the full report.
- `scripts/compactor.py` changed only its docstring; `hooks/register.ts` now passes the saved key and provider to it. Compaction gate, run through OpenRouter: re-fetch verbatim coverage 79.8% (floor 70%, n=678); planted user constraint survival 100.0% (floor 95%, n=72); planted buried restatement survival 97.1% (floor 90%, n=69).

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
