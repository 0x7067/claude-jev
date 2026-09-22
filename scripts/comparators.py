#!/usr/bin/env python3
"""Deterministic lookups that answer the questions a hunk cannot.

Serves the PostToolUse rule hook (`scripts/rules.py`), which asks Jev whether
one edit breaks a rule. Measured on 29 hand-written cases, that judgment is
reliable when the breach is visible in the added text and unreliable when it
needs a comparison with code outside the hunk: whether the literal `6` already
has a named constant, whether an `as Judgment` cast is sound, whether a caught
error still reaches its caller, whether an assertion can fail. Each comparator
here runs that comparison with ast-grep and hands the result to the judge as
plain text, so the answer comes from the repository rather than from a guess.

Fail open, twice over. Every function answers "" or [] on a missing binary, a
bad pattern, a timeout, or a parse error, and the hook's judgment simply
proceeds without the extra text. The binary itself is optional: it is fetched
once, in a detached process that cannot delay an edit, and until it lands
every comparator answers "".

Env:
  none. `TYPESAFE_API_KEY` is the plugin's one variable and this module never
  reads it — no question here reaches the API.
"""

import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

VERSION = "0.45.3"
RELEASE = ("https://github.com/ast-grep/ast-grep/releases/download/"
           f"{VERSION}/app-%s.zip")
SHA256 = {
    "aarch64-apple-darwin":
        "6d2279dea5bea2ad79c66ea93f5fe54ba926e398a8a26de76c56db68fe59eac6",
    "x86_64-apple-darwin":
        "b2ffd26f42810340326a9e8a084bdc3647a8795c1a3f21fc06bd7bef3c7c5b2c",
    "aarch64-unknown-linux-gnu":
        "b39cfbc58da4b869a88b8a4bc57bd5deb0d24541e704cf7c257da7b53ec81c8f",
    "x86_64-unknown-linux-gnu":
        "f8ac830881339d1edee6b2652f54798c0f4da5a827f2db38a08ee31117783ce8",
}
BIN_DIR = os.path.expanduser(f"~/.claude/jev-bin/ast-grep-{VERSION}")
BIN = os.path.join(BIN_DIR, "ast-grep")

USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0"

RUN_TIMEOUT = 1.5
QUERY_BUDGET = 3.0
MAX_QUERIES = 6
MAX_HITS = 6
MAX_CHARS = 1200
MAX_LITERALS = 4

LANGS = {".py": "python", ".ts": "ts", ".tsx": "tsx", ".js": "js",
         ".jsx": "jsx", ".mjs": "js"}

_no_download = False


def triple() -> str | None:
    """The release asset for this machine, or None where there is none."""
    machine = platform.machine().lower()
    arch = ("aarch64" if machine in ("arm64", "aarch64")
            else "x86_64" if machine in ("x86_64", "amd64") else None)
    if arch is None or sys.platform.startswith("win"):
        return None
    if sys.platform == "darwin":
        return f"{arch}-apple-darwin"
    if sys.platform.startswith("linux"):
        return f"{arch}-unknown-linux-gnu"
    return None


def which() -> tuple[str | None, str]:
    """(path, where it came from). A system ast-grep wins: the user chose it,
    and any version answers these patterns."""
    found = shutil.which("ast-grep")
    if found:
        return found, "path"
    if os.access(BIN, os.X_OK):
        return BIN, "cached"
    return None, "none"


def spawn_fetch() -> None:
    """Start the download and return immediately. The edit that noticed the
    binary was missing must not wait for it; the next edit finds it."""
    if _no_download or triple() is None:
        return
    try:
        with open(os.devnull, "wb") as null:
            subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "fetch"],
                stdout=null, stderr=null, stdin=subprocess.DEVNULL,
                start_new_session=True)
    except (OSError, ValueError):
        pass


