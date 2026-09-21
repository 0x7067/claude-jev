#!/usr/bin/env python3
"""Jev-powered context compaction: Jev decides which transcript blocks still
matter, and only those survive — no LLM summary in the loop.

Three surfaces:

  rows               Stdin/stdout bridge for the hooks module in
                     hooks/register.ts. Claude Code's experimental function
                     hooks (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1) let a plugin
                     hook `session.compact` itself: the module hands the
                     conversation rows here, Jev judges them, and the rows it
                     keeps go back as the whole post-compaction context. The
                     built-in summarizer never runs. This is the path that
                     replaces summarization entirely.

  prepare            CLI for the /claude-jev:compact skill: judge the current
                     session's transcript, write the kept blocks verbatim to a
                     digest file, and print a one-line plan. The user then runs
                     /clear and the compacted context is all that remains —
                     this is the path that replaces summarization entirely.

  SessionStart hook  matcher "compact": after Claude Code's built-in
                     compaction, re-inject Jev's kept blocks on top of the
                     generated summary. Matcher "clear": if a fresh digest from
                     `prepare` is waiting, inject it as the new session's
                     context and delete it. SessionStart is the only classic
                     hook event that can inject context after compaction
                     (PreCompact/PostCompact output is discarded). When the
                     `rows` path replaced this compaction, the marker it left
                     tells this hook to stay silent.

Hook mode always exits 0 and prints nothing on any failure — a hook must
never block or corrupt a session. `prepare` prints errors for the user.

Env:
  TYPESAFE_API_KEY   required (hook disables silently without it)
"""

from __future__ import annotations

import concurrent.futures
import datetime
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402

KEEP_THRESHOLD = 0.5    # noul floor to keep a block
MAX_BLOCKS = 150        # oldest blocks beyond the cap are dropped unjudged.
                        # Sessions long enough to compact run to a median of
                        # 116 blocks, so 45 judged 39% of the median one. 150
                        # covers it whole and still fits one parallel wave.
PIN_TAIL = 4            # newest blocks always kept verbatim — the live working context
CHUNK = 20              # questions per API call; chunks run in parallel
BLOCKS_PER_CHUNK = CHUNK // 2   # two questions per block
HEADER_CHARS = 1500     # session goals, repeated in every chunk's state — the
                        # length compact_state already used for them, and the
                        # repetition is now the main per-request overhead
MAX_WORKERS = 16        # socket bound; a long session fans out in waves instead
BLOCK_CHARS = 1200      # chars of each block shown to Jev
KEEP_CHARS = 1500       # chars of each kept block in the digest
HEAD_CHARS = 400        # head retained on a truncated block
TARGET_CHARS = 8000     # hard cap on digest size. Sized against the default
                        # summarizer: 40k let a 150-block window inject ~5.4k
                        # tokens, losing to the ~2.4k default it replaces.
                        # A wider window is for choosing better, not keeping more.
MIN_REDUCTION = 0.25    # required size reduction; compaction busts the prompt cache,
                        # so a weak selection must not ship
DIGEST_DIR = os.path.expanduser("~/.claude/jev-compact")
STATS_LOG = os.path.expanduser("~/.claude/jev-compact-log.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")
TAIL_LINES = 5000  # transcript read window; a bound, not a target
DIGEST_TTL = 600   # a pending digest is applied only to the /clear it was made for
REPLACED_TTL = 120  # `rows` leaves a marker for the SessionStart compact hook that
                    # follows within seconds; older markers are from a crashed run
CONTEXT_CHARS = 9500  # additionalContext over 10,000 chars becomes a file path plus
                      # a 2,000-char preview (hooks reference, "Add context for
                      # Claude"); the digest must stay a digest
ROWS_HEADER = ("This session's history was compacted by Jev. Every message below "
               "was judged still needed and kept verbatim, or as a head with an "
               "elision note; everything else was dropped. Continue the last task "
               "without asking the user to repeat anything.")
# Fixed text, not generated: the first message must be a user turn, and the
# validator refuses an empty result. Same header the SessionStart path uses.

