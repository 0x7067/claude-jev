---
name: release
description: >
  Cut a claude-jev release: changelog entry, version bump, tagged commit,
  push, GitHub release. Use when the user asks to release, ship, tag, or
  publish a version of this plugin, or runs /release. Not for an ordinary
  version bump or changelog edit without a release.
argument-hint: "<X.Y.Z>"
---

# Release

Maintainer workflow for this repository. It is a project skill, not part of
the shipped plugin.

`python3 .claude/skills/release/release.py X.Y.Z`, run from the repository
root, does the mechanical part.
Its docstring is the authoritative list of what it checks and changes. It
plans by default and writes nothing until `--execute`.

## Do

1. **Version.** Use the one the user named. Otherwise bump automatically:
   take the last tag from `git describe --tags --abbrev=0`, minor for a
   behavior change, patch for docs or fixes. A version already set in
   `.claude-plugin/plugin.json` by an earlier commit is the one to release.
2. **Notes.** `## [Unreleased]` in `CHANGELOG.md` must hold the user-facing
   changes since the last tag, one `-` bullet each, with numbers where a
   run produced them. Source: `git log --format='%h %s' <last-tag>..HEAD`.
   The first sentence of the first bullet becomes the commit and tag title.
   Commit the changelog edit; the script needs a clean tree.
3. **Plan.** Run the script without `--execute` and read the output. It
   stops on any failed check and names it.
4. **Check the plan.** Running `/release` is the confirmation to release;
   do not stop to ask. Read the plan only to catch a wrong version, a
   missing note, or a failed check, and fix those before executing.
5. **Execute.** Re-run with `--execute`. Add `--trailer "Claude-Session: <url>"`
   when this session's commit attribution requires that line.

## Done when

`gh-axi release view vX.Y.Z` shows the notes and `git status -sb` prints
`## main...origin/main` with nothing ahead or behind. Report the release URL.

## If

- **The script fails after the push but before the release exists,** the
  tag is already public. Run
  `gh-axi release create vX.Y.Z --notes-file <notes> --verify-tag` by hand.
  Do not re-run the script.
- **The release changes `scripts/compactor.py`,** run the compaction gate
  first as AGENTS.md describes, and quote its three gate lines in the notes.
