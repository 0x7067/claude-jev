#!/usr/bin/env python3
"""Fail if any Python source assigns to a .ask attribute outside the
sanctioned wiring.

The Jev client is called, never replaced: jev.ask is assigned in exactly
one place, the cached_ask wiring in eval/rules_eval.py's cmd_run, which
wraps the real client with the cache. Any other .ask = assignment in
tracked .py files under scripts/, eval/, and hooks/ is a stub and fails.
Scans with tokenize, so string contents never trip it. .ts and .js are out
of scope: the client is Python and the hook bridge never calls it.

Exit 0 when clean; exit 1 and print paths/lines otherwise.
Stdlib only. Invoked from the Verify section of AGENTS.md.
"""

from __future__ import annotations

import io
import sys
import tokenize
from pathlib import Path

from check_no_comments import ROOT, iter_targets

SANCTIONED = Path("eval") / "rules_eval.py"


def ask_assignments(text: str) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except tokenize.TokenError as exc:
        return [(0, f"tokenize error: {exc}")]
    for i, tok in enumerate(tokens):
        if tok.type != tokenize.OP or tok.string != ".":
            continue
        if i + 2 >= len(tokens):
            continue
        name, eq = tokens[i + 1], tokens[i + 2]
        if (name.type == tokenize.NAME and name.string == "ask"
                and eq.type == tokenize.OP and eq.string == "="):
            hits.append((tok.start[0], eq.line.strip()[:120]))
    return hits


def _self_check() -> None:
    calls = "real_ask = jev.ask\njev.ask(state, questions)\ns.ask == 1\nask = fake\n"
    assert ask_assignments(calls) == [], ask_assignments(calls)
    wired = "jev.ask = cached_ask(cache, cache_f)\nrules.jev.ask = jev.ask\n"
    lines = ask_assignments(wired)
    assert [lineno for lineno, _ in lines] == [1, 2], lines
    stub = "rules_eval.jev.ask = lambda state, questions: []\n"
    lines = ask_assignments(stub)
    assert len(lines) == 1 and lines[0][0] == 1, lines


def main() -> int:
    _self_check()
    bad = 0
    scanned = 0
    for path in iter_targets():
        if path.suffix != ".py":
            continue
        scanned += 1
        if path.relative_to(ROOT) == SANCTIONED:
            continue
        for lineno, snip in ask_assignments(path.read_text(encoding="utf-8")):
            print(f"{path.relative_to(ROOT)}:{lineno}: stub banned: {snip}")
            bad += 1
    if bad:
        print(f"check_no_stubs: {bad} hit(s)", file=sys.stderr)
        return 1
    print(f"check_no_stubs: ok ({scanned} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
