"""Router variants under test.

Each variant is one hypothesis about making the routing hint useful, expressed
as four parts: the questions sent to Jev, the state they see, the rule that
turns answers into a hint, and the ground truth it gets scored against.
Variants that share a bundle and state share cache entries, so a rule-only
change costs no API calls.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Callable

INTENT_CRITERIA = {
    "chat": "Conversation or general question — answer directly, no codebase work needed",
    "lookup": "Needs a specific fact from the codebase — a targeted search suffices",
    "fix": "Small bug fix or tweak — locate the code, make a focused edit, verify narrowly",
    "feature": "New capability or multi-file change — plan briefly before editing",
    "refactor": "Restructure existing code without changing behavior — verify with tests",
    "ops": "Run commands: builds, tests, git, CI, deployment — no code changes unless asked",
    "unclear": "Genuinely ambiguous — a clarifying question is needed before work",
}

SCOPE_Q = {
    "type": "score",
    "instructions": "How much work does fulfilling this request take?",
    "criteria": [
        "Trivial: a single obvious step",
        "Small: a few localized steps",
        "Substantial: multi-file or multi-phase work",
    ],
}

NEEDS_REPO_Q = {
    "type": "noul",
    "instructions": "Does fulfilling this request require reading files in the current repository?",
}

TIER_CRITERIA = {
    "haiku": "Mechanical or conversational — chat, quick lookups, "
             "renames, a single command",
    "sonnet": "Ordinary coding work — focused edits, standard "
              "features, debugging with a clear signal",
    "opus": "Hardest reasoning — ambiguous multi-file work, "
            "architecture, subtle bugs",
}

TIER_Q = {
    "type": "choice",
    "instructions": "What is the cheapest Claude model tier that would "
                    "handle this request well?",
    "criteria": TIER_CRITERIA,
}


def intent_bundle(refactor: bool = True, needs_repo: bool = True, unclear: bool = True) -> dict:
    crit = {k: v for k, v in INTENT_CRITERIA.items()
            if (refactor or k != "refactor") and (unclear or k != "unclear")}
    b = {"intent": {"type": "choice",
                    "instructions": "What kind of request is this for an AI coding assistant?",
                    "criteria": crit},
         "scope": SCOPE_Q}
    if needs_repo:
        b["needs_repo"] = NEEDS_REPO_Q
    return b


def action_bundle() -> dict:
    """Three classes the transcript can actually adjudicate."""
    return {
        "action": {
            "type": "choice",
            "instructions": "What does this message require the assistant to do next?",
            "criteria": {
                "talk": "Answer from the conversation itself — no files opened, no commands run",
                "read": "Inspect the project — read files, search, or run read-only commands",
                "act": "Change something — edit files, or run commands that alter state "
                       "(git, install, deploy, build, test)",
            },
        },
        "scope": SCOPE_Q,
    }


def binary_bundle() -> dict:
    """The single bit the expensive mistakes hinge on."""
    return {
        "needs_tools": {
            "type": "noul",
            "instructions": "To handle this message, must the assistant use tools "
                            "(read files, search, run commands, edit code) rather than "
                            "just replying from the conversation?",
        },
        "scope": SCOPE_Q,
    }


def state_plain(rec: dict) -> str:
    return rec["prompt"]


def state_ctx(rec: dict) -> str:
    if not rec["is_followup"]:
        return rec["prompt"]
    parts = []
    if rec["prev_user"].strip():
        parts.append(f"Earlier user message: {rec['prev_user'].strip()}")
    if rec["prev_assistant"].strip():
        parts.append(f"Assistant's last reply (truncated): {rec['prev_assistant'].strip()}")
    parts.append(f"Current user message: {rec['prompt']}")
    return "\n\n".join(parts)


def truth_intent(rec: dict) -> str:
    return rec["label"]


def truth_action(rec: dict) -> str:
    if rec["n_tools"] == 0:
        return "talk"
    return "act" if (rec["n_edit"] or rec["n_ops"]) else "read"


def truth_binary(rec: dict) -> str:
    return "tools" if rec["n_tools"] > 0 else "no_tools"


def truth_tier(rec: dict) -> str:
    """Proxy truth for model tier: the observed scale of the turn, mapped to
    the cheapest tier that plausibly covers it. Same caveat as every label
    here — it describes what the turn demanded, not what a model could have
    done with less."""
    if rec["scope_actual"] == "substantial" or rec["label"] == "feature":
        return "opus"
    if rec["scope_actual"] == "trivial":
        return "haiku"
    return "sonnet"


def rule_intent(ans: dict, floor: float):
    a = ans.get("intent") or {}
    c, conf = a.get("choice"), a.get("confidence", 0.0)
    return (c, conf) if c and conf >= floor else (None, conf)


def rule_intent_safe_chat(ans: dict, floor: float):
    """`chat` tells the agent to use no tools, which is the costliest hint to
    get wrong, so it must clear a higher bar and agree with a trivial scope."""
    c, conf = rule_intent(ans, floor)
    if c == "chat":
        scope = (ans.get("scope") or {}).get("score")
        if conf < 0.90 or scope is None or scope >= 0.5:
            return (None, conf)
    return (c, conf)


def rule_action(ans: dict, floor: float):
    a = ans.get("action") or {}
    c, conf = a.get("choice"), a.get("confidence", 0.0)
    return (c, conf) if c and conf >= floor else (None, conf)


def rule_binary(ans: dict, floor: float):
    p = (ans.get("needs_tools") or {}).get("noul")
    if p is None:
        return (None, 0.0)
    conf = abs(p - 0.5) * 2
    if conf < floor:
        return (None, conf)
    return ("tools" if p >= 0.5 else "no_tools", conf)


def combined_bundle(unclear: bool = True, tier: bool = False) -> dict:
    """The shipping candidate: intent for the hint text, plus a dedicated
    yes/no question for the one call that is expensive to get wrong."""
    b = intent_bundle(refactor=False, needs_repo=False, unclear=unclear)
    b["needs_tools"] = binary_bundle()["needs_tools"]
    if tier:
        b["model_tier"] = TIER_Q
    return b


def rule_combined(ans: dict, floor: float):
    """A no-tools hint requires the binary question to be near-certain; the
    intent choice is never allowed to produce one on its own."""
    nt = (ans.get("needs_tools") or {}).get("noul")
    if nt is not None and nt <= 0.10:
        return ("chat", 1.0 - nt)
    c, conf = rule_intent(ans, floor)
    return (None, conf) if c == "chat" else (c, conf)


def rule_tier(ans: dict, floor: float):
    a = ans.get("model_tier") or {}
    c, conf = a.get("choice"), a.get("confidence", 0.0)
    return (c, conf) if c in TIER_CRITERIA and conf >= floor else (None, conf)


@dataclass
class Variant:
    name: str
    why: str
    bundle: dict
    state: Callable[[dict], str]
    rule: Callable[[dict, float], tuple]
    truth: Callable[[dict], str]
    classes: list
    quiet_class: str
    unscorable: tuple = ()

    @property
    def bundle_hash(self) -> str:
        return hashlib.sha1(json.dumps(self.bundle, sort_keys=True).encode()).hexdigest()[:12]

INTENTS = list(INTENT_CRITERIA)

VARIANTS = {
    "v0_shipped": Variant(
        "v0_shipped", "the plugin as published: prompt only, all seven intents",
        intent_bundle(), state_plain, rule_intent, truth_intent, INTENTS, "chat", ("refactor",)),
    "v1_context": Variant(
        "v1_context", "change 1: show Jev the previous turn",
        intent_bundle(), state_ctx, rule_intent, truth_intent, INTENTS, "chat", ("refactor",)),
    "v2_no_needs_repo": Variant(
        "v2_no_needs_repo", "change 2: drop needs_repo, which loses to a constant",
        intent_bundle(needs_repo=False), state_ctx, rule_intent, truth_intent,
        INTENTS, "chat", ("refactor",)),
    "v3_no_refactor": Variant(
        "v3_no_refactor", "change 3: drop refactor, which has no observable ground truth",
        intent_bundle(needs_repo=False, refactor=False), state_ctx, rule_intent, truth_intent,
        [i for i in INTENTS if i != "refactor"], "chat"),
    "v4_safe_chat": Variant(
        "v4_safe_chat", "change 4: same answers as v3, but gate the no-tools hint",
        intent_bundle(needs_repo=False, refactor=False), state_ctx, rule_intent_safe_chat,
        truth_intent, [i for i in INTENTS if i != "refactor"], "chat"),
    "v5_three_way": Variant(
        "v5_three_way", "change 5a: talk / read / act instead of seven intents",
        action_bundle(), state_ctx, rule_action, truth_action, ["talk", "read", "act"], "talk"),
    "v6_combined": Variant(
        "v6_combined", "changes 1-4 plus a gated no-tools question",
        combined_bundle(), state_ctx, rule_combined, truth_intent,
        [i for i in INTENTS if i != "refactor"], "chat"),
    "v7_no_unclear": Variant(
        "v7_no_unclear", "v6 minus the unclear class, which never earns its precision",
        combined_bundle(unclear=False), state_ctx, rule_combined, truth_intent,
        [i for i in INTENTS if i not in ("refactor", "unclear")], "chat"),
    "v8_shipped": Variant(
        "v8_shipped", "shipped bundle with model_tier — does intent still hold?",
        combined_bundle(unclear=False, tier=True), state_ctx, rule_combined, truth_intent,
        [i for i in INTENTS if i not in ("refactor", "unclear")], "chat"),
    "v8_tier": Variant(
        "v8_tier", "advisory model tier vs observed scale; harmful = said haiku, turn churned",
        combined_bundle(unclear=False, tier=True), state_ctx, rule_tier, truth_tier,
        list(TIER_CRITERIA), "haiku"),
    "v5_binary": Variant(
        "v5_binary", "change 5b: one bit — does this need tools at all?",
        binary_bundle(), state_ctx, rule_binary, truth_binary, ["no_tools", "tools"], "no_tools"),
}