# Fallback only: the harness now flags its own injections (see `injected`),
# but transcripts written before it did have nothing but the tag to go on.
META_PREFIXES = ("<command-", "<local-command", "<system-reminder", "<caveat",
                 "<bash-", "<task-notification")
# promptSource values that mean a person drove this turn. Anything else on a
# user line is the harness speaking through the user channel.
SOURCE_OK = ("typed", "queued", "suggestion_accepted")


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


def injected(d: dict, strict_source: bool) -> bool:
    """True when Claude Code wrote this line rather than the user or the model.

    The harness marks its own writes so they stay out of the "the user said"
    channel: `isMeta` on skill bodies and command caveats, a non-human
    `promptSource` on task notifications and SDK turns. Keeping any of it in a
    digest is double-paying, because the harness re-injects it next session
    anyway. Reading the flag beats matching tags: a new kind of injected text
    arrives already flagged, while a prefix list has to learn each new tag.
    """
    if d.get("isMeta"):
        return True
    if strict_source and d.get("type") == "user":
        src = d.get("promptSource")
        if src is not None and src not in SOURCE_OK:
            return True
    return False


def compaction_marker(d: dict, text: str) -> bool:
    """The start of the turn that ran /claude-jev:compact.

    That turn is the skill body, the `prepare` call and its relay line — all
    of it about compacting, none of it about the work being compacted. It is
    also the newest thing in the transcript, so PIN_TAIL would otherwise
    guarantee it survives.
    """
    if d.get("isMeta") and text.startswith("Base directory for this skill:"):
        return text.split("\n", 1)[0].rstrip().rstrip("/").endswith("skills/compact")
    return text.startswith("<command-") and "claude-jev:compact" in text[:200]


def visible_text(d: dict, text: str | None = None,
                 strict_source: bool = False) -> str | None:
    """The judge-visible text of one transcript line, or None. Sidechains,
    non-message lines, harness injections, meta wrappers, and trivial acks are
    invisible. `text` is the already-flattened content, when the caller has it."""
    if d.get("isSidechain") or d.get("type") not in ("user", "assistant"):
        return None
    if injected(d, strict_source):
        return None
    msg = d.get("message") or {}
    role = msg.get("role") or d["type"]
    if text is None:
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
    parsed = []
    for line in lines:
        if len(line) > 2_000_000:
            continue
        try:
            parsed.append(json.loads(line))
        except ValueError:
            continue
    # An SDK-driven session has no `typed` line at all, and applying the
    # promptSource rule there would drop every user turn it has.
    strict_source = any(d.get("promptSource") == "typed" for d in parsed)
    blocks = []
    cut_at = None
    for d in parsed:
        msg = d.get("message") or {}
        raw = block_text(msg.get("content")).strip()
        if raw and compaction_marker(d, raw):
            cut_at = len(blocks)
            continue
        text = visible_text(d, raw, strict_source)
        if text is None:
            continue
        blocks.append({"role": msg.get("role") or d["type"], "text": text})
    return blocks if cut_at is None else blocks[:cut_at]


def compact_state(blocks: list[dict], cwd: str | None,
                  lo: int = 0, hi: int | None = None) -> str:
    """The state for one chunk: the session's goals, then only the blocks that
    chunk judges, labeled by their position in the whole transcript.

    The goals are repeated per chunk because the keep question needs them. The
    blocks are not: sending every block to every chunk makes each request grow
    with the session, so the total cost grows as blocks x chunks. Chunk-local
    bodies make it linear, which is what lets MAX_BLOCKS be 150.
    """
    hi = len(blocks) if hi is None else hi
    header = [
        "Transcript of an AI coding-assistant session being compacted.",
        f"Blocks are numbered by position in the session, oldest first. "
        f"This request shows blocks [{lo}]..[{hi - 1}].",
    ]
    if cwd:
        header.append(f"Working directory: {cwd}")
    goal = "\n".join(b["text"][:300] for b in blocks
                     if b["role"] == "user")[-HEADER_CHARS:]
    if goal.strip():
        header.append(f"Most recent user requests:\n{goal}")
    body = "\n\n".join(f"[{i}] [{blocks[i]['role']}] {blocks[i]['text'][:BLOCK_CHARS]}"
                       for i in range(lo, hi))
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


