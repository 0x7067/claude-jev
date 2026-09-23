#!/usr/bin/env python3
"""Fail if any scanned source file contains a code comment.

Scans the files git tracks or would track (gitignored paths such as
`eval/data/` are skipped) under `scripts/`, `eval/`, and `hooks/` for
`.py`, `.ts`, and `.js`.
Shebangs (`#!...`) are allowed. Python docstrings and string/URL contents
are not comments. Markdown and LICENSE are out of scope.

Exit 0 when clean; exit 1 and print paths/lines when a comment is found.
Stdlib only. Invoked from the Verify section of AGENTS.md.
"""

from __future__ import annotations

import io
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS = ("scripts", "eval", "hooks")
SCAN_SUFFIXES = {".py", ".ts", ".js"}


def _py_comment_hits(text: str) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type != tokenize.COMMENT:
                continue
            line = tok.line.rstrip("\n")
            if tok.start == (1, 0) and line.startswith("#!"):
                continue
            hits.append((tok.start[0], line.strip()[:120]))
    except tokenize.TokenError as exc:
        hits.append((0, f"tokenize error: {exc}"))
    return hits


def _js_regex_ok(text: str, i: int, line_start: int) -> bool:
    j = i - 1
    while j >= line_start and text[j] in " \t":
        j -= 1
    if j < line_start:
        return True
    prev = text[j]
    if prev in "=(,{[!:?~&|^+-*%<>;":
        return True
    frag = text[max(line_start, j - 10):j + 1]
    for kw in ("return", "case", "typeof", "instanceof", "in", "of"):
        if frag.endswith(kw) and (len(frag) == len(kw) or not frag[-len(kw) - 1].isalnum()):
            return True
    return False


def _js_comment_hits(text: str) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    n = len(text)
    state = {"i": 0, "line": 1, "line_start": 0}

    def snippet(start: int) -> str:
        end = text.find("\n", start)
        if end < 0:
            end = n
        return text[start:end].strip()[:120]

    def bump_nl(at: int) -> None:
        state["line"] += 1
        state["line_start"] = at + 1

    def skip_line_comment(start: int) -> None:
        hits.append((state["line"], snippet(start)))
        j = start
        while j < n and text[j] != "\n":
            j += 1
        state["i"] = j

    def skip_block_comment(start: int) -> None:
        hits.append((state["line"], snippet(start)))
        j = start + 2
        while j + 1 < n and not (text[j] == "*" and text[j + 1] == "/"):
            if text[j] == "\n":
                bump_nl(j)
            j += 1
        state["i"] = min(j + 2, n)

    def skip_quote(quote: str) -> None:
        i = state["i"] + 1
        while i < n:
            if text[i] == "\\":
                i += 2
                continue
            if text[i] == quote:
                i += 1
                break
            if text[i] == "\n":
                bump_nl(i)
            i += 1
        state["i"] = i

    def skip_regex() -> None:
        i = state["i"] + 1
        while i < n:
            if text[i] == "\\":
                i += 2
                continue
            if text[i] == "[":
                i += 1
                while i < n:
                    if text[i] == "\\":
                        i += 2
                        continue
                    if text[i] == "]":
                        i += 1
                        break
                    i += 1
                continue
            if text[i] == "/":
                i += 1
                while i < n and text[i].isalpha():
                    i += 1
                break
            if text[i] == "\n":
                break
            i += 1
        state["i"] = i

    def skip_template() -> None:
        state["i"] += 1
        while state["i"] < n:
            i = state["i"]
            if text[i] == "\\":
                state["i"] = i + 2
                continue
            if text[i] == "`":
                state["i"] = i + 1
                return
            if text[i] == "$" and i + 1 < n and text[i + 1] == "{":
                state["i"] = i + 2
                skip_template_expr()
                continue
            if text[i] == "\n":
                bump_nl(i)
            state["i"] = i + 1

    def skip_template_expr() -> None:
        depth = 1
        while state["i"] < n and depth:
            i = state["i"]
            ch = text[i]
            nxt = text[i + 1] if i + 1 < n else ""
            if ch == "{":
                depth += 1
                state["i"] = i + 1
            elif ch == "}":
                depth -= 1
                state["i"] = i + 1
            elif ch in "\"'":
                skip_quote(ch)
            elif ch == "`":
                skip_template()
            elif ch == "/" and nxt == "/":
                skip_line_comment(i)
            elif ch == "/" and nxt == "*":
                skip_block_comment(i)
            elif ch == "/" and _js_regex_ok(text, i, state["line_start"]):
                skip_regex()
            elif ch == "\n":
                bump_nl(i)
                state["i"] = i + 1
            else:
                state["i"] = i + 1

    while state["i"] < n:
        i = state["i"]
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "\n":
            bump_nl(i)
            state["i"] = i + 1
        elif ch in "\"'":
            skip_quote(ch)
        elif ch == "`":
            skip_template()
        elif ch == "/" and nxt == "/":
            skip_line_comment(i)
        elif ch == "/" and nxt == "*":
            skip_block_comment(i)
        elif ch == "/" and _js_regex_ok(text, i, state["line_start"]):
            skip_regex()
        else:
            state["i"] = i + 1
    return hits


def _self_check() -> None:
    nested_ok = (
        'const x = `outer ${out.summary ?? `https://example.com/${id} // not comment`}`;\n'
        'const y = `a ${`b /* still string */ c`} d`;\n'
    )
    assert _js_comment_hits(nested_ok) == [], _js_comment_hits(nested_ok)

    real_comment = 'const x = `outer ${`https://ok`} `;\n// real comment\n'
    hits = _js_comment_hits(real_comment)
    assert len(hits) == 1 and hits[0][0] == 2, hits

    nested_then_comment = 'const x = `${`https://a.com/${n}`}`; // after\n'
    hits = _js_comment_hits(nested_then_comment)
    assert len(hits) == 1 and "// after" in hits[0][1], hits

    assert _py_comment_hits("#!/usr/bin/env python3\nx = 1\n") == []
    mid_bang = _py_comment_hits("x = 1\n#! banned rationale\n")
    assert len(mid_bang) == 1 and mid_bang[0][0] == 2 and "#! banned" in mid_bang[0][1], mid_bang


def iter_targets() -> list[Path]:
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *SCAN_DIRS],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    paths = (ROOT / name for name in listed.split("\0") if name)
    return sorted(p for p in paths if p.suffix in SCAN_SUFFIXES and p.is_file())


def main() -> int:
    _self_check()
    targets = iter_targets()
    bad = 0
    for path in targets:
        text = path.read_text(encoding="utf-8")
        hits = _py_comment_hits(text) if path.suffix == ".py" else _js_comment_hits(text)
        for lineno, snip in hits:
            rel = path.relative_to(ROOT)
            where = f"{rel}:{lineno}" if lineno else str(rel)
            print(f"{where}: comment banned: {snip}")
            bad += 1
    if bad:
        print(f"check_no_comments: {bad} hit(s)", file=sys.stderr)
        return 1
    print(f"check_no_comments: ok ({len(targets)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
