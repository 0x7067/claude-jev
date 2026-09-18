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
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
  JEV_OFF=1                            disable the hook
  JEV_MIN_CONFIDENCE                   intent confidence floor (default 0.75)
  JEV_MAX_QUIET                        no-tools gate (default 0.10)
  JEV_LOG                              decision log path, or 0 to disable
  JEV_MODEL, JEV_TIMEOUT               forwarded to jev.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

MIN_CONFIDENCE = float(os.environ.get("JEV_MIN_CONFIDENCE", "0.75"))
DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")
MAX_QUIET = float(os.environ.get("JEV_MAX_QUIET", "0.10"))
CONTEXT_LINES = 400

GUIDANCE = {
    "chat": "Answer directly from the conversation. No file reads, no commands.",
    "lookup": "Fact-finding — one targeted search, concise answer, then stop.",
    "fix": "Small change — locate the code, make a focused edit, run the narrowest verification.",
    "feature": "Multi-step implementation — outline a brief plan before editing; verify with build/tests.",
    "ops": "Likely a command/build/git task — run it and report the output.",
}


def conversation_tail(transcript_path: str, prompt: str) -> tuple[str, str]:
    """Last user message and last assistant reply, for follow-up prompts.

    Returns empty strings for anything unreadable — context is an improvement,
    not a requirement.
    """
    prev_user = prev_assistant = ""
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-CONTEXT_LINES:]
    except OSError:
        return "", ""
    for line in reversed(lines):
        if prev_user and prev_assistant:
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
                text = "\n".join(b.get("text", "") for b in content
                                 if isinstance(b, dict) and b.get("type") == "text")
            text = (text or "").strip()
            # The current prompt may already be appended; it is not context.
            if text and text != prompt and not text.startswith("<"):
                prev_user = text
        elif d.get("type") == "assistant" and not prev_assistant and isinstance(content, list):
            text = "\n".join(b.get("text", "") for b in content
                             if isinstance(b, dict) and b.get("type") == "text").strip()
            if text:
                prev_assistant = text
    return prev_user, prev_assistant


def build_state(prompt: str, transcript_path: str | None) -> str:
    if not transcript_path:
        return prompt
    prev_user, prev_assistant = conversation_tail(transcript_path, prompt)
    if not prev_user and not prev_assistant:
        return prompt
    parts = []
    if prev_user:
        parts.append(f"Earlier user message: {prev_user[:300]}")
    if prev_assistant:
        parts.append(f"Assistant's last reply (truncated): {prev_assistant[-600:]}")
    parts.append(f"Current user message: {prompt}")
    return "\n\n".join(parts)


def decide(answers: dict) -> tuple[str | None, dict]:
    intent = answers.get("intent") or {}
    choice = intent.get("choice")
    conf = intent.get("confidence", 0.0)
    needs_tools = (answers.get("needs_tools") or {}).get("noul")

    # The intent choice is never allowed to say "no tools" on its own: at that
    # job it scored 0.65 precision at best, against 0.96 for the gate below.
    if needs_tools is not None and needs_tools <= MAX_QUIET:
        choice, conf = "chat", 1.0 - needs_tools
    elif choice == "chat" or choice not in GUIDANCE or conf < MIN_CONFIDENCE:
        return None, answers

    scope = (answers.get("scope") or {}).get("score")
    parts = [f"[jev router] intent={choice} conf={conf:.2f}"]
    if scope is not None:
        parts.append(f"scope={'trivial' if scope < 0.5 else 'small' if scope < 1.5 else 'substantial'}")
    line = " ".join(parts)

    tip = GUIDANCE[choice]
    if choice != "chat" and scope is not None:
        if scope < 0.5:
            tip += " Keep it minimal."
        elif scope >= 1.5:
            tip += " Sketch the plan in a few bullets first."
    return f"{line}\n{tip}", answers


def log_decision(event: dict, answers: dict, hint: str | None) -> None:
    """Record what was predicted so a later eval can score it against what the
    session actually did. Joins to the transcript by session id and timestamp.
    """
    path = os.environ.get("JEV_LOG", DEFAULT_LOG)
    if path == "0":
        return
    try:
        import datetime
        with open(path, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "session_id": event.get("session_id"),
                "cwd": event.get("cwd"),
                "prompt": (event.get("prompt") or "")[:200],
                "answers": answers,
                "hint": hint,
            }) + "\n")
    except OSError:
        pass


def main() -> None:
    try:
        if os.environ.get("JEV_OFF"):
            return
        event = json.load(sys.stdin)
        prompt = (event.get("prompt") or "").strip()
        # Skip slash commands, #-memorize lines, and near-empty prompts.
        if len(prompt) < 3 or prompt[0] in "/#":
            return
        answers = jev.ask(build_state(prompt, event.get("transcript_path")),
                          jev.intent_bundle())
        ctx, _ = decide(answers)
        log_decision(event, answers, ctx)
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