def fetch() -> bool:
    """Download, verify, and unpack the pinned binary. The zip ships `sg` and
    `ast-grep`; `sg` is a deprecated shim, so only `ast-grep` is written."""
    global _no_download
    plat = triple()
    if plat is None or _no_download:
        return False
    if os.access(BIN, os.X_OK):
        return True
    req = urllib.request.Request(RELEASE % plat,
                                 headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
    except Exception:
        return False
    if hashlib.sha256(payload).hexdigest() != SHA256[plat]:
        _no_download = True
        try:
            os.remove(BIN)
        except OSError:
            pass
        return False
    try:
        os.makedirs(BIN_DIR, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            data = z.read("ast-grep")
        tmp = BIN + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o755)
        os.replace(tmp, BIN)
    except (OSError, KeyError, zipfile.BadZipFile):
        return False
    return True


def lang_for(rel: str) -> str | None:
    return LANGS.get(os.path.splitext(rel)[1].lower())


def run(pattern: str, lang: str, cwd: str, timeout: float = RUN_TIMEOUT,
        target: str = ".", stdin: str | None = None) -> list[dict]:
    """ast-grep matches as [{path, line, text}]. Empty on anything at all
    going wrong, which is the whole contract this module offers."""
    exe, _source = which()
    if not exe or not os.path.isdir(cwd):
        return []
    try:
        argv = [exe, "run", "--pattern", pattern, "--lang", lang,
                "--json=compact"]
        argv += ["--stdin"] if stdin is not None else [target]
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, input=stdin)
        if r.returncode != 0 or not r.stdout.strip():
            return []
        raw = json.loads(r.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    import rules
    out = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        path = m.get("file") or ""
        if not path or rules.EXCLUDED.search(path):
            continue
        start = (m.get("range") or {}).get("start") or {}
        line = start.get("line")
        text = " ".join((m.get("lines") or m.get("text") or "").split())
        out.append({"path": path,
                    "line": (line + 1) if isinstance(line, int) else 0,
                    "col": start.get("column", 0), "text": text[:200]})
    return out


class _Budget:
    """Queries left and seconds left, shared by one comparator call."""

    def __init__(self):
        self.t0 = time.monotonic()
        self.n = 0

    def ok(self) -> bool:
        return (self.n < MAX_QUERIES
                and time.monotonic() - self.t0 < QUERY_BUDGET)

    def run(self, pattern: str, lang: str, cwd: str, target: str = ".",
            stdin: str | None = None) -> list[dict]:
        if not self.ok():
            return []
        self.n += 1
        return run(pattern, lang, cwd, target=target, stdin=stdin)


def block(label: str, hits: list[dict]) -> str:
    if not hits:
        return ""
    seen, lines = set(), []
    for h in hits:
        line = f"{h['path']}:{h['line']}: {h['text']}"
        if line in seen:
            continue
        seen.add(line)
        lines.append(line)
        if len(lines) >= MAX_HITS:
            break
    return f"{label}\n" + "\n".join(lines)[:MAX_CHARS]

COMMENT_LINE = re.compile(r"\s*(#|//|/\*|\*|<!--)")
NUMBER = re.compile(r"(?<![\w.])(-?\d[\d_]*(?:\.\d+)?)\b")
STRING = re.compile(r"[\"']([^\"'\n]{4,})[\"']")
DECLARES = re.compile(r"(?:^|\s)(?:const|let|var)\s+\w+\s*=|^\s*[A-Z_][A-Z_0-9]*\s*=")
CALLED = re.compile(r"\b([a-z_]\w{2,})\s*\(")
DEFINED = re.compile(r"(?m)^\s*(?:export\s+)?(?:async\s+)?"
                     r"(?:def|function)\s+(\w+)|"
                     r"(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(")
NOT_A_CALL = {"if", "for", "while", "return", "print", "expect", "it",
              "describe", "test", "require", "import", "def", "function",
              "catch", "switch", "super", "len", "str", "int", "range"}


def literal_hits(added: str, lang: str, cwd: str, b: _Budget) -> str:
    """A literal that already has a name somewhere in the repo is the
    magic-number rule's whole question."""
    lits: list[str] = []
    for line in added.splitlines():
        if DECLARES.search(line):
            continue
        if COMMENT_LINE.match(line):
            continue
        for m in NUMBER.finditer(line):
            if m.group(1) not in ("0", "1", "-1") and m.group(1) not in lits:
                lits.append(m.group(1))
        for m in STRING.finditer(line):
            quoted = f"'{m.group(1)}'"
            if quoted not in lits:
                lits.append(quoted)
    hits: list[dict] = []
    for lit in lits[:MAX_LITERALS]:
        value = lit if not lit.startswith("'") else lit
        if lang == "python":
            hits += [h for h in b.run(f"$N = {value}", lang, cwd)
                     if h["col"] == 0]
        else:
            hits += b.run(f"const $N = {value}", lang, cwd)
    return block("Existing named constants with the same value as a literal "
                 "this edit adds:", hits)


def test_hits(added: str, rel: str, lang: str, cwd: str, b: _Budget) -> str:
    """Two questions a test rule asks and a hunk cannot answer: does this
    assertion compare a value with itself, and what does the code under test
    actually do?"""
    import rules
    if not rules.TESTISH.search(rel):
        return ""

    same: list[dict] = []
    for pattern in ("expect($X).toBe($X)", "expect($X).toEqual($X)",
                    "assert $X == $X"):
        same += b.run(pattern, lang, cwd, target=rel)
        for h in b.run(pattern, lang, cwd, stdin=added):
            h["path"] = rel
            same.append(h)
    names: list[str] = []
    for m in CALLED.finditer(added):
        n = m.group(1)
        if n not in NOT_A_CALL and n not in names:
            names.append(n)
    bodies: list[dict] = []
    for name in names[:MAX_LITERALS]:
        if lang == "python":
            bodies += b.run(f"def {name}", lang, cwd)
        else:
            bodies += b.run(f"function {name}", lang, cwd)
            bodies += b.run(f"const {name} = $ARROW", lang, cwd)
    out = [block("Assertions in this file whose two sides are identical:", same),
           block("Bodies of the functions under test:", bodies)]
    return "\n\n".join(p for p in out if p)

ENCLOSING = re.compile(r"(?:^|\s)(?:def|function)\s+(\w+)|"
                       r"(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(")


def enclosing_name(path: str, added: str) -> list[str]:
    """The function the edit landed in, when the hunk itself defines none."""
    anchor = next((l.strip() for l in added.splitlines() if l.strip()), "")
    if not anchor:
        return []
    try:
        with open(path, errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    at = next((i for i, l in enumerate(lines) if anchor in l), None)
    if at is None:
        return []
    fallback = []
    for i in range(at, -1, -1):
        m = ENCLOSING.search(lines[i])
        if not m:
            continue
        if m.group(1):
            return [m.group(1)]

        fallback = fallback or [m.group(2)]
    return fallback

CATCHES = re.compile(r"\b(catch|except)\b")
THROWS = re.compile(r"\b(throw|raise|reject)\b")
RETURNS = re.compile(r"\breturn\b")
LOGS = re.compile(r"\b(console\.\w+|logger?\.\w+|print|log)\s*\(")


def error_hits(added: str, rel: str, lang: str, cwd: str, b: _Budget) -> str:
    """Whether swallowing an error matters depends on who calls the function,
    which is exactly what the hunk leaves out."""

    if not (CATCHES.search(added) or re.search(r"(?i)\berr(or)?\b", added)):
        return ""

    if THROWS.search(added):
        what = "re-raises"
    elif RETURNS.search(added):
        what = "returns a value instead of re-raising"
    else:
        what = "neither re-raises nor returns"
    summary = (f"The error handling this edit adds {what}"
               + (" and logs." if LOGS.search(added) else
                  " and does not log."))
    names: list[str] = []
    for m in DEFINED.finditer(added):
        name = m.group(1) or m.group(2)
        if name and name not in names:
            names.append(name)
    if not names:
        names = enclosing_name(os.path.join(cwd, rel), added)
    hits = []
    for name in names[:MAX_LITERALS]:
        hits += [h for h in b.run(f"{name}($$$)", lang, cwd)
                 if os.path.normpath(h["path"]) != os.path.normpath(rel)]
    listed = block("Callers of the function whose error handling this edit "
                   "changes:", hits)
    return f"{summary}\n{listed}" if listed else summary


def comparator(subject: str, hunk: str, rel: str, cwd: str) -> str:
    """The labeled block for one subject, or "" when there is nothing to say.
    Never raises: the caller is a hook that must not fail."""
    try:
        import rules
        lang = lang_for(rel)
        if not lang or not cwd:
            return ""
        exe, _src = which()
        if not exe:
            spawn_fetch()
            return ""
        added = rules.added_body(hunk)
        if not added.strip():
            return ""
        b = _Budget()
        if subject == "literals_constants":
            return literal_hits(added, lang, cwd, b)

        if subject == "tests":
            return test_hits(added, rel, lang, cwd, b)
        if subject == "errors":
            return error_hits(added, rel, lang, cwd, b)
        return ""
    except Exception:
        return ""


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "which"
    if cmd == "fetch":
        return 0 if fetch() else 1
    path, source = which()
    print(f"{path or '(none)'}  [{source}]  pinned {VERSION} -> {BIN}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
