#!/usr/bin/env python3
"""Jev-powered context compaction: Jev decides which transcript blocks still
matter, and only those survive — no LLM summary in the loop.

Two surfaces:

  prepare            CLI for the /jev:compact command: judge the current
                     session's transcript, write the kept blocks verbatim to a
                     digest file, and print a one-line plan. The user then runs
                     /clear and the compacted context is all that remains —
                     this is the path that replaces summarization entirely.

  SessionStart hook  matcher "compact": after Claude Code's built-in
                     compaction, re-inject Jev's kept blocks on top of the
                     generated summary. Matcher "clear": if a fresh digest from
                     `prepare` is waiting, inject it as the new session's
                     context and delete it. SessionStart is the only
                     post-compaction event that can inject context
                     (PreCompact/PostCompact output is discarded).

Hook mode always exits 0 and prints nothing on any failure — a hook must
never block or corrupt a session. `prepare` prints errors for the user.

Env:
  TYPESAFE_API_KEY   required (hook disables silently without it)
"""

from __future__ import annotations

import concurrent.futures
import datetime
import glob
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

KEEP_THRESHOLD = 0.5    # noul floor to keep a block
MAX_BLOCKS = 45         # oldest blocks beyond the cap are dropped unjudged
PIN_TAIL = 4            # newest blocks always kept verbatim — the live working context
CHUNK = 20              # questions per API call; chunks run in parallel
BLOCK_CHARS = 1200      # chars of each block shown to Jev
KEEP_CHARS = 1500       # chars of each kept block in the digest
HEAD_CHARS = 400        # head retained on a truncated block
TARGET_CHARS = 40000    # hard cap on digest size — the kept set can never grow without bound
MIN_REDUCTION = 0.25    # required size reduction; compaction busts the prompt cache,
                        # so a weak selection must not ship
DIGEST_DIR = os.path.expanduser("~/.claude/jev-compact")
STATS_LOG = os.path.expanduser("~/.claude/jev-compact-log.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")
TAIL_LINES = 5000  # transcript read window; a bound, not a target
DIGEST_TTL = 600   # a pending digest is applied only to the /clear it was made for

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


def visible_text(d: dict) -> str | None:
    """The judge-visible text of one transcript line, or None. Sidechains,
    non-message lines, meta wrappers, and trivial acks are invisible."""
    if d.get("isSidechain") or d.get("type") not in ("user", "assistant"):
        return None
    msg = d.get("message") or {}
    role = msg.get("role") or d["type"]
    text = block_text(msg.get("content")).strip()
    if not text or text.startswith(META_PREFIXES):
        return None
    if role == "user" and re.fullmatch(r"(ok|yes|no|thanks|continue)\.?", text, re.I):
        return None
    return text


def transcript_blocks(transcript_path: str) -> list[dict]:
    """User/assistant turns as labeled blocks, oldest first. Sidechains,
    compact boundaries, summaries, meta lines, and trivial acks are filtered
    locally before Jev sees anything."""
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
        text = visible_text(d)
        if text is None:
            continue
        msg = d.get("message") or {}
        blocks.append({"role": msg.get("role") or d["type"], "text": text})
    return blocks


def compact_state(blocks: list[dict], cwd: str | None) -> str:
    header = [
        "Transcript of an AI coding-assistant session being compacted.",
        "Blocks are numbered [0]..[N], oldest first.",
    ]
    if cwd:
        header.append(f"Working directory: {cwd}")
    goal = "\n".join(b["text"][:300] for b in blocks if b["role"] == "user")[-1500:]
    if goal.strip():
        header.append(f"Most recent user requests:\n{goal}")
    body = "\n\n".join(f"[{i}] [{b['role']}] {b['text'][:BLOCK_CHARS]}"
                       for i, b in enumerate(blocks))
    return "\n".join(header) + "\n\n" + body


def keep_questions(n: int) -> dict:
    """Two judgments per block: whether it is still needed at all, and
    whether it is needed verbatim — a `no` on the second means a truncated
    head plus a pointer suffices, which is where most of the bulk is."""
    questions = {}
    for i in range(n):
        questions[f"keep_{i}"] = {
            "type": "noul",
            "instructions": f"If this session's history were compacted, would block [{i}] "
                            "(marked [{i}] in the state) still be needed to continue the work — "
                            "a decision, constraint, file path, error cause, or open task the "
                            "agent would otherwise lose? Answer yes only for lasting information "
                            "value, not for politeness or because it is recent.",
        }
        questions[f"full_{i}"] = {
            "type": "noul",
            "instructions": f"Does the agent need block [{i}] in full, verbatim? Answer no if "
                            "knowing the block happened plus its opening lines is enough — e.g. "
                            "a file read or command whose output the agent could re-run, versus "
                            "an exact error message or constraint it could not reconstruct.",
        }
    return questions


