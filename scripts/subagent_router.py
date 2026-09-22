#!/usr/bin/env python3
"""PreToolUse hook (Agent|Task): ask Jev which model tier a delegated task
needs, and set the subagent's `model` before it spawns — when the caller
didn't pick one explicitly. In the same call, check that a brief which
changes files says where, what done looks like, how to verify, and whether
to commit; a brief confidently missing one of those is denied once with the
list, so the parent rewrites it instead of the subagent guessing.

This is real routing, not advisory: `updatedInput` replaces the tool input,
so the subagent starts on the tier Jev picked. A model already present in
tool_input always wins — Claude named it on purpose. Tier criteria come from
the user's `CLAUDE.md` in the Claude config dir when it has a "Delegating to sub-agents"
section with `- tier: text` bullets; otherwise the shipped text is used.

Always exits 0 and prints nothing on any failure — routing must never block
a spawn.

Env:
  TYPESAFE_API_KEY   required (else silently disabled)
"""

import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev

MIN_CONFIDENCE = 0.75
BRIEF_MISSING = 0.25
DEFAULT_LOG = os.path.join(jev.config_dir(), "jev-router-log.jsonl")
USER_RULES = os.path.join(jev.config_dir(), "CLAUDE.md")
TIERS = ("haiku", "sonnet", "opus", "fable")
BRIEF_PARTS = {
    "brief_paths": "the exact files or paths to work in",
    "brief_acceptance": "acceptance criteria",
    "brief_verify": "the verification command to run",
    "brief_commit": "the commit policy (default: do not commit)",
}


def user_tier_criteria(path: str = USER_RULES) -> dict:
    """`- haiku: text` bullets under a "Delegating to sub-agents" heading,
    keyed by tier. Empty when the file or section is absent."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return {}
    out, inside = {}, False
    for line in lines:
        if line.startswith("#"):
            inside = "delegating to sub-agents" in line.lower().replace("subagents", "sub-agents")
            continue
        m = re.match(r"^\s*[-*]\s*`?(\w+)`?\s*:\s*(.+\S)\s*$", line) if inside else None
        if m and m.group(1).lower() in TIERS:
            out[m.group(1).lower()] = m.group(2)
    return out


def build_state(inp: dict) -> str:
    parts = [f"Agent type: {inp.get('subagent_type') or 'general'}"]
    if inp.get("description"):
        parts.append(f"Task summary: {inp['description']}")
    if inp.get("prompt"):
        parts.append(f"Task: {inp['prompt'][:8000]}")
    return "\n\n".join(parts)


def missing_parts(answers: dict) -> list[str]:
    writes = (answers.get("brief_writes") or {}).get("noul", 0.0)
    if writes < MIN_CONFIDENCE:
        return []
    return [k for k in BRIEF_PARTS
            if (answers.get(k) or {}).get("noul", 1.0) <= BRIEF_MISSING]


def already_denied(session_id, prompt_head: str) -> bool:
    """One denial per brief per session: a second identical spawn means the
    parent chose not to add the part, and a loop is worse than a thin brief."""
    try:
        with open(DEFAULT_LOG, encoding="utf-8") as f:
            for line in f:
                if '"kind": "subagent"' not in line:
                    continue
                r = json.loads(line)
                if (r.get("session_id") == session_id and r.get("brief_denied")
                        and r.get("prompt") == prompt_head):
                    return True
    except (OSError, ValueError):
        pass
    return False


def log_decision(event: dict, inp: dict, answers: dict, routed: str | None,
                 explicit: str | None, missing: list[str], denied: bool) -> None:
    """Record what was predicted and what ran, so a later eval can score the
    routing. kind=subagent keeps these rows distinct from prompt decisions.
    """
    try:
        with open(DEFAULT_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "kind": "subagent",
                "session_id": event.get("session_id"),
                "cwd": event.get("cwd"),
                "subagent_type": inp.get("subagent_type"),
                "prompt": (inp.get("prompt") or "")[:200],
                "answers": answers,
                "model_routed": routed,
                "model_explicit": explicit,
                "brief_missing": missing,
                "brief_denied": denied,
            }) + "\n")
    except OSError:
        pass


def main() -> None:
    try:
        event = json.load(sys.stdin)
        inp = event.get("tool_input") or {}
        explicit = inp.get("model")
        answers = jev.ask(build_state(inp),
                          jev.subagent_bundle(user_tier_criteria(), ask_tier=not explicit))
        t = answers.get("model_tier") or {}
        choice, conf = t.get("choice"), t.get("confidence", 0.0)
        routed = choice if choice in TIERS and conf >= MIN_CONFIDENCE else None
        missing = missing_parts(answers)
        prompt_head = (inp.get("prompt") or "")[:200]
        denied = bool(missing) and not already_denied(event.get("session_id"), prompt_head)
        log_decision(event, inp, answers, routed, explicit, missing, denied)
        out: dict = {"hookSpecificOutput": {"hookEventName": "PreToolUse"}}
        if denied:
            listed = "; ".join(BRIEF_PARTS[k] for k in missing)
            out["hookSpecificOutput"]["permissionDecision"] = "deny"
            out["hookSpecificOutput"]["permissionDecisionReason"] = (
                "This brief changes files but does not state: " + listed +
                ". The subagent sees none of this conversation. Add the "
                "missing parts to the prompt and spawn again.")
        elif missing:
            out["systemMessage"] = ("[jev router] brief still missing " +
                                    ", ".join(BRIEF_PARTS[k] for k in missing) +
                                    " — spawned anyway (denied once already)")
        if routed and not denied:
            out["hookSpecificOutput"]["updatedInput"] = {**inp, "model": routed}
            out["systemMessage"] = f"[jev router] subagent → {routed} (conf={conf:.2f})"
        if len(out["hookSpecificOutput"]) > 1 or "systemMessage" in out:
            json.dump(out, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return

if __name__ == "__main__":
    main()
    sys.exit(0)