def ask_chunked(blocks: list[dict], cwd: str | None, n: int) -> dict:
    """Judge the first `n` blocks, one request per BLOCKS_PER_CHUNK of them.

    Each request carries only its own blocks, so wall time stays ~1 round trip
    and request size stays flat however long the session is.
    """
    questions = keep_questions(n)
    ranges = [(i, min(i + BLOCKS_PER_CHUNK, n))
              for i in range(0, n, BLOCKS_PER_CHUNK)]

    def one(r: tuple[int, int]) -> dict:
        lo, hi = r
        q = {k: questions[k] for i in range(lo, hi)
             for k in (f"keep_{i}", f"full_{i}")}
        # A chunk that fails scores nothing, and unscored blocks are kept —
        # `ex.map` re-raises on iteration, so without this a single timeout
        # would throw away the whole selection.
        try:
            return jev.ask(compact_state(blocks, cwd, lo, hi), q)
        except jev.JevError:
            return {}

    if len(ranges) == 1:
        answers = one(ranges[0])
    else:
        answers = {}
        with concurrent.futures.ThreadPoolExecutor(
                max_workers=min(len(ranges), MAX_WORKERS)) as ex:
            for part in ex.map(one, ranges):
                answers.update(part)
    if not answers:
        raise jev.JevError("every chunk failed")
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
    kept, stats = select_blocks(transcript_blocks(transcript_path)[-MAX_BLOCKS:], cwd)
    return [k["text"] for k in kept], stats


def select_blocks(blocks: list[dict], cwd: str | None) -> tuple[list[dict], dict]:
    """Jev keep/truncate/drop over labeled blocks. Each kept entry carries the
    block index `i`, its digest `text`, and `kind` (full or truncated), so the
    caller can hand back either the text or the row the block came from."""
    if not blocks:
        return [], {"judged": 0}
    n_judged = max(0, len(blocks) - PIN_TAIL)
    t0 = time.monotonic()
    answers = ask_chunked(blocks, cwd, n_judged) if n_judged else {}
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
    return kept, stats


def row_text(row: dict) -> str | None:
    """The judge-visible text of one `session.compact` row, or None.

    A row is one message as the hooks engine shows it: `role`, `text`,
    `toolUses` [{tool_use_id, tool, input}], `toolResults` [{tool_use_id,
    text, isError}], and a `handle`. Rendered the way `block_text` renders a
    transcript line, so the same questions and thresholds apply. Harness
    rows (slash-command wrappers, caveats) and one-word acks are invisible,
    as in `visible_text`; the engine already drops isMeta rows.
    """
    parts = []
    text = (row.get("text") or "").strip()
    if text:
        parts.append(text)
    for u in row.get("toolUses") or []:
        if isinstance(u, dict):
            parts.append(f"[tool_use {u.get('tool', '?')}] "
                         f"{json.dumps(u.get('input', {}))[:400]}")
    for r in row.get("toolResults") or []:
        if isinstance(r, dict):
            parts.append(f"[tool_result] {str(r.get('text') or '')[:800]}")
    text = "\n".join(parts).strip()
    if not text or text.startswith(META_PREFIXES):
        return None
    if row.get("role") == "user" and re.fullmatch(r"(ok|yes|no|thanks|continue)\.?", text, re.I):
        return None
    return text


def plain_row(row: dict) -> bool:
    """A row with no tool blocks. Only these pass through by handle: a kept
    tool_use whose tool_result was dropped (or the reverse) is an invalid
    message sequence, so tool rows come back as text instead."""
    return not row.get("toolUses") and not row.get("toolResults")


def rows_out(blocks: list[dict], kept: list[dict]) -> list[dict]:
    """Kept entries -> rows the engine accepts.

    An unchanged row (same object, same handle) is passed through: the
    engine restores the original message verbatim. Anything else is a text
    row with no handle, which the engine turns into a new message whose
    bytes are still the transcript's own, cut or with an elision note.
    """
    out = [{"role": "user", "text": ROWS_HEADER, "toolUses": [], "toolResults": []}]
    for k in kept:
        row = blocks[k["i"]]["row"]
        if (k["kind"] == "full" and plain_row(row)
                and len((row.get("text") or "")) <= KEEP_CHARS):
            out.append(row)
            continue
        out.append({"role": row.get("role") or "assistant", "text": k["text"],
                    "toolUses": [], "toolResults": []})
    return out