def ask_chunked(state: str, n: int) -> dict:
    """One batched ask per CHUNK questions, chunks in parallel — each chunk's
    questions score in one request, so wall time stays ~1 round trip."""
    questions = keep_questions(n)
    keys = list(questions)
    chunks = [dict((k, questions[k]) for k in keys[i:i + CHUNK])
              for i in range(0, len(keys), CHUNK)]
    if len(chunks) == 1:
        return jev.ask(state, chunks[0])
    answers: dict = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chunks)) as ex:
        for part in ex.map(lambda q: jev.ask(state, q), chunks):
            answers.update(part)
    return answers


def cut_text(text: str, chars: int) -> str:
    """Cap at chars, preferring a paragraph break near the limit so kept
    blocks don't end mid-word."""
    if len(text) <= chars:
        return text
    cut = text.rfind("\n\n", chars // 2, chars)
    return text[:cut] if cut > 0 else text[:chars]


def truncate_block(text: str) -> str:
    """Head of a kept block plus a pointer, instead of its full text — the
    block is visibly still there and the agent can re-read or re-run it."""
    text = cut_text(text, KEEP_CHARS)
    if len(text) <= HEAD_CHARS + 200:
        return text
    head = cut_text(text, HEAD_CHARS)
    return (f"{head}\n[… {len(text) - len(head)} chars elided by "
            "jev-compact — re-read the file or re-run the command if needed]")


def fit_kept(kept: list[dict]) -> list[dict]:
    """Hard cap on the digest so the kept set can't grow without bound over
    a long session. No extra Jev calls: downgrade the lowest-confidence full
    keeps to truncated heads first, then drop the weakest truncated blocks
    oldest-first. Pinned tail blocks are exempt — that is the live context."""
    total = sum(len(k["text"]) for k in kept)
    if total <= TARGET_CHARS:
        return kept
    downgradable = sorted(
        (k for k in kept if k["kind"] == "full"),
        key=lambda k: k["full"],
    )
    for k in downgradable:
        if total <= TARGET_CHARS:
            break
        shorter = truncate_block(k["text"])
        total -= len(k["text"]) - len(shorter)
        k["text"], k["kind"] = shorter, "truncated"
        k["escalated"] = True
    droppable = sorted(
        (k for k in kept if k["kind"] == "truncated"),
        key=lambda k: k["keep"],
    )
    for k in droppable:
        if total <= TARGET_CHARS:
            break
        total -= len(k["text"])
        k["kind"] = "dropped"
        k["escalated"] = True
    return [k for k in kept if k["kind"] != "dropped"]


def judge(transcript_path: str, cwd: str | None) -> tuple[list[str], dict]:
    """The whole selection pass: transcript -> Jev keep/truncate/drop ->
    digest entries. The newest PIN_TAIL blocks are never judged."""
    blocks = transcript_blocks(transcript_path)[-MAX_BLOCKS:]
    if not blocks:
        return [], {"judged": 0}
    n_judged = max(0, len(blocks) - PIN_TAIL)
    t0 = time.monotonic()
    answers = ask_chunked(compact_state(blocks, cwd), n_judged) if n_judged else {}
    ms = int((time.monotonic() - t0) * 1000)
    kept: list[dict] = []
    for i, b in enumerate(blocks):
        text = cut_text(b["text"], KEEP_CHARS)
        if i >= n_judged:  # pinned tail — kept verbatim, unjudged
            kept.append({"i": i, "text": text, "kind": "full", "keep": 1.0, "full": 1.0})
            continue
        keep = (answers.get(f"keep_{i}") or {}).get("noul")
        full = (answers.get(f"full_{i}") or {}).get("noul")
        if keep is None or keep >= KEEP_THRESHOLD:
            # unscored blocks stay whole — dropping by mistake is the costly failure
            kind = "truncated" if keep is not None and full is not None \
                and full < KEEP_THRESHOLD else "full"
            kept.append({
                "i": i,
                "text": text if kind == "full" else truncate_block(text),
                "kind": kind,
                "keep": keep if keep is not None else 1.0,
                "full": full if full is not None else 1.0,
            })
    # A kept tool_result without its tool_use is an orphan — pull the call in
    # at the result's own confidence, or the digest loses the thread.
    kept_idx = {k["i"] for k in kept}
    paired: list[dict] = []
    for k in kept:
        i = k["i"]
        if (k["text"].startswith("[tool_result]") and i > 0
                and i - 1 not in kept_idx
                and blocks[i - 1]["text"].startswith("[tool_use")):
            paired.append({"i": i - 1, "text": cut_text(blocks[i - 1]["text"], KEEP_CHARS),
                           "kind": "full", "keep": k["keep"], "full": k["full"]})
            kept_idx.add(i - 1)
        paired.append(k)
    kept = fit_kept(paired)
    stats = {"judged": n_judged, "pinned": len(blocks) - n_judged,
             "kept": len(kept),
             "truncated": sum(1 for k in kept if k["kind"] == "truncated"),
             "escalated": sum(1 for k in kept if k.get("escalated")),
             "chars_before": sum(len(b["text"]) for b in blocks),
             "chars_after": sum(len(k["text"]) for k in kept), "ms": ms}
    stats["est_tokens_before"] = stats["chars_before"] // 4
    stats["est_tokens_after"] = stats["chars_after"] // 4
    stats["reduction"] = round(
        1 - stats["chars_after"] / max(stats["chars_before"], 1), 3)
    return [k["text"] for k in kept], stats


def log_stats(event: dict, stats: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATS_LOG), exist_ok=True)
        with open(STATS_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "session_id": event.get("session_id"),
                "source": event.get("source") or event.get("hook_event_name") or "prepare",
                **stats,
            }) + "\n")
    except OSError:
        pass


