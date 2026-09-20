#!/usr/bin/env python3
"""PostToolUse hook (Edit|Write|MultiEdit|NotebookEdit): score each edit
against the rules a linter can't express — the prose instructions in
CLAUDE.md, AGENTS.md, and .claude/rules/*.md — and block with the violated
rule cited, so the agent repairs the file before moving on.

Rules are bullet or numbered list items (bold-prefixed names kept), plus
imperative lines containing DO NOT / NEVER / ALWAYS / MUST. Each edit is
one Jev request asking a noul per rule, in parallel — cheap enough to run
on every edit.

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

VIOLATION_PROB = 0.85
MAX_RULES = 40
MAX_STATE_CHARS = 4000
DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")

RULE_FILES = ("CLAUDE.md", "AGENTS.md")
RULE_DIRS = (".claude/rules", ".cursor/rules")

BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.*)")
HEADING = re.compile(r"^\s*#{1,4}\s+(.*)")
IMPERATIVE = re.compile(r"\b(?:DO NOT|Do not|NEVER|Never|ALWAYS|Always|"
                        r"MUST NOT|must not|MUST|must)\b")
NAMED = re.compile(r"^\*\*([\w-]+)\*\*:?\s*(.*)")


def slug(text: str) -> str:
    return "-".join(re.findall(r"[a-z0-9]+", text.lower())[:5]) or "rule"


def parse_rules(path: str) -> list[dict]:
    """Imperative rules from a markdown instruction file, each with its line
    number for citation. Code fences are skipped — examples aren't rules."""
    rules = []
    try:
        with open(path, errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return rules
    base = os.path.basename(path)
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
        name = None
        nm = NAMED.match(text)
        if nm:
            name, text = nm.group(1), nm.group(2).strip() or text
        rules.append({"id": name or slug(text), "text": text,
                      "file": base, "line": i})
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
                    rules += parse_rules(os.path.join(path, fn))
    return rules[:MAX_RULES]


def edit_text(inp: dict) -> str:
    """The new content an edit introduced — what gets judged."""
    if isinstance(inp.get("edits"), list):  # MultiEdit
        return "\n".join(str(e.get("new_string", "")) for e in inp["edits"]
                         if isinstance(e, dict))
    return inp.get("new_string") or inp.get("content") \
        or inp.get("new_source") or ""


def questions_for(rules: list[dict]) -> dict:
    return {
        f"rule_{i}": {
            "type": "noul",
            "instructions": "Does this edit violate the repository rule: "
                            f"\"{r['text']}\"?",
        }
        for i, r in enumerate(rules)
    }


def log_decision(event: dict, answers: dict, violations: list,
                 n_rules: int) -> None:
    try:
        with open(DEFAULT_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "kind": "rules",
                "session_id": event.get("session_id"),
                "cwd": event.get("cwd"),
                "file": (event.get("tool_input") or {}).get("file_path"),
                "n_rules": n_rules,
                "violations": violations,
                "answers": answers,
            }) + "\n")
    except OSError:
        pass


def main() -> None:
    try:
        event = json.load(sys.stdin)
        inp = event.get("tool_input") or {}
        rules = load_rules(event.get("cwd") or os.getcwd())
        new = edit_text(inp).strip()
        if not rules or not new:
            return
        state = f"File: {inp.get('file_path') or '?'}\n\n" \
                f"Content the edit wrote:\n{new[:MAX_STATE_CHARS]}"
        answers = jev.ask(state, questions_for(rules))
        violations = []
        for i, r in enumerate(rules):
            p = (answers.get(f"rule_{i}") or {}).get("noul")
            if p is not None and p >= VIOLATION_PROB:
                violations.append({"rule": r["id"], "text": r["text"],
                                   "file": r["file"], "line": r["line"],
                                   "prob": round(p, 2)})
        log_decision(event, answers, violations, len(rules))
        if not violations:
            return
        lines = ["This edit appears to break a rule from this repository's "
                 "instructions."]
        for v in violations:
            lines.append(f"- Rule \"{v['rule']}\" from {v['file']} line "
                         f"{v['line']}: \"{v['text']}\" ({v['prob']:.2f})")
        lines.append(f"Repair {inp.get('file_path') or 'the file'} now, "
                     "then continue with the task.")
        json.dump({"decision": "block", "reason": "\n".join(lines)}, sys.stdout)
        sys.stdout.write("\n")
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
