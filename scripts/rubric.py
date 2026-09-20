#!/usr/bin/env python3
"""Compiled rubric — the committed artifact /jev:rules-compile writes.

A rubric is a hand-editable JSON file of rules extracted from the project's
instruction files. It exists because raw markdown parsing drifts: a stable,
human-reviewed rule list keeps the judge's questions fixed while the wording
around them is edited, and gives every verdict a rule id a person can point
at. When `.claude/jev-rubric.json` exists it replaces markdown parsing for
the project; `~/.claude/jev-rubric.json` does the same for global rules.
Project rules win on an id clash.

Schema (subset of github.com/coldteadotai/abide's rubric):

  {
    "version": 1,
    "compiledAt": "<iso>",
    "sources": [{"path": "AGENTS.md", "scope": "**/*", "sha": "<sha256>"}],
    "thresholds": {"act": 0.8, "flag": 0.5},
    "rules": [{
      "id": "kebab-case",
      "text": "the rule, in the user's words",
      "source": {"path": "AGENTS.md", "line": 12},
      "scope": ["src/**/*.ts"],            // optional; absent = every file
      "when": "edit" | "turn",             // required on model rules
      "status": "active"|"weak"|"noisy"|"disabled",   // default active
      "check": {"type": "model", "question": {...}}
             | {"type": "lint", "how"|"pattern": "..."}
             | {"type": "deferred", "reason": "..."}
             | {"type": "unenforceable", "reason": "..."}
    }]
  }

Only active model rules are judged. `lint` names a check a real linter owns —
recorded, never run, never sent to the model. `deferred` and `unenforceable`
are rules no diff can answer; they sit in the rubric so the report is honest.

Question types: `boolean` (a noul, optional true/false criteria),
`choice` (criteria map + `violating` option list), `score` (ordered criteria
list + `violatingFrom` index). Any of them yields a violation probability.

CLI: `python3 rubric.py --validate [path]` parses the rubric, fills source
hashes, and prints bucket counts and problems.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sys

RUBRIC_VERSION = 1
PROJECT_RUBRIC = ".claude/jev-rubric.json"
GLOBAL_RUBRIC = os.path.expanduser("~/.claude/jev-rubric.json")

STATUSES = {"active", "weak", "noisy", "disabled"}
CHECK_TYPES = {"model", "lint", "deferred", "unenforceable"}
WHENS = {"edit", "turn"}
ID_RX = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def sha256_file(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def source_abs(cwd: str, path: str) -> str:
    if path.startswith("~/"):
        return os.path.expanduser(path)
    return os.path.join(cwd, path)


def validate_question(q) -> list[str]:
    """Structural checks only — the file is a boundary, so it gets parsed."""
    problems = []
    if not isinstance(q, dict) or not isinstance(q.get("instructions"), str):
        return ["question needs an instructions string"]
    qtype = q.get("type")
    if qtype == "boolean":
        crit = q.get("criteria")
        if crit is not None and not isinstance(crit, dict):
            problems.append("boolean criteria must be an object")
    elif qtype == "choice":
        crit, violating = q.get("criteria"), q.get("violating")
        if not isinstance(crit, dict) or len(crit) < 2:
            problems.append("choice needs a criteria object with 2+ options")
        elif (not isinstance(violating, list) or not violating
              or any(v not in crit for v in violating)
              or len(violating) >= len(crit)):
            problems.append("choice needs violating options drawn from, "
                            "but smaller than, criteria")
    elif qtype == "score":
        crit, vf = q.get("criteria"), q.get("violatingFrom")
        if not isinstance(crit, list) or len(crit) < 2:
            problems.append("score needs an ordered criteria list of 2+ levels")
        elif not isinstance(vf, int) or vf < 1 or vf >= len(crit):
            problems.append("score needs violatingFrom pointing at a level")
    else:
        problems.append(f"unknown question type {qtype!r}")
    return problems


def normalize(rule, path: str, i: int) -> tuple[dict | None, str | None]:
    """Rubric rule -> internal shape, or a problem string."""
    if not isinstance(rule, dict):
        return None, f"rule #{i}: not an object"
    rid = rule.get("id")
    if not isinstance(rid, str) or not ID_RX.match(rid):
        return None, f"rule #{i}: id must be kebab-case"
    if not isinstance(rule.get("text"), str):
        return None, f"{rid}: needs text"
    check = rule.get("check")
    ctype = (check or {}).get("type")
    if ctype not in CHECK_TYPES:
        return None, f"{rid}: check.type must be one of {sorted(CHECK_TYPES)}"
    when = rule.get("when")
    if ctype == "model" and when not in WHENS:
        return None, f'{rid}: model rules need "when": "edit" or "turn"'
    if ctype == "model":
        probs = validate_question(check.get("question"))
        if probs:
            return None, f"{rid}: {probs[0]}"
    scope = rule.get("scope")
    if scope is not None and not isinstance(scope, list):
        return None, f"{rid}: scope must be a list of globs"
    src = rule.get("source") or {}
    status = rule.get("status", "active")
    if status not in STATUSES:
        return None, f"{rid}: unknown status {status!r}"
    return {
        "id": rid, "text": rule["text"],
        "file": src.get("path", path), "line": src.get("line", 0),
        "scope": scope or [], "when": when, "check": check,
        "status": status,
    }, None


def read_rubric(path: str, cwd: str) -> tuple[list[dict], dict | None, list[str], bool]:
    """(rules, thresholds, problems, stale). Missing file -> empty."""
    rules, problems = [], []
    thresholds = None
    stale = False
    try:
        with open(path, errors="replace") as f:
            data = json.load(f)
    except OSError:
        return rules, thresholds, problems, stale
    except ValueError as e:
        return rules, thresholds, [f"{path}: not JSON ({e})"], stale
    if not isinstance(data, dict):
        return rules, thresholds, [f"{path}: not an object"], stale
    seen = set()
    for i, raw in enumerate(data.get("rules") or []):
        rule, problem = normalize(raw, path, i)
        if problem:
            problems.append(f"{path}: {problem}")
        elif rule["id"] in seen:
            problems.append(f"{path}: duplicate rule id {rule['id']!r}")
        else:
            seen.add(rule["id"])
            rules.append(rule)
    t = data.get("thresholds")
    if (isinstance(t, dict) and isinstance(t.get("act"), (int, float))
            and isinstance(t.get("flag"), (int, float))
            and 0 <= t["flag"] < t["act"] <= 1):
        thresholds = {"act": float(t["act"]), "flag": float(t["flag"])}
    for s in data.get("sources") or []:
        if not isinstance(s, dict) or not s.get("sha"):
            continue
        now = sha256_file(source_abs(cwd, s.get("path", "")))
        if now is not None and now != s["sha"]:
            stale = True
    return rules, thresholds, problems, stale


def load(cwd: str) -> dict:
    """Merged view for the hook. `has_*` marks which domains a rubric owns,
    so rules.py can fall back to markdown parsing only where none exists."""
    project_rules, p_thresh, problems, p_stale = read_rubric(
        os.path.join(cwd, PROJECT_RUBRIC), cwd)
    global_rules, g_thresh, g_problems, g_stale = read_rubric(GLOBAL_RUBRIC, cwd)
    by_id = {r["id"]: r for r in global_rules}
    by_id.update({r["id"]: r for r in project_rules})
    return {
        "rules": list(by_id.values()),
        "thresholds": p_thresh or g_thresh,
        "problems": problems + g_problems,
        "stale": p_stale or g_stale,
        "has_project": bool(project_rules) or os.path.exists(
            os.path.join(cwd, PROJECT_RUBRIC)),
        "has_global": os.path.exists(GLOBAL_RUBRIC),
    }


def jev_question(rule: dict) -> dict | None:
    """Rubric model question -> API question. boolean criteria folds into the
    instructions because noul takes no criteria field."""
    q = (rule["check"] or {}).get("question") or {}
    instructions = q.get("instructions", "")
    if q.get("type") == "boolean":
        crit = q.get("criteria") or {}
        if crit.get("true"):
            instructions += f" True means: {crit['true']}."
        if crit.get("false"):
            instructions += f" False means: {crit['false']}."
        return {"type": "noul", "instructions": instructions}
    if q.get("type") == "choice":
        return {"type": "choice", "instructions": instructions,
                "criteria": dict(q.get("criteria") or {})}
    if q.get("type") == "score":
        return {"type": "score", "instructions": instructions,
                "criteria": list(q.get("criteria") or [])}
    return None


def violation_probability(rule: dict, answer: dict | None) -> tuple[float, str | None]:
    """P(rule is violated) whatever the question shape — abide's logic:
    probability mass sitting on the violating options."""
    if not isinstance(answer, dict):
        return 0.0, None
    q = (rule["check"] or {}).get("question") or {}
    probs = answer.get("probabilities")
    if q.get("type") == "boolean":
        p = answer.get("noul")
        return (min(1.0, max(0.0, p)) if isinstance(p, (int, float)) else 0.0), None
    if q.get("type") == "choice":
        violating = set(q.get("violating") or [])
        picked = answer.get("choice")
        if isinstance(probs, dict):
            mass = sum(v for k, v in probs.items()
                       if k in violating and isinstance(v, (int, float)))
            return min(1.0, max(0.0, mass)), picked
        return (1.0 if picked in violating else 0.0), picked
    if q.get("type") == "score":
        vf = int(q.get("violatingFrom") or 1)
        score = answer.get("score")
        label = None
        if isinstance(score, (int, float)):
            levels = q.get("criteria") or []
            idx = min(len(levels) - 1, max(0, round(score)))
            label = f"{levels[idx] if idx < len(levels) else idx} ({score:.2f})"
        if isinstance(probs, dict):
            mass = sum(v for k, v in probs.items()
                       if str(k).lstrip("-").isdigit() and int(k) >= vf
                       and isinstance(v, (int, float)))
            return min(1.0, max(0.0, mass)), label
        return ((1.0 if score >= vf else 0.0)
                if isinstance(score, (int, float)) else 0.0), label
    return 0.0, None


def fill_source_shas(path: str, cwd: str) -> int:
    """Stamp each source's sha in place. Returns sources hashed."""
    try:
        with open(path, errors="replace") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return 0
    n = 0
    for s in data.get("sources") or []:
        if isinstance(s, dict) and s.get("path"):
            sha = sha256_file(source_abs(cwd, s["path"]))
            if sha:
                s["sha"] = sha
                n += 1
    try:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
    except OSError:
        pass
    return n


def cmd_validate(path: str) -> int:
    cwd = os.path.dirname(os.path.dirname(os.path.abspath(path)))
    rules, thresholds, problems, stale = read_rubric(path, cwd)
    buckets = {"model": 0, "lint": 0, "deferred": 0, "unenforceable": 0}
    inactive = 0
    for r in rules:
        buckets[r["check"]["type"]] += 1
        if r["status"] != "active":
            inactive += 1
    n_sha = fill_source_shas(path, cwd)
    print(f"{path}: {len(rules)} rules "
          f"(model={buckets['model']} lint={buckets['lint']} "
          f"deferred={buckets['deferred']} "
          f"unenforceable={buckets['unenforceable']}"
          f"{f', {inactive} inactive' if inactive else ''})"
          f"  sources hashed: {n_sha}  stale: {stale}")
    if thresholds:
        print(f"  thresholds: act={thresholds['act']} flag={thresholds['flag']}")
    for p in problems:
        print(f"  problem: {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--validate":
        target = sys.argv[2] if len(sys.argv) > 2 else PROJECT_RUBRIC
        sys.exit(cmd_validate(target))
    print(__doc__)
    sys.exit(0)
