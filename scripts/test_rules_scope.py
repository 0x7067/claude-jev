#!/usr/bin/env python3
"""Rule scope, out-of-project paths, and the forbid guard in rules.py.

No hook and no Jev call: these are the pure helpers the PostToolUse and Stop
hooks use to pick the rules an edit is judged against.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import rules

ROOT = Path(__file__).resolve().parents[1]

DESCRIPTIVE = [
    "Every overlay appends — there is no full-replace escape hatch yet.",
    "Three properties are load-bearing and each has a test: the **active session is "
    "excluded by identity** (its witness label, never by timestamp); anything whose "
    "newest content is inside a 1-hour grace window is never evicted.",
    "All AFK state under `~/.afk/` (never `~/.claude/`), resolved exclusively "
    "through `src/paths.ts`:",
]

PROHIBITIONS = [
    "**Three mandatory indirections — each has exactly one read/write point, and CI "
    "enforces it.** Env vars: never `process.env`; use the typed `env` object.",
    "Never skip on win32; make the test portable.",
    "Do not hand-edit `content/registry/*.json`; update them with `pnpm sync:registry`.",
    "Subagents must not force-push, touch unrelated files, or combine issues.",
    "**No code comments.** Line, block, and JSDoc comments are banned in `scripts/`.",
    "`.agents/skills/` is canonical for shared agent skills; symlink them into tool "
    "`skills/` dirs, never copy.",
]


def test_include_and_exclude() -> None:
    scope = ["src/**", "!**/*.test.ts", "!**/bench/**"]
    assert rules.glob_match("src/cli/run.ts", scope)
    assert not rules.glob_match("src/cli/run.test.ts", scope)
    assert not rules.glob_match("src/bench/load.ts", scope)
    assert not rules.glob_match("scripts/run.ts", scope)


def test_exclude_only() -> None:
    scope = ["!**/*.test.ts", "! test/**"]
    assert rules.glob_match("src/cli/run.ts", scope)
    assert rules.glob_match("run.ts", scope)
    assert not rules.glob_match("src/cli/run.test.ts", scope)
    assert not rules.glob_match("test/helpers.ts", scope)


def test_include_only_unchanged() -> None:
    assert rules.glob_match("src/a.ts", ["src/**"])
    assert not rules.glob_match("lib/a.ts", ["src/**"])
    assert rules.glob_match("lib/a.ts", ["", "  "])
    assert rules.glob_match("lib/a.ts", ["!"])


def test_scoped_rules_honours_exclusions() -> None:
    rule = {"when": "edit", "scope": ["!**/*.test.ts"], "file": "AFK.md", "id": "env"}
    unscoped = {"when": "edit", "scope": [], "file": "AFK.md", "id": "any"}
    assert [r["id"] for r in rules.scoped_rules([rule, unscoped], "edit", ["src/a.ts"])] == [
        "env",
        "any",
    ]
    assert [r["id"] for r in rules.scoped_rules([rule, unscoped], "edit", ["src/a.test.ts"])] == [
        "any"
    ]


def test_outside() -> None:
    assert rules.outside("../../../../../tmp/overflow-reconstruct.mts")
    assert rules.outside(os.pardir)
    assert rules.outside("/tmp/scratch.py")
    assert not rules.outside("src/a.py")
    assert not rules.outside("..foo/a.py")


def test_descriptive_is_not_forbid() -> None:
    for text in DESCRIPTIVE:
        assert rules.rule_polarity("forbid", text) == "require", text


def test_prohibitions_stay_forbid() -> None:
    for text in PROHIBITIONS:
        assert rules.rule_polarity("forbid", text) == "forbid", text
    assert rules.rule_polarity("require", PROHIBITIONS[1]) == "require"


def test_hook_skips_out_of_project_edit() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cwd = Path(tmp) / "proj"
        cwd.mkdir()
        (cwd / "CLAUDE.md").write_text("- Never call print in production code.\n")
        event = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Write",
            "session_id": "scope-test",
            "cwd": str(cwd),
            "tool_input": {"file_path": "/tmp/overflow-reconstruct.py", "content": "print(1)\n"},
        }
        env = dict(os.environ, CLAUDE_CONFIG_DIR=str(Path(tmp) / "cfg"))
        env.pop("TYPESAFE_API_KEY", None)
        env.pop("OPENROUTER_API_KEY", None)
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "rules.py")],
            input=json.dumps(event),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "", proc.stdout


def main() -> None:
    test_include_and_exclude()
    test_exclude_only()
    test_include_only_unchanged()
    test_scoped_rules_honours_exclusions()
    test_outside()
    test_descriptive_is_not_forbid()
    test_prohibitions_stay_forbid()
    test_hook_skips_out_of_project_edit()
    print("ok")


if __name__ == "__main__":
    main()
