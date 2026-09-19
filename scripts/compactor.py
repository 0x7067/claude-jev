#!/usr/bin/env python3
"""SessionStart(compact) hook: after Claude Code compacts, Jev decides which
transcript blocks still matter and the kept ones are re-injected verbatim —
selection over history, on top of the generated summary.

The transcript file is append-only, so the pre-compaction lines are still
there when this fires; blocks before the last compact boundary are what get
judged. SessionStart is the only post-compaction event that can inject
context (PreCompact/PostCompact output is discarded), which is also why the
whole feature lives in this one hook — there is no digest handoff to manage.

Always exits 0 and prints nothing on any failure — a hook must never block
or corrupt a session after compaction.

Env:
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
  JEV_OFF=1                            disable the hook
  JEV_COMPACT_KEEP                     noul threshold to keep a block (default 0.5)
  JEV_COMPACT_MAX_BLOCKS               max blocks judged per compaction (default 45;
                                       oldest beyond the cap are dropped unjudged)
  JEV_COMPACT_CHUNK                    questions per API call (default 20; chunks
                                       run in parallel)
  JEV_COMPACT_BLOCK_CHARS              chars of each block shown to Jev (default 1200)
  JEV_COMPACT_KEEP_CHARS               chars of each kept block injected (default 1500)
  JEV_COMPACT_LOG                      stats log path, or 0 to disable
                                       (default ~/.claude/jev-compact-log.jsonl)
  JEV_MODEL, JEV_TIMEOUT               forwarded to jev.py
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

KEEP_THRESHOLD = float(os.environ.get("JEV_COMPACT_KEEP", "0.5"))
MAX_BLOCKS = int(os.environ.get("JEV_COMPACT_MAX_BLOCKS", "45"))
CHUNK = int(os.environ.get("JEV_COMPACT_CHUNK", "20"))
BLOCK_CHARS = int(os.environ.get("JEV_COMPACT_BLOCK_CHARS", "1200"))
KEEP_CHARS = int(os.environ.get("JEV_COMPACT_KEEP_CHARS", "1500"))
STATS_LOG = os.environ.get("JEV_COMPACT_LOG", os.path.expanduser("~/.claude/jev-compact-log.jsonl"))
TAIL_LINES = 5000  # transcript read window; a bound, not a target

META_PREFIXES = ("<command-", "<local-command", "<system-reminder", "<caveat", "<bash-")


def block_text(content) -> str:
    """Flatten one transcript message's content into a one-line string."""
    if isinstance(content, str):
        return content
    parts = []
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            parts.append(b.get("text", ""))
        elif t == "tool_use":
            parts.append(f"[tool_use {b.get('name', '?')}] {json.dumps(b.get('input', {}))[:400]}")
        elif t == "tool_result":
            c = b.get("content")
            if isinstance(c, list):
                c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
            parts.append(f"[tool_result] {str(c or '')[:800]}")
    return "\n".join(parts)


def transcript_blocks(transcript_path: str) -> list[dict]:
    """User/assistant turns before the last compact boundary, oldest first.
    Sidechains, meta lines, and trivial acks are skipped before Jev sees them."""
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-TAIL_LINES:]
    except OSError:
        return []
    blocks, boundary = [], -1
    for i, line in enumerate(lines):
        if len(line) > 2_000_000:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("subtype") == "compact_boundary" or d.get("isCompactSummary"):
            boundary = i
            continue
        if d.get("isSidechain") or d.get("type") not in ("user", "assistant"):
            continue
        msg = d.get("message") or {}
        role = msg.get("role") or d["type"]
        text = block_text(msg.get("content")).strip()
        if not text or text.startswith(META_PREFIXES):
            continue
        if role == "user" and re.fullmatch(r"(ok|yes|no|thanks|continue)\.?", text, re.I):
            continue
        blocks.append({"role": role, "text": text, "i": i})
    if boundary >= 0:
        blocks = [b for b in blocks if b["i"] < boundary]
    return blocks


def compact_state(blocks: list[dict], event: dict) -> str:
    header = [
        "Transcript of an AI coding-assistant session that was just compacted.",
        "Blocks are numbered [0]..[N], oldest first.",
    ]
    if event.get("cwd"):
        header.append(f"Working directory: {event['cwd']}")
    body = "\n\n".join(f"[{i}] [{b['role']}] {b['text'][:BLOCK_CHARS]}"
                       for i, b in enumerate(blocks))
    return "\n".join(header) + "\n\n" + body


def keep_questions(n: int) -> dict:
    return {
        f"keep_{i}": {
            "type": "noul",
            "instructions": f"If this session's history were compacted, would block [{i}] "
                            "(marked [{i}] in the state) still be needed to continue the work — "
                            "a decision, constraint, file path, error cause, or open task the "
                            "agent would otherwise lose? Answer yes only for lasting information "
                            "value, not for politeness or because it is recent.",
        }
        for i in range(n)
    }


def ask_chunked(state: str, n: int) -> dict:
    """One batched ask per CHUNK questions, chunks in parallel — each chunk's
    questions score in one request, so wall time stays ~1 round trip."""
    questions = keep_questions(n)
    keys = list(questions)
    chunks = [dict((k, questions[k]) for k in keys[i:i + CHUNK])
              for i in range(0, n, CHUNK)]
    if len(chunks) == 1:
        return jev.ask(state, chunks[0])
    answers: dict = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chunks)) as ex:
        for part in ex.map(lambda q: jev.ask(state, q), chunks):
            answers.update(part)
    return answers


def log_stats(event: dict, judged: int, kept: int, before: int, after: int, ms: int) -> None:
    if STATS_LOG == "0":
        return
    try:
        os.makedirs(os.path.dirname(STATS_LOG), exist_ok=True)
        with open(STATS_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "session_id": event.get("session_id"),
                "judged": judged, "kept": kept,
                "chars_before": before, "chars_after": after, "ms": ms,
            }) + "\n")
    except OSError:
        pass


def main() -> None:
    try:
        if os.environ.get("JEV_OFF"):
            return
        event = json.load(sys.stdin)
        if event.get("hook_event_name") != "SessionStart" or event.get("source") != "compact":
            return
        judged = transcript_blocks(event.get("transcript_path") or "")[-MAX_BLOCKS:]
        if not judged:
            return
        state = compact_state(judged, event)
        t0 = time.monotonic()
        answers = ask_chunked(state, len(judged))
        ms = int((time.monotonic() - t0) * 1000)
        kept = []
        for i, b in enumerate(judged):
            noul = (answers.get(f"keep_{i}") or {}).get("noul")
            if noul is None or noul >= KEEP_THRESHOLD:  # unscored: keep, don't lose context
                kept.append(b["text"][:KEEP_CHARS])
        log_stats(event, len(judged), len(kept),
                  sum(len(b["text"]) for b in judged), sum(len(t) for t in kept), ms)
        if not kept:
            return
        digest = "# Context Jev kept from before compaction\n\n" + "\n\n---\n\n".join(kept)
        json.dump({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": digest,
            }
        }, sys.stdout)
        sys.stdout.write("\n")
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
