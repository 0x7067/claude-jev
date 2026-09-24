#!/usr/bin/env python3
"""Zero-dependency TypeSafe/Jev client and CLI.

Every hook imports it to hand small decisions to a System One model
instead of reasoning through them with generated text. The CLI serves the
evals, manual checks, and the `/claude-jev` pane (`status`).

Env:
  TYPESAFE_API_KEY   TypeSafe's key variable.
  OPENROUTER_API_KEY OpenRouter's key variable.
                     Either wins over a key saved in the `/claude-jev` pane,
                     which Claude Code hands to hooks as
                     `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`. The pane's
                     Provider row (`CLAUDE_PLUGIN_OPTION_PROVIDER`) pins one
                     provider and its variable. On `auto`, TYPESAFE_API_KEY is
                     read first and the key's prefix picks the provider:
                     `sk-or-...` is OpenRouter, anything else is TypeSafe.
                     Both serve the same System One request, model IDs, and
                     answers.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request


@dataclasses.dataclass(frozen=True)
class Provider:
    name: str
    url: str
    key_prefix: str
    key_var: str


PROVIDERS = (
    Provider("typesafe", "https://api.typesafe.ai/v1/systemone", "", "TYPESAFE_API_KEY"),
    Provider(
        "openrouter", "https://openrouter.ai/api/v1/systemone", "sk-or-", "OPENROUTER_API_KEY"
    ),
)
DEFAULT_MODEL = "jev-latest"
DEFAULT_TIMEOUT = 8.0


def config_dir() -> str:
    """Claude Code's user config directory: `$CLAUDE_CONFIG_DIR` when the
    host sets it, else `~/.claude`. Every file the plugin reads or writes
    under the user's config goes through here."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


CALL_LOG = os.path.join(config_dir(), "jev-calls.jsonl")

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
        path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", ".claude-plugin", "plugin.json"
        )
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


def log_call(
    provider: Provider, model: str, n_questions: int, t0: float, error: str | None
) -> None:
    """Append one call record. Never raises: the caller is mid-request and a
    log failure must not change what `ask` returns or what it raises."""
    try:
        os.makedirs(os.path.dirname(CALL_LOG), exist_ok=True)
        rec = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "caller": caller_name(),
            "n_questions": n_questions,
            "provider": provider.name,
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


def plugin_option(field: str) -> str:
    """A `userConfig` value from `.claude-plugin/plugin.json`, as Claude Code
    exports it to hook processes."""
    return os.environ.get(f"CLAUDE_PLUGIN_OPTION_{field.upper()}", "").strip()


def enabled(field: str) -> bool:
    """Whether a hook's on/off `userConfig` field is on. Unset means on."""
    return plugin_option(field).lower() not in ("false", "0")


def pinned_provider() -> Provider | None:
    """The provider the `provider` `userConfig` field names; None for `auto`."""
    return next((p for p in PROVIDERS if p.name == plugin_option("provider")), None)


def resolve() -> tuple[str, str, Provider | None]:
    """Where the key in effect comes from (`env`, `saved`, or `missing`), the
    key, and the provider it calls. A pinned provider reads only its own
    variable; `auto` reads each provider's variable in `PROVIDERS` order and
    lets the key's prefix pick."""
    pinned = pinned_provider()
    for p in (pinned,) if pinned else PROVIDERS:
        env = os.environ.get(p.key_var, "").strip()
        if env:
            return "env", env, pinned or provider_for(env)
    saved = plugin_option("typesafeApiKey")
    if saved:
        return "saved", saved, pinned or provider_for(saved)
    return "missing", "", pinned


def missing_key_message(pinned: Provider | None) -> str:
    names = [pinned.key_var] if pinned else [p.key_var for p in PROVIDERS]
    return "set " + " or ".join(names)


def provider_for(key: str) -> Provider:
    """The provider whose key prefix is the longest match for `key`."""
    return max(
        (p for p in PROVIDERS if key.startswith(p.key_prefix)), key=lambda p: len(p.key_prefix)
    )


def ask(state, questions: dict, model: str | None = None, timeout: float | None = None) -> dict:
    """Evaluate `questions` against `state`. Returns the `answers` map."""
    body = {
        "state": state,
        "model": model or DEFAULT_MODEL,
        "questions": questions,
    }
    source, key, provider = resolve()
    if source == "missing":
        raise JevError(missing_key_message(provider))
    req = urllib.request.Request(
        provider.url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {key}",
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
        log_call(provider, body["model"], n, t0, f"HTTP {e.code}: {detail}")
        raise JevError(f"HTTP {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log_call(provider, body["model"], n, t0, str(e))
        raise JevError(str(e)) from e
    log_call(provider, body["model"], n, t0, None)
    return payload.get("answers", {})


def last_call() -> dict | None:
    """The newest `jev-calls.jsonl` record, or None when there is none."""
    try:
        with open(CALL_LOG, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 4096))
            lines = f.read().decode(errors="replace").splitlines()
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError):
        return None


