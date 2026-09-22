#!/usr/bin/env python3
"""Fail if any scanned source file contains a code comment.

Scans `scripts/`, `eval/`, and `hooks/` for `.py`, `.ts`, and `.js`.
Shebangs (`#!...`) are allowed. Python docstrings and string/URL contents
are not comments. Markdown and LICENSE are out of scope.

Exit 0 when clean; exit 1 and print paths/lines when a comment is found.
Stdlib only. Invoked from the Verify section of AGENTS.md.
"""

from __future__ import annotations

import io
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
            if tok.start[1] == 0 and line.startswith("#!"):
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
    i = 0
    n = len(text)
    line = 1
    line_start = 0

    def snippet(start: int) -> str:
        end = text.find("\n", start)
        if end < 0:
            end = n
        return text[start:end].strip()[:120]

    def skip_line_comment(start: int) -> int:
        hits.append((line, snippet(start)))
        j = start
        while j < n and text[j] != "\n":
            j += 1
        return j

    def skip_block_comment(start: int) -> tuple[int, int, int]:
        hits.append((line, snippet(start)))
        j = start + 2
        ln = line
        ls = line_start
        while j + 1 < n and not (text[j] == "*" and text[j + 1] == "/"):
            if text[j] == "\n":
                ln += 1
                ls = j + 1
            j += 1
        return min(j + 2, n), ln, ls

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if ch == "\n":
            line += 1
            line_start = i + 1
            i += 1
            continue

        if ch in "\"'":
            quote = ch
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                if text[i] == "\n":
                    line += 1
                    line_start = i + 1
                i += 1
            continue

        if ch == "`":
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == "`":
                    i += 1
                    break
                if text[i] == "$" and i + 1 < n and text[i + 1] == "{":
                    i += 2
                    depth = 1
                    while i < n and depth:
                        if text[i] == "{":
                            depth += 1
                            i += 1
                        elif text[i] == "}":
                            depth -= 1
                            i += 1
                        elif text[i] == "/" and i + 1 < n and text[i + 1] == "/":
                            i = skip_line_comment(i)
                        elif text[i] == "/" and i + 1 < n and text[i + 1] == "*":
                            i, line, line_start = skip_block_comment(i)
                        elif text[i] in "\"'":
                            q = text[i]
                            i += 1
                            while i < n:
                                if text[i] == "\\":
                                    i += 2
                                    continue
                                if text[i] == q:
                                    i += 1
                                    break
                                i += 1
                        elif text[i] == "\n":
                            line += 1
                            line_start = i + 1
                            i += 1
                        else:
                            i += 1
                    continue
                if text[i] == "\n":
                    line += 1
                    line_start = i + 1
                i += 1
            continue

        if ch == "/" and nxt == "/":
            i = skip_line_comment(i)
            continue

        if ch == "/" and nxt == "*":
            i, line, line_start = skip_block_comment(i)
            continue

        if ch == "/" and _js_regex_ok(text, i, line_start):
            i += 1
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
            continue

        i += 1
    return hits


def iter_targets() -> list[Path]:
    out: list[Path] = []
    for name in SCAN_DIRS:
        base = ROOT / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and path.suffix in SCAN_SUFFIXES:
                out.append(path)
    return out


def main() -> int:
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
