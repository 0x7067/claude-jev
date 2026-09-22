#!/usr/bin/env python3
"""PreToolUse hook (Agent|Task): ask Jev which model tier a delegated task
needs, and set the subagent's `model` before it spawns — when the caller
didn't pick one explicitly.

This is real routing, not advisory: `updatedInput` replaces the tool input,
so the subagent starts on the tier Jev picked. A model already present in
tool_input always wins — Claude named it on purpose.

Always exits 0 and prints nothing on any failure — routing must never block
a spawn.

Env:
  TYPESAFE_API_KEY   required (else silently disabled)
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev

MIN_CONFIDENCE = 0.75
DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")
TIERS = ("haiku", "sonnet", "opus")


def build_state(inp: dict) -> str:
    parts = [f"Agent type: {inp.get('subagent_type') or 'general'}"]
    if inp.get("description"):
        parts.append(f"Task summary: {inp['description']}")
    if inp.get("prompt"):
        parts.append(f"Task: {inp['prompt'][:8000]}")
    return "\n\n".join(parts)


def log_decision(event: dict, inp: dict, answers: dict, routed: str | None,
                 explicit: str | None) -> None:
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
            }) + "\n")
    except OSError:
        pass


def main() -> None:
    try:
        event = json.load(sys.stdin)
        inp = event.get("tool_input") or {}
        explicit = inp.get("model")
        if explicit:
            log_decision(event, inp, {}, None, explicit)
            return
        answers = jev.ask(build_state(inp), jev.subagent_bundle())
        t = answers.get("model_tier") or {}
        choice, conf = t.get("choice"), t.get("confidence", 0.0)
        routed = choice if choice in TIERS and conf >= MIN_CONFIDENCE else None
        log_decision(event, inp, answers, routed, explicit)
        if routed:
            json.dump({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "updatedInput": {**inp, "model": routed},
                },
                "systemMessage": f"[jev router] subagent → {routed} (conf={conf:.2f})",
            }, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return

if __name__ == "__main__":
    main()
    sys.exit(0)
