#!/usr/bin/env python3
"""PostToolUse hook (Edit|Write|MultiEdit|NotebookEdit): score each edit
against the rules a linter can't express — the prose instructions in
CLAUDE.md, AGENTS.md, and .claude/rules/*.md — and block with the violated
rule cited, so the agent repairs the file before moving on.

Rules are bullet or numbered list items (bold-prefixed names kept), plus
imperative lines containing DO NOT / NEVER / ALWAYS / MUST. A `paths:` front
matter list in a .claude/rules file, or a `(scope: glob)` tail on a rule,
restricts it to matching repo-relative files; out-of-scope rules are never
sent to the model. Each edit is one Jev request asking a noul per rule, in
parallel — cheap enough to run on every edit.

Verdicts are banded: above ACT the hook blocks and the agent sees the cited
rule; between FLAG and ACT the uncertainty goes to the user as a notice and
never reaches the agent; below FLAG nothing happened. One rule may block the
same file at most twice per session — past that it only flags, because a
repair that can't land is a loop, not enforcement.

Always exits 0 and prints nothing on any failure — enforcement must never
corrupt a session.

Env:
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
"""

import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

# Bands, not a single cut at 0.5: act above, flag the middle, ignore below.
ACT = 0.80
FLAG = 0.50
MAX_RULES = 40
MAX_STATE_CHARS = 8000
MAX_TASK_CHARS = 600
MAX_BLOCKS = 2  # per rule+file per session; then flag-only
MAX_PROMPT_TAIL = 400
DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")
BLOCK_DIR = os.path.expanduser("~/.claude/jev-rule-blocks")

RULE_FILES = ("CLAUDE.md", "AGENTS.md")
RULE_DIRS = (".claude/rules", ".cursor/rules")
GLOBAL_RULES = os.path.expanduser("~/.claude/jev-rules.md")

EXCLUDED = re.compile(r"(^|/)(node_modules|\.git|dist|build|\.next|coverage|"
                      r"\.claude|vendor|target)(/|$)|\.lock$|"
                      r"package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$")

BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.*)")
HEADING = re.compile(r"^\s*#{1,4}\s+(.*)")
IMPERATIVE = re.compile(r"\b(?:DO NOT|Do not|NEVER|Never|ALWAYS|Always|"
                        r"MUST NOT|must not|MUST|must)\b")
NAMED = re.compile(r"^\*\*([\w-]+)\*\*:?\s*(.*)")
SCOPE_TAIL = re.compile(r"\(scope:\s*([^)]+)\)\s*$")
FRONT_MATTER = re.compile(r"^---\s*$")


def slug(text: str) -> str:
    return "-".join(re.findall(r"[a-z0-9]+", text.lower())[:5]) or "rule"


def glob_match(path: str, globs: list[str]) -> bool:
    """Repo-relative posix path vs `**`/`*`/`?` globs (stdlib only)."""
    def rx(g: str) -> str:
        out = []
        for part in re.split(r"(\*\*)", g):
            if part == "**":
                out.append(".*")
            else:
                out.append(re.escape(part)
                           .replace(r"\*", "[^/]*").replace(r"\?", "[^/]"))
        return "^" + "".join(out) + "$"
    return any(re.match(rx(g.strip()), path) for g in globs if g.strip())


def frontmatter_paths(lines: list[str]) -> list[str]:
    """`paths:` list from YAML front matter at the top of a rules file —
    the same convention .claude/rules/*.md uses."""
    paths = []
    if not lines or not FRONT_MATTER.match(lines[0]):
        return paths
    in_paths = False
    for raw in lines[1:]:
        line = raw.rstrip()
        if FRONT_MATTER.match(line):
            break
        if re.match(r"^paths:\s*$", line):
            in_paths = True
            continue
        if in_paths:
            m = re.match(r'^\s*-\s*["\']?(.*?)["\']?\s*$', line)
            if m:
                paths.append(m.group(1))
                continue
            in_paths = False
        else:
            m = re.match(r"^paths:\s*\[(.*)\]", line)
            if m:
                paths += [p.strip().strip("\"'") for p in m.group(1).split(",")]
    return paths