def status() -> dict:
    """What the `/claude-jev` pane shows: version, key source and provider,
    and the last call. Never the key."""
    source, _, provider = resolve()
    return {
        "version": version(),
        "key": source,
        "provider": provider.name if provider else None,
        "pinned": plugin_option("provider") or "auto",
        "last_call": last_call(),
    }


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
                "opus": "Hardest reasoning — ambiguous multi-file work, architecture, subtle bugs",
            },
        },
    }


TIER_CRITERIA = {
    "haiku": "Bounded, mechanical work with a clear stop condition and no "
    "design choices: search, fetch, count, summarize, list callers, "
    "run a named command and report its output, apply a rename or "
    "one-line change that the brief spells out exactly. If the "
    "brief says precisely what to do and where, this is enough",
    "sonnet": "Ordinary implementation from a complete brief: focused edits "
    "or a standard feature in named files, a bug with a clear "
    "reproduction or error message, mechanical changes across "
    "several files that follow an existing pattern. Needs local "
    "judgment about code, not decisions about design",
    "opus": "Work where the brief leaves real decisions open: an ambiguous "
    "multi-file change, a bug with no clear signal, design inside a "
    "module, a review that must find what is wrong rather than "
    "confirm what is right, changes in tangled or unfamiliar code. "
    "The default for hard work",
    "fable": "Only when a cheaper tier would likely return a confident wrong "
    "answer: adversarial review of an architecture or a "
    "security-sensitive design, debugging across systems where the "
    "cause is unknown and the evidence conflicts, or a task whose "
    "acceptance criteria cannot be written down in advance. Rare "
    "and the most expensive; not for implementation",
}

BRIEF_CHECKS = {
    "brief_writes": "Does this task ask the subagent to create, edit, or "
    "delete files, as opposed to only reading, searching, "
    "running commands, or reporting?",
    "brief_paths": "Does the brief name the exact files or paths the subagent should work in?",
    "brief_acceptance": "Does the brief state acceptance criteria — how "
    "the subagent can tell the work is done?",
    "brief_verify": "Does the brief name a command or check the subagent "
    "must run to verify its work?",
    "brief_commit": "Does the brief say whether the subagent may commit, or that it must not?",
}


def subagent_bundle(tiers: dict | None = None, ask_tier: bool = True) -> dict:
    """The questions PreToolUse asks before an Agent/Task spawn. Unlike the
    prompt-level tier question this one decides the model outright, so the
    phrasing is about delegated tasks, not user requests. `tiers` replaces
    the shipped criteria text with the user's own, read from their
    instruction file; `ask_tier` is off when the caller already set a model
    and only the brief checks apply."""
    q = {k: {"type": "noul", "instructions": v} for k, v in BRIEF_CHECKS.items()}
    if ask_tier:
        q["model_tier"] = {
            "type": "choice",
            "instructions": "A coding assistant is delegating this task to a "
            "subagent. What is the cheapest Claude model tier "
            "the subagent needs to do it well?",
            "criteria": {**TIER_CRITERIA, **(tiers or {})},
        }
    return q


def main() -> int:
    p = argparse.ArgumentParser(prog="jev", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ask", help="raw request: read {state, questions, model?} JSON from stdin")

    choose_p = sub.add_parser("choose", help="pick one option for the given state")
    choose_p.add_argument("question", help="what to decide")
    choose_p.add_argument("state", help="state text, @file, or - for stdin")
    choose_p.add_argument(
        "--opt", action="append", required=True, metavar="NAME=DESC", help="option (repeatable)"
    )

    noul_p = sub.add_parser("noul", help="yes/no probability for the given state")
    noul_p.add_argument("question", help="yes/no question")
    noul_p.add_argument("state", help="state text, @file, or - for stdin")

    score_p = sub.add_parser("score", help="rate state on an ordered rubric")
    score_p.add_argument("question", help="what to rate")
    score_p.add_argument("state", help="state text, @file, or - for stdin")
    score_p.add_argument(
        "--level",
        action="append",
        required=True,
        help="rubric level, lowest first (repeatable, >=2)",
    )

    intent_p = sub.add_parser("intent", help="preset routing bundle for a user request")
    intent_p.add_argument("state", help="request text, @file, or - for stdin")

    sub.add_parser("status", help="key source, provider, version, and last call as JSON")

    try:
        args = p.parse_args()
        if args.cmd == "status":
            out = status()
        elif args.cmd == "ask":
            req = json.load(sys.stdin)
            out = ask(req.get("state"), req["questions"], model=req.get("model"))
        elif args.cmd == "choose":
            criteria = dict(parse_opt(o) for o in args.opt)
            if len(criteria) < 2:
                raise JevError("choose needs at least two --opt")
            out = ask(
                read_state_arg(args.state),
                {"q": {"type": "choice", "instructions": args.question, "criteria": criteria}},
            )["q"]
        elif args.cmd == "noul":
            out = ask(
                read_state_arg(args.state), {"q": {"type": "noul", "instructions": args.question}}
            )["q"]
        elif args.cmd == "score":
            if len(args.level) < 2:
                raise JevError("score needs at least two --level")
            out = ask(
                read_state_arg(args.state),
                {"q": {"type": "score", "instructions": args.question, "criteria": args.level}},
            )["q"]
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
