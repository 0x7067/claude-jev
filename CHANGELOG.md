# Changelog

All notable changes to claude-jev. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the plugin manifest. `scripts/release.py` turns the `[Unreleased]` section into the next release.

## [Unreleased]

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
