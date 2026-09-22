#!/usr/bin/env python3
"""Zero-dependency TypeSafe/Jev client and CLI.

Used by the prompt-router hook and callable directly by the agent
(via the jev skill) to offload small decisions to a System One model
instead of reasoning through them with generated text.

Env:
  TYPESAFE_API_KEY   API key (required)
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"
DEFAULT_TIMEOUT = 8.0
CALL_LOG = os.path.expanduser("~/.claude/jev-calls.jsonl")

_VERSION: str | None = None


class JevError(Exception):
    pass


def version() -> str:
    """Plugin version from the manifest next to this package, read once.

    Stamped on every log line so numbers from two versions never get averaged
    together. Missing or unreadable manifest answers "unknown": a log field is
    never worth raising over.
    """
    global _VERSION
    if _VERSION is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", ".claude-plugin", "plugin.json")
        try:
            with open(path, encoding="utf-8") as f:
                _VERSION = str(json.load(f).get("version") or "unknown")
        except (OSError, ValueError, AttributeError):
            _VERSION = "unknown"
    return _VERSION


def caller_name() -> str:
    """Which script is asking — `rules`, `prompt_router`, `compactor`, `jev`."""
    name = os.path.basename(sys.argv[0] or "jev")
    return name[:-3] if name.endswith(".py") else (name or "jev")


def log_call(model: str, n_questions: int, t0: float, error: str | None) -> None:
    """Append one call record. Never raises: the caller is mid-request and a
    log failure must not change what `ask` returns or what it raises."""
    try:
        os.makedirs(os.path.dirname(CALL_LOG), exist_ok=True)
        rec = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "caller": caller_name(),
            "n_questions": n_questions,
            "model": model,
            "ms": int((time.monotonic() - t0) * 1000),
            "ok": error is None,
            "v": version(),
        }
        if error is not None:
            rec["error"] = error[:300]
        with open(CALL_LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass


def api_key() -> str:
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise JevError("set TYPESAFE_API_KEY")
    return key


def ask(state, questions: dict, model: str | None = None, timeout: float | None = None) -> dict:
    """Evaluate `questions` against `state`. Returns the `answers` map."""
    body = {
        "state": state,
        "model": model or DEFAULT_MODEL,
        "questions": questions,
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    t = timeout if timeout is not None else DEFAULT_TIMEOUT
    n = len(questions) if isinstance(questions, dict) else 0
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=t) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        log_call(body["model"], n, t0, f"HTTP {e.code}: {detail}")
        raise JevError(f"HTTP {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log_call(body["model"], n, t0, str(e))
        raise JevError(str(e)) from e
    log_call(body["model"], n, t0, None)
    return payload.get("answers", {})


def read_state_arg(value: str):
    """`@path` reads a file, `-` reads stdin, otherwise the literal string."""
    if value == "-":
        return sys.stdin.read()
    if value.startswith("@"):
        with open(value[1:], "r", encoding="utf-8") as f:
            return f.read()
    return value


def parse_opt(opt: str) -> tuple[str, str]:
    name, _, desc = opt.partition("=")
    return name.strip(), desc.strip() or name.strip()


def intent_bundle() -> dict:
    """Questions the router asks about each prompt.

    Measured against 1,613 past prompts (see eval/): `refactor` and `unclear`
    were removed because neither ever reached usable precision, and
    `needs_repo` because a hardcoded "yes" beat it by 18 points. `needs_tools`
    is separate from `intent` on purpose — telling the agent to skip work it
    needs is the costliest mistake, so it gets its own near-certain gate.
    `model_tier` is advisory: the hook can't switch the model, it only tells
    the user which tier the prompt looks like.
    """
    return {
        "intent": {
            "type": "choice",
            "instructions": "What kind of request is this for an AI coding assistant?",
            "criteria": {
                "chat": "Conversation or general question — answer directly, no codebase work needed",
                "lookup": "Needs a specific fact from the codebase — a targeted search suffices",
                "fix": "Small bug fix or tweak — locate the code, make a focused edit, verify narrowly",
                "feature": "New capability or multi-file change — plan briefly before editing",
                "ops": "Run commands: builds, tests, git, CI, deployment — no code changes unless asked",
            },
        },
        "scope": {
            "type": "score",
            "instructions": "How much work does fulfilling this request take?",
            "criteria": [
                "Trivial: a single obvious step",
                "Small: a few localized steps",
                "Substantial: multi-file or multi-phase work",
            ],
        },
        "needs_tools": {
            "type": "noul",
            "instructions": "To handle this message, must the assistant use tools "
                            "(read files, search, run commands, edit code) rather than "
                            "just replying from the conversation?",
        },
        "model_tier": {
            "type": "choice",
            "instructions": "What is the cheapest Claude model tier that would "
                            "handle this request well?",
            "criteria": {
                "haiku": "Mechanical or conversational — chat, quick lookups, "
                         "renames, a single command",
                "sonnet": "Ordinary coding work — focused edits, standard "
                          "features, debugging with a clear signal",
                "opus": "Hardest reasoning — ambiguous multi-file work, "
                        "architecture, subtle bugs",
            },
        },
    }


def subagent_bundle() -> dict:
    """The question PreToolUse asks before an Agent/Task spawn. Unlike the
    prompt-level tier question this one decides the model outright, so the
    phrasing is about delegated tasks, not user requests."""
    return {
        "model_tier": {
            "type": "choice",
            "instructions": "A coding assistant is delegating this task to a "
                            "subagent. What is the cheapest Claude model tier "
                            "the subagent needs to do it well?",
            "criteria": {
                "haiku": "Mechanical, bounded work — search, fetch, summarize, "
                         "count, check; shallow reasoning over clear instructions",
                "sonnet": "Ordinary coding work — focused edits, standard "
                          "features, debugging with a clear signal",
                "opus": "Hardest reasoning — ambiguous multi-file work, "
                        "architecture, subtle bugs",
            },
        },
    }


def main() -> int:
    p = argparse.ArgumentParser(prog="jev", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    ask_p = sub.add_parser("ask", help="raw request: read {state, questions, model?} JSON from stdin")

    choose_p = sub.add_parser("choose", help="pick one option for the given state")
    choose_p.add_argument("question", help="what to decide")
    choose_p.add_argument("state", help="state text, @file, or - for stdin")
    choose_p.add_argument("--opt", action="append", required=True,
                          metavar="NAME=DESC", help="option (repeatable)")

    noul_p = sub.add_parser("noul", help="yes/no probability for the given state")
    noul_p.add_argument("question", help="yes/no question")
    noul_p.add_argument("state", help="state text, @file, or - for stdin")

    score_p = sub.add_parser("score", help="rate state on an ordered rubric")
    score_p.add_argument("question", help="what to rate")
    score_p.add_argument("state", help="state text, @file, or - for stdin")
    score_p.add_argument("--level", action="append", required=True,
                         help="rubric level, lowest first (repeatable, >=2)")

    intent_p = sub.add_parser("intent", help="preset routing bundle for a user request")
    intent_p.add_argument("state", help="request text, @file, or - for stdin")

    try:
        args = p.parse_args()
        if args.cmd == "ask":
            req = json.load(sys.stdin)
            out = ask(req.get("state"), req["questions"], model=req.get("model"))
        elif args.cmd == "choose":
            criteria = dict(parse_opt(o) for o in args.opt)
            if len(criteria) < 2:
                raise JevError("choose needs at least two --opt")
            out = ask(read_state_arg(args.state), {"q": {
                "type": "choice", "instructions": args.question, "criteria": criteria}})["q"]
        elif args.cmd == "noul":
            out = ask(read_state_arg(args.state), {"q": {
                "type": "noul", "instructions": args.question}})["q"]
        elif args.cmd == "score":
            if len(args.level) < 2:
                raise JevError("score needs at least two --level")
            out = ask(read_state_arg(args.state), {"q": {
                "type": "score", "instructions": args.question, "criteria": args.level}})["q"]
        else:
            out = ask(read_state_arg(args.state), intent_bundle())
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0
    except JevError as e:
        print(f"jev: {e}", file=sys.stderr)
        return 2
    except (json.JSONDecodeError, KeyError) as e:
        print(f"jev: bad input: {e}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    sys.exit(main())