def parse_rules(path: str, base_label: str | None = None) -> list[dict]:
    """Imperative rules from a markdown instruction file, each with its line
    number for citation. Code fences are skipped — examples aren't rules."""
    rules = []
    try:
        with open(path, errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return rules
    base = base_label or os.path.basename(path)
    file_scope = frontmatter_paths(lines)
    in_fence = False
    for i, raw in enumerate(lines, 1):
        line = raw.strip()
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not line:
            continue
        m = BULLET.match(line)
        text = m.group(1).strip() if m else None
        if text is None and IMPERATIVE.search(line) and not HEADING.match(line):
            text = line
        if not text or len(text) < 20 or len(text) > 500:
            continue
        scope = list(file_scope)
        sm = SCOPE_TAIL.search(text)
        if sm:
            scope += [g.strip() for g in sm.group(1).split(",")]
            text = text[: sm.start()].strip()
        name = None
        nm = NAMED.match(text)
        if nm:
            name, text = nm.group(1), nm.group(2).strip() or text
        rules.append({"id": name or slug(text), "text": text,
                      "file": base, "line": i, "scope": scope})
    return rules


def load_rules(cwd: str) -> list[dict]:
    rules = []
    for name in RULE_FILES:
        rules += parse_rules(os.path.join(cwd, name))
    for d in RULE_DIRS:
        path = os.path.join(cwd, d)
        if os.path.isdir(path):
            for fn in sorted(os.listdir(path)):
                if fn.endswith((".md", ".mdc")):
                    rules += parse_rules(os.path.join(path, fn),
                                         base_label=f"{d}/{fn}")
    rules += parse_rules(GLOBAL_RULES, base_label="~/.claude/jev-rules.md")
    return rules[:MAX_RULES]


def relative(path: str, cwd: str) -> str:
    try:
        return os.path.relpath(path, cwd)
    except ValueError:
        return path


def last_user_prompt(transcript_path: str | None) -> str:
    """What the user last asked for — rules like "don't touch generated
    files" only mean something against the task."""
    if not transcript_path:
        return ""
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-400:]
    except OSError:
        return ""
    for line in reversed(lines):
        if len(line) > 500_000:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") != "user" or d.get("isSidechain"):
            continue
        c = (d.get("message") or {}).get("content")
        text = c if isinstance(c, str) else ""
        if isinstance(c, list):
            text = "\n".join(b.get("text", "") for b in c
                             if isinstance(b, dict) and b.get("type") == "text")
        text = (text or "").strip()
        if text and not text.startswith(("<", "/", "#")):
            return text[:MAX_TASK_CHARS]
    return ""


def edit_hunks(inp: dict) -> str:
    """Old→new per edit: rules about *removing* something need both sides."""
    if isinstance(inp.get("edits"), list):  # MultiEdit
        parts = []
        for e in inp["edits"]:
            if isinstance(e, dict):
                hunk = ""
                if e.get("old_string"):
                    hunk += f"REMOVED:\n{e['old_string']}\n"
                if e.get("new_string"):
                    hunk += f"ADDED:\n{e['new_string']}"
                parts.append(hunk)
        return "\n\n".join(p for p in parts if p)
    old, new = inp.get("old_string"), inp.get("new_string")
    if old is not None or new is not None:  # Edit
        hunk = ""
        if old:
            hunk += f"REMOVED:\n{old}\n"
        if new:
            hunk += f"ADDED:\n{new}"
        return hunk
    return inp.get("content") or inp.get("new_source") or ""


def questions_for(rules: list[dict]) -> dict:
    return {
        f"rule_{i}": {
            "type": "noul",
            "instructions": "Does this edit violate the repository rule: "
                            f"\"{r['text']}\"?",
        }
        for i, r in enumerate(rules)
    }


