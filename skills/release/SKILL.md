---
name: release
description: >
  Cut a claude-jev release: changelog entry, version bump in plugin.json and
  marketplace.json, tagged commit, push, and a GitHub release whose notes are
  the changelog section. Use when the user asks to release, ship, tag, or
  publish a version, or runs /claude-jev:release. Plans first; nothing moves
  until the user confirms and `--execute` runs.
argument-hint: "<X.Y.Z>"
---

# Release

`${CLAUDE_PLUGIN_ROOT}/scripts/release.py` does the whole cut. The changelog
is the input; the GitHub release is the output. Your job is the notes and
the confirmation.

## Steps

1. **Pick the version.** `git describe --tags --abbrev=0` gives the last
   tag. Minor bump for a behavior change, patch for docs and fixes. If
   `.claude-plugin/plugin.json` was already bumped in a prior commit, release
   that number.
2. **Write the notes.** `git log --format='%h %s' <last-tag>..HEAD` lists
   what shipped. Put user-facing changes under `## [Unreleased]` in
   `CHANGELOG.md` as `-` bullets, one change per bullet, measured numbers
   where a run produced them, in the order a user would care. Skip commits
   that only touch eval data or wording. The first bullet becomes the commit
   and tag title. Commit the changelog edit; the script needs a clean tree.
3. **Plan.** Run `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/release.py X.Y.Z`.
   It checks: clean tree, on `main`, not behind `origin/main`, tag unused,
   version not below `plugin.json`, `compileall`, and the compaction bridge
   falling back on empty input. Then it prints the exact commit, tag, push,
   and release notes. It writes nothing.
4. **Confirm.** Show the plan to the user. A release is public and a tag is
   hard to move; wait for a yes.
5. **Execute.** Re-run with `--execute`, adding
   `--trailer "Claude-Session: <url>"` when this session's commit
   attribution asks for one. The script bumps both version files, rotates
   the changelog section to `## [X.Y.Z] - <date>` with a compare link, commits
   as `X.Y.Z: <first bullet>`, tags `vX.Y.Z`, pushes `main` and the tag, and
   runs `gh-axi release create` with the section as notes.
6. **Verify.** `gh-axi release view vX.Y.Z` shows the notes; `git status -sb`
   shows `main` level with origin. Report the release URL.

## Gotchas

- Empty `[Unreleased]` stops the script before any change. That is the point:
  no notes, no release.
- The compaction eval gate (`python3 eval/compare.py compact --synth 60`)
  is not run here; it costs API calls. Run it before releasing a change to
  `scripts/compactor.py` and quote its three gate lines in the changelog.
- `gh-axi` must be authenticated for `0x7067/claude-jev`. If the release
  step fails after the push, the tag is already public: fix auth and run
  `gh-axi release create vX.Y.Z --notes-file <notes> --verify-tag` by hand
  rather than re-running the script.
