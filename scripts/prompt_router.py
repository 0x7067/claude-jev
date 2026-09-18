#!/usr/bin/env python3
"""UserPromptSubmit hook: classify each prompt with Jev and inject routing
guidance so the agent spends tokens on the work, not on deciding what the
work is.

Always exits 0 and prints nothing on any failure — a routing hint must
never block or corrupt a session.

Env:
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
  JEV_OFF=1                            disable the hook
  JEV_MIN_CONFIDENCE                   intent confidence floor (default 0.55)
  JEV_MODEL, JEV_TIMEOUT               forwarded to jev.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

MIN_CONFIDENCE = float(os.environ.get("JEV_MIN_CONFIDENCE", "0.55"))

GUIDANCE = {
    "chat": "Conversational request — answer directly. No tools or codebase exploration.",
    "lookup": "Fact-finding — one targeted search, concise answer, then stop.",
    "fix": "Small change — locate the code, make a focused edit, run the narrowest verification. No broad exploration.",
    "feature": "Multi-step implementation — outline a brief plan before editing; verify with build/tests.",
    "refactor": "Restructuring — preserve behavior; rely on existing tests to verify.",
    "ops": "Command/build/git task — run it and report output. No code changes unless asked.",
    "unclear": "Ambiguous — ask one short clarifying question before starting work.",
}


def routing_context(prompt: str) -> str | None:
    answers = jev.ask(prompt, jev.intent_bundle())
    intent = answers.get("intent", {})
    choice = intent.get("choice")
    conf = intent.get("confidence", 0.0)
    if choice not in GUIDANCE or conf < MIN_CONFIDENCE:
        return None

    scope = answers.get("scope", {}).get("score")
    needs_repo = answers.get("needs_repo", {}).get("noul")

    parts = [f"[jev router] intent={choice} conf={conf:.2f}"]
    if scope is not None:
        parts.append(f"scope={'trivial' if scope < 0.5 else 'small' if scope < 1.5 else 'substantial'}")
    if needs_repo is not None:
        parts.append(f"needs_repo={'yes' if needs_repo >= 0.5 else 'no'}")
    line = " ".join(parts)

    tip = GUIDANCE[choice]
    if scope is not None and scope < 0.5:
        tip += " Keep it minimal — do not enter plan mode."
    elif scope is not None and scope >= 1.5:
        tip += " Sketch the plan in a few bullets first."
    return f"{line}\n{tip}"


def main() -> None:
    try:
        if os.environ.get("JEV_OFF"):
            return
        event = json.load(sys.stdin)
        prompt = (event.get("prompt") or "").strip()
        # Skip slash commands, #-memorize lines, and near-empty prompts.
        if len(prompt) < 3 or prompt[0] in "/#":
            return
        ctx = routing_context(prompt)
        if ctx:
            json.dump({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": ctx,
                }
            }, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