def replaced_marker(session_id: str) -> str:
    return os.path.join(DIGEST_DIR, re.sub(r"[^A-Za-z0-9-]", "_", session_id) + ".replaced")


def rows(stdin) -> int:
    """`session.compact` bridge: {trigger, cwd, session_id, messages} in,
    {messages} or {fallback} out. `fallback` tells the module to call
    next(e) so the built-in summary runs; nothing here ever leaves the
    conversation uncompacted."""
    try:
        event = json.load(stdin)
    except ValueError as e:
        print(json.dumps({"fallback": f"unreadable event: {e}"}))
        return 0
    if not isinstance(event, dict):
        print(json.dumps({"fallback": "event is not an object"}))
        return 0
    incoming = [r for r in event.get("messages") or [] if isinstance(r, dict)]
    blocks = []
    for r in incoming:
        text = row_text(r)
        if text is not None:
            blocks.append({"role": r.get("role") or "assistant", "text": text, "row": r})
    blocks = blocks[-MAX_BLOCKS:]
    if not blocks:
        print(json.dumps({"fallback": "no judgeable rows"}))
        return 0
    try:
        kept, stats = select_blocks(blocks, event.get("cwd"))
    except jev.JevError as e:
        print(json.dumps({"fallback": f"jev: {e}"}))
        return 0
    stats["rows_in"] = len(incoming)
    if stats.get("reduction", 0) < MIN_REDUCTION:
        log_stats({"session_id": event.get("session_id"), "source": "rows"},
                  {**stats, "gated": True})
        print(json.dumps({"fallback": f"only {stats['reduction']:.0%} smaller; "
                                      "letting the built-in summary run"}))
        return 0
    out = rows_out(blocks, kept)
    stats["rows_out"] = len(out)
    stats["passed_through"] = sum(1 for r in out if r.get("handle"))
    log_stats({"session_id": event.get("session_id"), "source": "rows"}, stats)
    sid = event.get("session_id")
    if sid:
        try:
            os.makedirs(DIGEST_DIR, exist_ok=True)
            with open(replaced_marker(sid), "w") as f:
                f.write(str(time.time()))
        except OSError:
            pass
    print(json.dumps({"messages": out, "stats": {
        "kept": stats["kept"], "truncated": stats["truncated"],
        "reduction": stats["reduction"], "ms": stats["ms"]}}))
    return 0


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
    """This session's transcript, or None.

    Claude Code exports CLAUDE_CODE_SESSION_ID into the tool environment and
    names each transcript after it, so the exact file is one lookup. There is
    no guess-by-mtime fallback on purpose: a `claude -p` subprocess writes its
    own transcript into the same project directory and is often the newest
    file there, so guessing compacts the wrong conversation.
    """
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not sid:
        return None
    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    exact = os.path.join(PROJECTS, slug, f"{sid}.jsonl")
    return exact if os.path.exists(exact) else None


def prepare(cwd: str, transcript_path: str | None) -> int:
    transcript_path = transcript_path or latest_transcript(cwd)
    if not transcript_path:
        print("jev-compact: no transcript for CLAUDE_CODE_SESSION_ID in this "
              "directory — run it from the session you mean to compact",
              file=sys.stderr)
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
    if len(text) > CONTEXT_CHARS:
        text = cut_text(text, CONTEXT_CHARS - 80) + "\n[… digest cut at the context limit]"
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
        marker = replaced_marker(event.get("session_id") or "")
        try:
            fresh = time.time() - os.path.getmtime(marker) < REPLACED_TTL
            os.remove(marker)
            if fresh:
                return  # the hooks module already chose this context
        except OSError:
            pass
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
        if len(sys.argv) > 1 and sys.argv[1] == "rows":
            return rows(sys.stdin)
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
