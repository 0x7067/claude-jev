#!/usr/bin/env python3
"""AFK rows in the stats report.

A later rules-skip of a warned file counts as not rechecked, not as no later
check. AFK blocks and flag-band rows stay out of Rule outcomes. AFK rules
rows still join Rule calibration.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import stats

ROOT = Path(__file__).resolve().parents[1]


def edit_row(**extra: object) -> dict:
    row = {
        "kind": "rules",
        "phase": "edit",
        "session_id": "sess",
        "file": "/tmp/afk-stats/a.ts",
        "ts": "2026-10-02T00:00:00+00:00",
        "probs": {"warned-rule": 0.9},
        "violations": [{"rule": "warned-rule", "band": "act"}],
        "blocked": [],
    }
    row.update(extra)
    return row


def afk_text(rows: list[dict]) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        stats.print_afk_checks(rows)
    return buf.getvalue()


def test_skip_after_warning_is_not_rechecked() -> None:
    text = afk_text(
        [
            edit_row(host="afk"),
            edit_row(
                host="afk",
                kind="rules-skip",
                ts="2026-10-02T00:01:00+00:00",
                reason="none-relevant",
                probs=None,
                violations=[],
            ),
        ]
    )
    assert "not rechecked 1" in text, text
    assert "no later check" not in text, text


def test_skip_does_not_hide_a_later_score() -> None:
    text = afk_text(
        [
            edit_row(host="afk"),
            edit_row(
                host="afk",
                kind="rules-skip",
                ts="2026-10-02T00:01:00+00:00",
                reason="none-relevant",
                probs=None,
                violations=[],
            ),
            edit_row(
                host="afk",
                ts="2026-10-02T00:02:00+00:00",
                probs={"warned-rule": 0.1},
                violations=[],
            ),
        ]
    )
    assert "cleared 1" in text, text
    assert "not rechecked" not in text, text


def test_scored_row_without_the_rule_is_not_rechecked() -> None:
    text = afk_text(
        [
            edit_row(host="afk"),
            edit_row(
                host="afk",
                ts="2026-10-02T00:01:00+00:00",
                probs={"other-rule": 0.1},
                violations=[],
            ),
        ]
    )
    assert "not rechecked 1" in text, text


def test_no_later_row_stays_no_later_check() -> None:
    text = afk_text([edit_row(host="afk")])
    assert "no later check 1" in text, text
    assert "not rechecked" not in text, text


def test_rule_outcomes_skip_afk_blocks() -> None:
    got = stats.rule_outcomes(
        [
            edit_row(host="afk", blocked=["afk-rule"], session_id="afk-sess"),
            edit_row(blocked=["cc-rule"], session_id="cc-sess", file="/tmp/afk-stats/b.ts"),
        ]
    )
    assert [item["rules"] for item in got] == [["cc-rule"]], got


def test_flagged_only_skips_afk_rows() -> None:
    buf = io.StringIO()
    with redirect_stdout(buf):
        stats.print_rule_outcomes(
            [
                edit_row(
                    host="afk",
                    violations=[{"rule": "afk-soft", "band": "flag"}],
                    blocked=[],
                ),
                edit_row(
                    host="afk",
                    phase="turn",
                    violations=[{"rule": "afk-turn-soft", "band": "flag"}],
                    blocked=[],
                ),
                edit_row(violations=[{"rule": "cc-soft", "band": "flag"}], blocked=[]),
            ]
        )
    text = buf.getvalue()
    assert "cc-soft" in text, text
    assert "afk-soft" not in text, text
    assert "afk-turn-soft" not in text, text


def test_afk_rules_still_join_calibration() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "jev-router-log.jsonl"
        log.write_text(
            json.dumps(
                edit_row(
                    host="afk",
                    blocked=["afk-only-rule"],
                    probs={"afk-only-rule": 0.91},
                    violations=[{"rule": "afk-only-rule", "band": "act"}],
                )
            )
            + "\n"
        )
        env = os.environ.copy()
        env["CLAUDE_CONFIG_DIR"] = tmp
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "stats.py"), "--log", str(log)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
    assert proc.returncode == 0, proc.stderr
    assert "Rule calibration" in proc.stdout, proc.stdout
    assert "afk-only-rule" in proc.stdout.split("Rule outcomes")[0], proc.stdout
    outcomes = proc.stdout.split("Rule outcomes", 1)[1].split("AFK rule checks", 1)[0]
    assert "afk-only-rule" not in outcomes, outcomes
    assert "unscorable" not in outcomes, outcomes
    assert "no blocked edits logged yet" in outcomes, outcomes


def main() -> None:
    test_skip_after_warning_is_not_rechecked()
    test_skip_does_not_hide_a_later_score()
    test_scored_row_without_the_rule_is_not_rechecked()
    test_no_later_row_stays_no_later_check()
    test_rule_outcomes_skip_afk_blocks()
    test_flagged_only_skips_afk_rows()
    test_afk_rules_still_join_calibration()
    print("ok")


if __name__ == "__main__":
    main()