def blocks_path(session_id: str) -> str:
    safe = re.sub(r"[^\w-]", "_", session_id or "unknown")
    return os.path.join(BLOCK_DIR, f"{safe}.json")


def block_counts(session_id: str) -> dict:
    try:
        with open(blocks_path(session_id)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def bump_block(session_id: str, key: str, counts: dict) -> None:
    counts[key] = counts.get(key, 0) + 1
    try:
        os.makedirs(BLOCK_DIR, exist_ok=True)
        with open(blocks_path(session_id), "w") as f:
            json.dump(counts, f)
    except OSError:
        pass


def log_decision(event: dict, answers: dict, violations: list,
                 n_rules: int, n_scoped_out: int) -> None:
    try:
        with open(DEFAULT_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "kind": "rules",
                "session_id": event.get("session_id"),
                "cwd": event.get("cwd"),
                "file": (event.get("tool_input") or {}).get("file_path"),
                "n_rules": n_rules,
                "n_scoped_out": n_scoped_out,
                "violations": violations,
                "answers": answers,
            }) + "\n")
    except OSError:
        pass


def cite(v: dict) -> str:
    text = " ".join(v["text"].split())
    if len(text) > 220:
        text = text[:217] + "..."
    return (f"- Rule \"{v['rule']}\" from {v['file']} line {v['line']}: "
            f"\"{text}\" ({v['prob']:.2f})")


def main() -> None:
    try:
        event = json.load(sys.stdin)
        inp = event.get("tool_input") or {}
        cwd = event.get("cwd") or os.getcwd()
        file_path = inp.get("file_path") or ""
        rel = relative(file_path, cwd)
        if EXCLUDED.search(rel):
            return
        rules = load_rules(cwd)
        if not rules:
            return
        in_scope = [r for r in rules
                    if not r["scope"] or glob_match(rel, r["scope"])]
        if not in_scope:
            return
        state = edit_hunks(inp).strip()
        if not state:
            return
        task = last_user_prompt(event.get("transcript_path"))
        parts = [f"File: {rel}"]
        if task:
            parts.append(f"The user's current request: {task}")
        parts.append(f"The edit:\n{state[:MAX_STATE_CHARS]}")
        answers = jev.ask("\n\n".join(parts), questions_for(in_scope))

        hits = []
        for i, r in enumerate(in_scope):
            p = (answers.get(f"rule_{i}") or {}).get("noul")
            if p is not None and p >= FLAG:
                hits.append({"rule": r["id"], "text": r["text"],
                             "file": r["file"], "line": r["line"],
                             "prob": round(p, 2), "band": "act" if p >= ACT
                                         else "flag"})
        sid = event.get("session_id") or "unknown"
        counts = block_counts(sid)
        acting, flagged = [], []
        for v in hits:
            key = f"{v['rule']}|{rel}"
            if v["band"] == "act" and counts.get(key, 0) < MAX_BLOCKS:
                bump_block(sid, key, counts)
                acting.append(v)
            else:
                flagged.append(v)
        log_decision(event, answers,
                     [{k: v[k] for k in ("rule", "file", "line", "prob", "band")}
                      for v in hits],
                     len(rules), len(rules) - len(in_scope))

        out = {}
        if flagged:
            listed = ", ".join(f"{v['rule']} {v['prob']:.2f}" for v in flagged)
            out["systemMessage"] = (f"[jev rules] uncertain about {listed} on "
                                    f"{rel} — not sent to the agent")
        if acting:
            lines = ["This edit appears to break a rule from this "
                     "repository's instructions."]
            lines += [cite(v) for v in acting]
            lines.append(f"Repair {rel} now, then continue with the task.")
            out["decision"] = "block"
            out["reason"] = "\n".join(lines)
        if out:
            json.dump(out, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
