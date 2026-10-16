#!/usr/bin/env python3
"""Fail when plugin version manifests disagree.

Compares `version` in root `plugin.json`, `.claude-plugin/plugin.json`, and
the marketplace plugin entry whose name matches `.claude-plugin/plugin.json`.
Also compares `adapters/afk/.claude-plugin/plugin.json` and
`adapters/afk/package.json`. A missing file is a failure. Reads the files and
prints mismatches. Never writes or bumps a version.

Exit 0 when every checked group agrees; exit 1 and print each problem.
Stdlib only. Invoked from CI and the Verify section of AGENTS.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin.json"
CLAUDE_PLUGIN = ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
AFK_PLUGIN = ROOT / "adapters" / "afk" / ".claude-plugin" / "plugin.json"
AFK_PACKAGE = ROOT / "adapters" / "afk" / "package.json"


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def group_problems(items: list[tuple[str, str | None]]) -> list[str]:
    missing = [label for label, version in items if version is None]
    if missing:
        return [f"check_versions: no version in {label}" for label in missing]
    versions = {version for _, version in items}
    if len(versions) <= 1:
        return []
    detail = ", ".join(f"{label} is {version}" for label, version in items)
    return [f"check_versions: version mismatch: {detail}"]


def load_json(path: Path) -> tuple[object | None, str | None]:
    label = rel(path)
    if not path.is_file():
        return None, f"check_versions: missing {label}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, f"check_versions: {label} is not valid JSON ({exc.msg})"


def string_version(doc: object) -> str | None:
    if not isinstance(doc, dict):
        return None
    version = doc.get("version")
    if isinstance(version, str) and version:
        return version
    return None


def marketplace_entry(doc: object, name: str) -> tuple[object | None, str | None]:
    label = rel(MARKETPLACE)
    if not isinstance(doc, dict):
        return None, f"check_versions: {label} has no plugin entry named {name}"
    plugins = doc.get("plugins")
    if isinstance(plugins, list):
        for entry in plugins:
            if isinstance(entry, dict) and entry.get("name") == name:
                return entry, None
    return None, f"check_versions: {label} has no plugin entry named {name}"


def claude_problems() -> list[str]:
    problems: list[str] = []
    loaded: list[tuple[str, object]] = []
    for path in (PLUGIN, CLAUDE_PLUGIN, MARKETPLACE):
        doc, err = load_json(path)
        if err or doc is None:
            problems.append(err or f"check_versions: missing {rel(path)}")
        else:
            loaded.append((rel(path), doc))
    if problems:
        return problems
    by_label = dict(loaded)
    claude = by_label[rel(CLAUDE_PLUGIN)]
    name = claude.get("name") if isinstance(claude, dict) else None
    if not isinstance(name, str) or not name:
        return [f"check_versions: {rel(CLAUDE_PLUGIN)} has no name"]
    entry, err = marketplace_entry(by_label[rel(MARKETPLACE)], name)
    if err or entry is None:
        return [err or f"check_versions: {rel(MARKETPLACE)} has no plugin entry named {name}"]
    entry_label = f"{rel(MARKETPLACE)} plugin {name}"
    return group_problems(
        [
            (rel(PLUGIN), string_version(by_label[rel(PLUGIN)])),
            (rel(CLAUDE_PLUGIN), string_version(claude)),
            (entry_label, string_version(entry)),
        ]
    )


def afk_problems() -> list[str]:
    problems: list[str] = []
    versions: list[tuple[str, str | None]] = []
    for path in (AFK_PLUGIN, AFK_PACKAGE):
        doc, err = load_json(path)
        if err or doc is None:
            problems.append(err or f"check_versions: missing {rel(path)}")
        else:
            versions.append((rel(path), string_version(doc)))
    return problems or group_problems(versions)


def main() -> int:
    problems = claude_problems() + afk_problems()
    if problems:
        for line in problems:
            print(line)
        return 1
    print("check_versions: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
