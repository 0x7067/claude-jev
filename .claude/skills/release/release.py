#!/usr/bin/env python3
"""Cut a release: version files, changelog, commit, tag, push, GitHub release.

    python3 .claude/skills/release/release.py 0.16.0            plan only
    python3 .claude/skills/release/release.py 0.16.0 --execute  do it
    --trailer "Key: value"                       appended to the release commit

The changelog is the source of the release notes. `CHANGELOG.md` must have a
non-empty `## [Unreleased]` section; the script renames it to the version
and date, writes those lines to the GitHub release, and opens a fresh
`[Unreleased]` above it. No notes, no release: the run stops before touching
anything.

Checks, all run in plan mode too: version is X.Y.Z and not below
plugin.json; working tree clean; branch is main and not behind origin/main;
tag vX.Y.Z unused; `compileall` over scripts and eval; `compactor.py rows`
falls back on empty input. Needs `git` with push rights and `gh-axi`
authenticated for the repository.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PLUGIN = os.path.join(ROOT, ".claude-plugin", "plugin.json")
MARKETPLACE = os.path.join(ROOT, ".claude-plugin", "marketplace.json")
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
REPO_URL = "https://github.com/0x7067/claude-jev"
VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def sh(*args: str, check: bool = True) -> str:
    r = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if check and r.returncode:
        raise SystemExit(f"release: `{' '.join(args)}` failed:\n{r.stderr.strip()}")
    return r.stdout.strip()


def fail(msg: str) -> None:
    raise SystemExit(f"release: {msg}")


def preflight(version: str) -> None:
    if not VERSION.match(version):
        fail(f"version must be X.Y.Z, got {version!r}")
    if sh("git", "status", "--porcelain"):
        fail("working tree is not clean; commit or stash first")
    branch = sh("git", "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        fail(f"release from main, not {branch}")
    sh("git", "fetch", "origin", "main", "--tags")
    behind = sh("git", "rev-list", "--count", "HEAD..origin/main")
    if behind != "0":
        fail(f"HEAD is {behind} commits behind origin/main; pull first")
    if sh("git", "tag", "-l", f"v{version}"):
        fail(f"tag v{version} already exists")
    current = json.load(open(PLUGIN))["version"]
    if tuple(map(int, version.split("."))) < tuple(map(int, current.split("."))):
        fail(f"{version} is below the plugin.json version {current}")
    sh("python3", "-m", "compileall", "-q", "scripts", "eval")
    smoke = subprocess.run(["python3", os.path.join(ROOT, "scripts", "compactor.py"), "rows"],
                           input="", text=True, capture_output=True, cwd=ROOT)
    if smoke.returncode or '"fallback"' not in smoke.stdout:
        fail("compactor.py rows did not fall back cleanly on empty input")


def split_changelog(text: str) -> tuple[str, str, str]:
    """(head, unreleased_body, tail) around the `## [Unreleased]` section."""
    m = re.search(r"^## \[Unreleased\]\s*\n", text, re.M)
    if not m:
        fail("CHANGELOG.md has no `## [Unreleased]` section")
    rest = text[m.end():]
    nxt = re.search(r"^## \[", rest, re.M)
    body = rest[: nxt.start()] if nxt else rest
    tail = rest[nxt.start():] if nxt else ""
    if not body.strip():
        fail("`## [Unreleased]` is empty; write the notes for this release first")
    return text[: m.start()], body.strip("\n") + "\n", tail


def bump_json(path: str, version: str, execute: bool) -> str:
    text = open(path).read()
    new, n = re.subn(r'("version":\s*")\d+\.\d+\.\d+(")', rf"\g<1>{version}\2", text, count=1)
    if n != 1:
        fail(f"no version field in {os.path.relpath(path, ROOT)}")
    if execute:
        open(path, "w").write(new)
    return os.path.relpath(path, ROOT)


def main() -> int:
    argv = sys.argv[1:]
    trailer = argv[argv.index("--trailer") + 1] if "--trailer" in argv else ""
    argv = [a for i, a in enumerate(argv) if not (a == "--trailer" or (i and argv[i - 1] == "--trailer"))]
    args = [a for a in argv if not a.startswith("--")]
    execute = "--execute" in argv
    if len(args) != 1:
        print(__doc__)
        return 2
    version = args[0]
    tag = f"v{version}"
    preflight(version)

    head, notes, tail = split_changelog(open(CHANGELOG).read())
    today = datetime.date.today().isoformat()
    prev = sh("git", "describe", "--tags", "--abbrev=0", check=False) or None
    compare = (f"{REPO_URL}/compare/{prev}...{tag}" if prev else f"{REPO_URL}/releases/tag/{tag}")
    new_changelog = (f"{head}## [Unreleased]\n\n## [{version}] - {today}\n\n{notes}\n"
                     f"[{version}]: {compare}\n\n{tail}")
    first = re.split(r"(?<=[.!?])\s", notes.strip().splitlines()[0].lstrip("-* "))[0].rstrip(".")
    title = first if len(first) <= 72 else first[:72].rsplit(" ", 1)[0]
    files = [os.path.relpath(CHANGELOG, ROOT)]

    mode = "EXECUTE" if execute else "PLAN"
    print(f"[{mode}] release {tag}" + (f" (previous {prev})" if prev else ""))
    print(f"  bump version -> {version} in plugin.json, marketplace.json")
    print(f"  CHANGELOG.md: [Unreleased] -> [{version}] - {today}, new empty [Unreleased]")
    print(f"  commit '{version}: {title}', tag {tag}, push main and {tag}")
    print(f"  gh-axi release create {tag} with these notes:\n")
    print("\n".join(f"    {l}" for l in notes.splitlines()))
    if not execute:
        print("\nplan only; re-run with --execute to release")
        return 0

    files.append(bump_json(PLUGIN, version, True))
    files.append(bump_json(MARKETPLACE, version, True))
    open(CHANGELOG, "w").write(new_changelog)
    sh("git", "add", *files)
    message = f"{version}: {title}\n" + (f"\n{trailer}\n" if trailer else "")
    sh("git", "commit", "-q", "-m", message)
    sh("git", "tag", "-a", tag, "-m", f"{tag}: {title}")
    sh("git", "push", "origin", "main", tag)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as tf:
        tf.write(notes)
        notes_path = tf.name
    try:
        out = sh("gh-axi", "release", "create", tag, "--title", tag,
                 "--notes-file", notes_path, "--verify-tag")
    finally:
        os.unlink(notes_path)
    print(f"\nreleased {tag}\n{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