def digest_path(cwd: str) -> str:
    # Keyed by cwd, not session id — /clear hands the digest to a new session.
    return os.path.join(DIGEST_DIR, hashlib.sha1(cwd.encode()).hexdigest()[:16] + ".md")


def latest_transcript(cwd: str) -> str | None:
    """The active session's transcript: newest .jsonl in this project's dir,
    falling back to newest anywhere (the prompt that invoked us was just
    logged, so current is almost always newest)."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    candidates = glob.glob(os.path.join(PROJECTS, slug, "*.jsonl")) \
        or glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))
    return max(candidates, key=os.path.getmtime) if candidates else None


def prepare(cwd: str, transcript_path: str | None) -> int:
    transcript_path = transcript_path or latest_transcript(cwd)
    if not transcript_path:
        print("jev-compact: no transcript found", file=sys.stderr)
        return 2
    kept, stats = judge(transcript_path, cwd)
    if not kept:
        # kept is empty only when the transcript yielded no usable blocks —
        # there is nothing to select from, not a selection to apply.
        print("jev-compact: nothing to compact — no usable blocks in the transcript")
        return 0
    if stats.get("reduction", 0) < MIN_REDUCTION:
        # Compaction replaces the prompt prefix — every later request re-reads
        # the digest uncached. A weak selection does not pay for that.
        log_stats({"session_id": os.path.basename(transcript_path)},
                  {**stats, "gated": True})
        print(f"jev-compact: only {stats['reduction']:.0%} smaller — not worth "
              "rebuilding the context uncached. Skipping; let the session "
              "continue, or use the built-in /compact.")
        return 0
    os.makedirs(DIGEST_DIR, exist_ok=True)
    with open(digest_path(cwd), "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(kept))
    log_stats({"session_id": os.path.basename(transcript_path)}, stats)
    trunc = f", {stats['truncated']} truncated" if stats.get("truncated") else ""
    print(f"jev-compact: kept {stats['kept']}/{stats['judged'] + stats.get('pinned', 0)} blocks"
          f"{trunc} ({stats['reduction']:.0%} smaller, ~{stats['est_tokens_after']} "
          f"uncached tokens, {stats['ms']}ms). Run /clear to apply — "
          f"the kept context is injected on session start.")
    return 0


def emit_context(text: str) -> None:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    }, sys.stdout)
    sys.stdout.write("\n")


def sweep_old_digests() -> None:
    try:
        for name in os.listdir(DIGEST_DIR):
            p = os.path.join(DIGEST_DIR, name)
            try:
                if time.time() - os.path.getmtime(p) > DIGEST_TTL:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


def hook(event: dict) -> None:
    source = event.get("source")
    if source == "clear":
        sweep_old_digests()
        path = digest_path(event.get("cwd") or "")
        try:
            if time.time() - os.path.getmtime(path) > DIGEST_TTL:
                return
            with open(path, encoding="utf-8") as f:
                digest = f.read().strip()
            os.remove(path)
        except OSError:
            return
        if digest:
            emit_context("This session continues work whose history Jev compacted "
                         "— every block below was judged still needed and kept "
                         "verbatim; the rest was dropped entirely.\n\n"
                         "# Jev-compacted context\n\n" + digest)
    elif source == "compact":
        kept, stats = judge(event.get("transcript_path") or "", event.get("cwd"))
        weak = stats.get("reduction", 0) < MIN_REDUCTION
        log_stats(event, {**stats, "gated": weak})
        if kept and not weak:
            # The built-in summary already busted the cache for this turn;
            # only append Jev's selection when it earned the extra tokens.
            emit_context("# Context Jev kept from before compaction\n\n"
                         + "\n\n---\n\n".join(kept))


def main() -> int:
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "prepare":
            tp = sys.argv[2] if len(sys.argv) > 2 else None
            return prepare(os.getcwd(), tp)
        event = json.load(sys.stdin)
        if event.get("hook_event_name") == "SessionStart":
            hook(event)
    except jev.JevError as e:
        if len(sys.argv) > 1:  # prepare: tell the user; hook: stay silent
            print(f"jev-compact: {e}", file=sys.stderr)
            return 2
    except Exception:
        if len(sys.argv) > 1:
            raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
