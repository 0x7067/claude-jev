#!/usr/bin/env python3
"""Version-manifest checks in check_versions.

A matching pair is clean, a mismatch and a missing version are reported, and
a missing AFK manifest is a problem. No hook and no Jev call.
"""

from __future__ import annotations

import check_versions

ROOT = check_versions.ROOT


def test_group_problems() -> None:
    assert check_versions.group_problems([("a", "1.0.0"), ("b", "1.0.0")]) == []
    mismatch = check_versions.group_problems([("plugin.json", "0.1.0"), ("other", "0.2.0")])
    assert len(mismatch) == 1 and "version mismatch" in mismatch[0], mismatch
    assert "plugin.json is 0.1.0" in mismatch[0] and "other is 0.2.0" in mismatch[0]
    absent = check_versions.group_problems([("plugin.json", None)])
    assert len(absent) == 1 and absent[0] == "check_versions: no version in plugin.json", absent


def test_load_json_reports_a_missing_file() -> None:
    path = ROOT / "adapters" / "afk" / "missing-package.json"
    doc, err = check_versions.load_json(path)
    assert doc is None
    assert err == "check_versions: missing adapters/afk/missing-package.json", err


def test_afk_missing_file_is_a_problem() -> None:
    original = check_versions.AFK_PACKAGE
    missing = ROOT / "adapters" / "afk" / "missing-package.json"
    check_versions.AFK_PACKAGE = missing
    try:
        problems = check_versions.afk_problems()
    finally:
        check_versions.AFK_PACKAGE = original
    assert problems == ["check_versions: missing adapters/afk/missing-package.json"], problems


def test_afk_manifests_agree() -> None:
    assert check_versions.afk_problems() == [], check_versions.afk_problems()


def main() -> None:
    test_group_problems()
    test_load_json_reports_a_missing_file()
    test_afk_missing_file_is_a_problem()
    test_afk_manifests_agree()
    print("ok")


if __name__ == "__main__":
    main()
