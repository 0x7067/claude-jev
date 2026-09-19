#!/usr/bin/env python3
"""PreCompact + SessionStart(compact) hooks: Jev decides which transcript blocks
still matter, and the kept ones are re-injected verbatim after Claude Code
compacts — selection instead of an LLM-written summary.

precompact  (PreCompact): split the session transcript into blocks, ask Jev in
  one batched request whether each block is still needed, and write the kept
  blocks to a per-session digest in JEV_COMPACT_DIR.
sessionstart (SessionStart, matcher "compact"): emit the digest as
  additionalContext, then delete it. SessionStart is the only post-compaction
  event that can inject context — PreCompact/PostCompact output is discarded.

Always exits 0 and prints nothing on any failure — compaction must never be
blocked by a plugin hook.

Env:
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
  JEV_OFF=1                            disable both hooks
  JEV_COMPACT_KEEP                     noul threshold to keep a block (default 0.5)
  JEV_COMPACT_MAX_BLOCKS               max blocks judged per compaction (default 45;
                                       oldest beyond the cap are dropped unjudged)
  JEV_COMPACT_CHUNK                    questions per API call (default 20; chunks
                                       run in parallel)
  JEV_COMPACT_BLOCK_CHARS              chars of each block shown to Jev (default 1200)
  JEV_COMPACT_KEEP_CHARS               chars of each kept block in the digest (default 1500)
  JEV_COMPACT_DIR                      digest dir (default ~/.claude/jev-compact)
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
DIGEST_DIR = os.path.expanduser(os.environ.get("JEV_COMPACT_DIR", "~/.claude/jev-compact"))
STATS_LOG = os.environ.get("JEV_COMPACT_LOG", os.path.expanduser("~/.claude/jev-compact-log.jsonl"))
DIGEST_TTL = 900  # a digest is injected only if PreCompact just ran
TAIL_LINES = 5000  # transcript read window; transcripts rotate, this is a bound not a target

META_PREFIXES = ("<command-", "<local-command", "<system-reminder", "<caveat", "<bash-")


def block_text(content) -> str:
    """Flatten one transcript message's content into a labeled, one-line string."""
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
    """User/assistant turns as labeled blocks, oldest first. Sidechains, meta
    lines, and empty turns are skipped before Jev ever sees them."""
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-TAIL_LINES:]
    except OSError:
        return []
    blocks = []
    for line in lines:
        if len(line) > 2_000_000:
            continue
        try:
            d = json.loads(line)
        except ValueError:
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
        blocks.append({"role": role, "text": text})
    return blocks


def compact_state(blocks: list[dict], event: dict) -> str:
    header = [
        "Transcript of an AI coding-assistant session that is about to be compacted.",
        "Blocks are numbered [0]..[N], oldest first.",
    ]
    if event.get("cwd"):
        header.append(f"Working directory: {event['cwd']}")
    custom = (event.get("custom_instructions") or "").strip()
    if custom:
        header.append(f"The user asked compaction to focus on: {custom}")
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
    """One batched ask per CHUNK questions, chunks in parallel — the API scores
    each chunk's questions in one shot, so wall time stays ~1 round trip."""
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


def digest_path(session_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "unknown")
    return os.path.join(DIGEST_DIR, f"{safe}.md")


def write_digest(event: dict, blocks: list[dict], kept: list[int]) -> None:
    os.makedirs(DIGEST_DIR, exist_ok=True)
    lines = [
        "# Verbatim context Jev kept from before compaction",
        "",
        "These blocks were selected out of the pre-compaction transcript —",
        "kept as-is, not summarized. Older context was dropped entirely.",
        "",
    ]
    for i in kept:
        b = blocks[i]
        lines.append(f"## [{i}] {b['role']}")
        lines.append(b["text"][:KEEP_CHARS])
        lines.append("")
    path = digest_path(event.get("session_id", ""))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def log_stats(event: dict, total: int, judged: int, kept: int,
              before: int, after: int, ms: int) -> None:
    if STATS_LOG == "0":
        return
    try:
        os.makedirs(os.path.dirname(STATS_LOG), exist_ok=True)
        with open(STATS_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "session_id": event.get("session_id"),
                "trigger": event.get("trigger"),
                "blocks": total, "judged": judged, "kept": kept,
                "chars_before": before, "chars_after": after, "ms": ms,
            }) + "\n")
    except OSError:
        pass


def precompact(event: dict) -> None:
    blocks = transcript_blocks(event.get("transcript_path") or "")
    if not blocks:
        return
    judged = blocks[-MAX_BLOCKS:]
    offset = len(blocks) - len(judged)
    state = compact_state(judged, event)
    t0 = time.monotonic()
    answers = ask_chunked(state, len(judged))
    ms = int((time.monotonic() - t0) * 1000)
    kept = []
    for i in range(len(judged)):
        noul = (answers.get(f"keep_{i}") or {}).get("noul")
        if noul is None or noul >= KEEP_THRESHOLD:  # missing answer: keep, don't lose context
            kept.append(offset + i)
    if not kept:
        return
    write_digest(event, blocks, kept)
    log_stats(event, len(blocks), len(judged), len(kept),
              sum(len(b["text"]) for b in blocks),
              sum(len(blocks[i]["text"]) for i in kept), ms)


def sessionstart(event: dict) -> None:
    if event.get("source") != "compact":
        return
    path = digest_path(event.get("session_id", ""))
    try:
        if time.time() - os.path.getmtime(path) > DIGEST_TTL:
            return
        with open(path, encoding="utf-8") as f:
            digest = f.read().strip()
    except OSError:
        return
    try:
        os.remove(path)
    except OSError:
        pass
    if not digest:
        return
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": digest,
        }
    }, sys.stdout)
    sys.stdout.write("\n")


def sweep_old_digests() -> None:
    try:
        for name in os.listdir(DIGEST_DIR):
            p = os.path.join(DIGEST_DIR, name)
            try:
                if time.time() - os.path.getmtime(p) > 86400:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


def main() -> None:
    try:
        if os.environ.get("JEV_OFF"):
            return
        event = json.load(sys.stdin)
        name = event.get("hook_event_name")
        if name == "PreCompact":
            sweep_old_digests()
            precompact(event)
        elif name == "SessionStart":
            sessionstart(event)
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
