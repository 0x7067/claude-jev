#!/usr/bin/env python3
"""UserPromptSubmit hook: classify each prompt with Jev and inject routing
guidance so the agent spends tokens on the work, not on deciding what the
work is.

Always exits 0 and prints nothing on any failure — a routing hint must
never block or corrupt a session.

The shape of this hook is set by eval/replay.py, which scores it against
1,613 real prompts. Two results drive the design: three quarters of prompts
are follow-ups, so the previous turn goes into the classified state; and a
wrong "answer directly" hint is the only mistake that costs real work, so it
requires a near-certain yes/no answer rather than the intent choice alone.

Env:
  TYPESAFE_API_KEY or OPENROUTER_API_KEY   required (else silently disabled)

Off when `promptRouter` ("Prompt routing hints" in /claude-jev or /config) is off.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev
import observed

MIN_CONFIDENCE = 0.75
DEFAULT_LOG = os.path.join(jev.config_dir(), "jev-router-log.jsonl")
MAX_QUIET = 0.10
CONTEXT_LINES = 400

GUIDANCE = {
    "chat": "Answer directly from the conversation. No file reads, no commands.",
    "lookup": "Fact-finding — one targeted search, concise answer, then stop.",
    "fix": "Small change — locate the code, make a focused edit, run the narrowest verification.",
}

TIER_ORDER = ["haiku", "sonnet", "opus", "fable"]


def conversation_tail(transcript_path: str, prompt: str) -> tuple[str, str, str | None]:
    """Last user message, last assistant reply, and the model it ran on.

    Returns empty strings / None for anything unreadable — context is an
    improvement, not a requirement.
    """
    prev_user = prev_assistant = ""
    model = None
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-CONTEXT_LINES:]
    except OSError:
        return "", "", None
    for line in reversed(lines):
        if prev_user and prev_assistant and model:
            break
        if len(line) > 500_000:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("isSidechain"):
            continue
        msg = d.get("message") or {}
        content = msg.get("content")
        if d.get("type") == "user" and not prev_user:
            text = content if isinstance(content, str) else ""
            if isinstance(content, list):
                text = "\n".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            text = (text or "").strip()

            if text and text != prompt and not text.startswith("<"):
                prev_user = text
        elif d.get("type") == "assistant" and isinstance(content, list):
            if model is None:
                m = msg.get("model")
                if isinstance(m, str):
                    model = m
            if not prev_assistant:
                text = "\n".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                ).strip()
                if text:
                    prev_assistant = text
    return prev_user, prev_assistant, model


def build_state(prompt: str, prev_user: str, prev_assistant: str) -> str:
    if not prev_user and not prev_assistant:
        return prompt
    parts = []
    if prev_user:
        parts.append(f"Earlier user message: {prev_user[:300]}")
    if prev_assistant:
        parts.append(f"Assistant's last reply (truncated): {prev_assistant[-600:]}")
    parts.append(f"Current user message: {prompt}")
    return "\n\n".join(parts)


def tier_of(model_name: str | None) -> str | None:
    if not model_name:
        return None
    low = model_name.lower()
    for tier in TIER_ORDER:
        if tier in low:
            return tier
    return None


def tier_hint(answers: dict, model_now: str | None) -> str | None:
    """Advisory only — a hook can't switch the model, so a mismatch is a
    nudge to the user (systemMessage), not a command to the agent."""
    t = answers.get("model_tier") or {}
    choice, conf = t.get("choice"), t.get("confidence", 0.0)
    if choice not in TIER_ORDER or conf < MIN_CONFIDENCE:
        return None
    current = tier_of(model_now)
    if current == choice:
        return None
    line = f"[jev router] model={choice} conf={conf:.2f} — "
    if current is None:
        return line + f"this prompt looks like {choice} work"
    if TIER_ORDER.index(choice) < TIER_ORDER.index(current):
        return line + f"looks like {choice} work; you're on {current}"
    return line + f"may want {choice} for this; you're on {current}"


def decide(answers: dict) -> tuple[str | None, dict]:
    intent = answers.get("intent") or {}
    choice = intent.get("choice")
    conf = intent.get("confidence", 0.0)
    needs_tools = (answers.get("needs_tools") or {}).get("noul")

    if needs_tools is not None and needs_tools <= MAX_QUIET:
        choice, conf = "chat", 1.0 - needs_tools
    elif choice == "chat" or choice not in GUIDANCE or conf < MIN_CONFIDENCE:
        return None, answers

    scope = (answers.get("scope") or {}).get("score")
    parts = [f"[jev router] intent={choice} conf={conf:.2f}"]
    if scope is not None:
        parts.append(
            f"scope={'trivial' if scope < 0.5 else 'small' if scope < 1.5 else 'substantial'}"
        )
    line = " ".join(parts)

    tip = GUIDANCE[choice]
    if choice != "chat" and scope is not None:
        if scope < 0.5:
            tip += " Keep it minimal."
        elif scope >= 1.5:
            tip += " Sketch the plan in a few bullets first."
    return f"{line}\n{tip}", answers


def log_decision(
    event: dict,
    answers: dict,
    hint: str | None,
    tier: str | None,
    model_now: str | None,
    ms: int | None = None,
) -> None:
    """Record what was predicted so a later eval can score it against what the
    session actually did. Joins to the transcript by session id and timestamp.
    """
    try:
        import datetime

        with open(DEFAULT_LOG, "a") as f:
            f.write(
                json.dumps(
                    {
                        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        "session_id": event.get("session_id"),
                        "cwd": event.get("cwd"),
                        "prompt": (event.get("prompt") or "")[:200],
                        "answers": answers,
                        "hint": hint,
                        "tier_hint": tier,
                        "model_now": model_now,
                        "ms": ms,
                        "v": jev.version(),
                    }
                )
                + "\n"
            )
    except OSError:
        pass


def main() -> None:
    try:
        if not jev.enabled("promptRouter"):
            return
        event = json.load(sys.stdin)
        prompt = (event.get("prompt") or "").strip()

        if len(prompt) < 3 or prompt[0] in "/#":
            return

        if observed.is_synthetic(prompt):
            return
        tp = event.get("transcript_path")
        prev_user, prev_assistant, model_now = "", "", None
        if tp:
            prev_user, prev_assistant, model_now = conversation_tail(tp, prompt)
        t0 = time.monotonic()
        answers = jev.ask(build_state(prompt, prev_user, prev_assistant), jev.intent_bundle())
        ms = int((time.monotonic() - t0) * 1000)
        ctx, _ = decide(answers)
        tier = tier_hint(answers, model_now)
        log_decision(event, answers, ctx, tier, model_now, ms)
        out = {}
        if ctx:
            out["hookSpecificOutput"] = {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": ctx,
            }
        if tier:
            out["systemMessage"] = tier
        if out:
            json.dump(out, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return


if __name__ == "__main__":
    main()
    sys.exit(0)
