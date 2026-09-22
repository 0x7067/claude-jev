#!/usr/bin/env python3
"""Jev-powered context compaction: Jev decides which conversation rows still
matter, and only those survive — no LLM summary in the loop.

Surface: `rows`, the stdin/stdout bridge behind `hooks/register.ts`. Claude
Code's function hooks (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1, 2.1.278+) let a
plugin hook `session.compact` itself. The module hands the conversation rows
here, Jev judges them, and the rows it keeps go back as the whole
post-compaction context. The built-in summarizer never runs.

Contract with the module: stdout is one JSON object, either {"messages":
[...], "summary": "<one line for the debug log>"} to replace the compaction
or {"fallback": "<reason>"} to let the built-in summary run. Bad input, a
missing key, or a Jev outage all answer with a fallback and
exit 0, so a failure here can never leave a session uncompacted. `judge` and
the transcript readers stay because `eval/compare.py` replays recorded
transcripts through them.

Env:
  TYPESAFE_API_KEY   required (the bridge falls back silently without it)
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
import jev

KEEP_THRESHOLD = 0.5
MAX_BLOCKS = 150

PIN_TAIL = 4
CHUNK = 20

BLOCKS_PER_CHUNK = CHUNK // 2
DIRECTIVE_CHARS = 500
HEADER_CHARS = 1500

MAX_WORKERS = 16
BLOCK_CHARS = 1200
KEEP_CHARS = 1500
HEAD_CHARS = 400
HEAD_SLACK = 200

TARGET_CHARS = 16000

STATS_LOG = os.path.expanduser("~/.claude/jev-compact-log.jsonl")
TAIL_LINES = 5000
ROWS_HEADER = ("This session's history was compacted by Jev. Every message below "
               "was judged still needed and kept verbatim, or as a head with an "
               "elision note; everything else was dropped. Continue the last task "
               "without asking the user to repeat anything.")

META_PREFIXES = ("<command-", "<local-command", "<system-reminder", "<caveat",
                 "<bash-", "<task-notification")

SOURCE_OK = ("typed", "queued", "suggestion_accepted")

ACK = re.compile(r"(ok|yes|no|thanks|continue)\.?", re.I)


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


def judgeable(role: str, text: str) -> str | None:
    """`text` if Jev should see it, else None: harness tags and one-word acks
    carry nothing worth a question. Shared by the transcript and row paths so
    the same rules gate both."""
    if not text or text.startswith(META_PREFIXES):
        return None
    if role == "user" and ACK.fullmatch(text):
        return None
    return text


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
    """The start of the turn that ran the `/claude-jev:compact` skill.

    Only recorded transcripts from before 0.10.0 have one; the eval replays
    those, and the turn is about compacting, not about the work being
    compacted. It is also the newest thing in such a transcript, so PIN_TAIL
    would otherwise guarantee it survives.
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
    return judgeable(role, text)


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


def session_context(blocks: list[dict], cwd: str | None,
                    directive: str | None) -> str:
    """The part of every chunk's state that does not depend on the chunk:
    working directory, the `/compact <text>` directive, and the session's
    goals. Built once per compaction; the keep question needs the goals, so
    every request carries them."""
    lines = []
    if cwd:
        lines.append(f"Working directory: {cwd}")
    if directive:
        lines.append(f"The user asked this compaction to: {directive}")
    goal = "\n".join(b["text"][:300] for b in blocks
                     if b["role"] == "user")[-HEADER_CHARS:]
    if goal.strip():
        lines.append(f"Most recent user requests:\n{goal}")
    return "\n".join(lines)


def compact_state(blocks: list[dict], lo: int, hi: int, context: str) -> str:
    """The state for one chunk: the shared context, then only the blocks that
    chunk judges, labeled by their position in the whole transcript.

    Sending every block to every chunk would make each request grow with the
    session, so the total cost grows as blocks x chunks. Chunk-local bodies
    make it linear, which is what lets MAX_BLOCKS be 150.
    """
    header = [
        "Transcript of an AI coding-assistant session being compacted.",
        f"Blocks are numbered by position in the session, oldest first. "
        f"This request shows blocks [{lo}]..[{hi - 1}].",
    ]
    if context:
        header.append(context)
    body = "\n\n".join(f"[{i}] [{blocks[i]['role']}] {blocks[i]['text'][:BLOCK_CHARS]}"
                       for i in range(lo, hi))
    return "\n".join(header) + "\n\n" + body


def keep_questions(n: int, directive: str | None = None) -> dict:
    """Two judgments per block: whether it is still needed at all, and
    whether it is needed verbatim — a `no` on the second means a truncated
    head plus a pointer suffices, which is where most of the bulk is.

    `/compact <text>` is named in the state, not repeated per question, and
    both judgments defer to it: what the user asked to keep outranks what
    the block would score on its own."""
    asked = (" The state names what the user asked this compaction to do; a "
             "block that request covers is needed, however old or routine."
             if directive else "")
    asked_full = (" If that request asks for this block's exact content, "
                  "answer yes." if directive else "")
    questions = {}
    for i in range(n):
        questions[f"keep_{i}"] = {
            "type": "noul",
            "instructions": f"If this session's history were compacted, would block [{i}] "
                            f"(marked [{i}] in the state) still be needed to continue the work — "
                            "a decision, constraint, file path, error cause, or open task the "
                            "agent would otherwise lose? Answer yes only for lasting information "
                            "value, not for politeness or because it is recent." + asked,
        }
        questions[f"full_{i}"] = {
            "type": "noul",
            "instructions": f"Does the agent need block [{i}] in full, verbatim? Answer no if "
                            "knowing the block happened plus its opening lines is enough — e.g. "
                            "a file read or command whose output the agent could re-run, versus "
                            "an exact error message or constraint it could not reconstruct."
                            + asked_full,
        }
    return questions


def ask_chunked(blocks: list[dict], cwd: str | None, n: int,
                directive: str | None = None) -> dict:
    """Judge the first `n` blocks, one request per BLOCKS_PER_CHUNK of them.

    Each request carries only its own blocks, so wall time stays ~1 round trip
    and request size stays flat however long the session is.
    """
    questions = keep_questions(n, directive)
    context = session_context(blocks, cwd, directive)
    ranges = [(i, min(i + BLOCKS_PER_CHUNK, n))
              for i in range(0, n, BLOCKS_PER_CHUNK)]

    def one(r: tuple[int, int]) -> dict:
        lo, hi = r
        q = {k: questions[k] for i in range(lo, hi)
             for k in (f"keep_{i}", f"full_{i}")}

        try:
            return jev.ask(compact_state(blocks, lo, hi, context), q)
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

ELISION = "[… {n} chars elided by jev-compact — re-read the file or re-run the command if needed]"


def cut_marked(text: str, chars: int) -> str:
    """Cap at `chars`, preferring a paragraph break near the limit so the
    kept part doesn't end mid-word, and say so when it cuts: a block that
    lost its tail silently would read as whole. The count is against the
    text passed in, so callers pass the original block, never an already
    cut one."""
    if len(text) <= chars:
        return text
    cut = text.rfind("\n\n", chars // 2, chars)
    head = text[:cut] if cut > 0 else text[:chars]
    return f"{head}\n" + ELISION.format(n=len(text) - len(head))


def truncate_block(text: str) -> str:
    """Head of a kept block plus a pointer, instead of its full text — the
    block is visibly still there and the agent can re-read or re-run it."""
    if len(text) <= HEAD_CHARS + HEAD_SLACK:
        return text
    return cut_marked(text, HEAD_CHARS)


def fit_kept(kept: list[dict], blocks: list[dict]) -> list[dict]:
    """Hard cap on the digest so the kept set can't grow without bound over
    a long session. No extra Jev calls: downgrade the lowest-confidence full
    keeps to truncated heads first, then drop the weakest remaining blocks,
    oldest-first on a tie. Pinned tail blocks are exempt — that is the live
    context."""
    total = sum(len(k["text"]) for k in kept)
    if total <= TARGET_CHARS:
        return kept
    movable = [k for k in kept if not k.get("pinned")]
    for k in sorted((k for k in movable if k["kind"] == "full"),
                    key=lambda k: k["full"]):
        if total <= TARGET_CHARS:
            break
        shorter = truncate_block(blocks[k["i"]]["text"])
        if len(shorter) >= len(k["text"]):
            continue
        total -= len(k["text"]) - len(shorter)
        k["text"], k["kind"] = shorter, "truncated"
        k["escalated"] = True

    for k in sorted(movable, key=lambda k: (k["keep"], k["i"])):
        if total <= TARGET_CHARS:
            break
        total -= len(k["text"])
        k["kind"] = "dropped"
    return [k for k in kept if k["kind"] != "dropped"]

REF_CHARS = 160


def block_kind(text: str) -> str:
    """The row's shape, from the marker `block_text` wrote: `tool_use:<Name>`,
    `tool_result`, or `text`. Only dropped or truncated tool rows can be
    re-fetched, so the kind is what makes the row list scorable."""
    if text.startswith("[tool_use"):
        end = text.find("]")
        name = text[len("[tool_use"):end].strip() if end > 0 else ""
        return f"tool_use:{name or '?'}"
    if text.startswith("[tool_result]"):
        return "tool_result"
    return "text"


def block_rows(blocks: list[dict], kept: list[dict], answers: dict,
               n_judged: int) -> list[dict]:
    """One record per input block: what Jev scored it and what became of it.

    Built after `fit_kept`, so a block the digest cap dropped or downgraded
    reads as dropped or truncated here, and a tool_use the orphan rule pulled
    back in reads as kept.
    """
    final = {k["i"]: k for k in kept}
    out = []
    for i, b in enumerate(blocks):
        k = final.get(i)
        if k is None:
            verdict = "dropped"
        elif k.get("pinned"):
            verdict = "pinned"
        else:
            verdict = k["kind"]
        keep = (answers.get(f"keep_{i}") or {}).get("noul") if i < n_judged else None
        full = (answers.get(f"full_{i}") or {}).get("noul") if i < n_judged else None
        out.append({
            "i": i,
            "role": b["role"],
            "kind": block_kind(b["text"]),
            "chars": len(b["text"]),
            "keep": keep,
            "full": full,
            "verdict": verdict,
            "ref": " ".join(b["text"].split())[:REF_CHARS],
        })
    return out


def judge(transcript_path: str, cwd: str | None) -> tuple[list[str], dict]:
    """The whole selection pass: transcript -> Jev keep/truncate/drop ->
    digest entries. The newest PIN_TAIL blocks are never judged."""
    kept, stats = select_blocks(transcript_blocks(transcript_path)[-MAX_BLOCKS:], cwd)
    return [k["text"] for k in kept], stats


def select_blocks(blocks: list[dict], cwd: str | None,
                  directive: str | None = None) -> tuple[list[dict], dict]:
    """Jev keep/truncate/drop over labeled blocks. Each kept entry carries the
    block index `i`, its digest `text`, and `kind` (full or truncated), so the
    caller can hand back either the text or the row the block came from."""
    if not blocks:
        return [], {"judged": 0}
    n_judged = max(0, len(blocks) - PIN_TAIL)
    t0 = time.monotonic()
    answers = ask_chunked(blocks, cwd, n_judged, directive) if n_judged else {}
    ms = int((time.monotonic() - t0) * 1000)
    kept: list[dict] = []
    for i, b in enumerate(blocks):
        if i >= n_judged:
            kept.append({"i": i, "text": cut_marked(b["text"], KEEP_CHARS),
                         "kind": "full", "pinned": True})
            continue
        keep = (answers.get(f"keep_{i}") or {}).get("noul")
        full = (answers.get(f"full_{i}") or {}).get("noul")
        if keep is None or keep >= KEEP_THRESHOLD:

            kind = "truncated" if keep is not None and full is not None\
                and full < KEEP_THRESHOLD else "full"
            kept.append({
                "i": i,
                "text": truncate_block(b["text"]) if kind == "truncated"
                else cut_marked(b["text"], KEEP_CHARS),
                "kind": kind,
                "keep": keep if keep is not None else 1.0,
                "full": full if full is not None else 1.0,
            })

    kept_idx = {k["i"] for k in kept}
    paired: list[dict] = []
    for k in kept:
        i = k["i"]
        if (k["text"].startswith("[tool_result]") and i > 0
                and i - 1 not in kept_idx
                and blocks[i - 1]["text"].startswith("[tool_use")):
            paired.append({"i": i - 1, "text": cut_marked(blocks[i - 1]["text"], KEEP_CHARS),
                           "kind": "full", "keep": k.get("keep", 1.0), "full": k.get("full", 1.0)})
            kept_idx.add(i - 1)
        paired.append(k)
    kept = fit_kept(paired, blocks)
    stats = {"judged": n_judged, "pinned": len(blocks) - n_judged,
             "kept": len(kept),
             "truncated": sum(1 for k in kept if k["kind"] == "truncated"),
             "escalated": sum(1 for k in kept if k.get("escalated")),
             "chars_before": sum(len(b["text"]) for b in blocks),
             "chars_after": sum(len(k["text"]) for k in kept), "ms": ms,
             "rows": block_rows(blocks, kept, answers, n_judged)}
    stats["est_tokens_after"] = stats["chars_after"] // 4
    stats["reduction"] = round(
        1 - stats["chars_after"] / max(stats["chars_before"], 1), 3)
    return kept, stats


def row_text(row: dict) -> str | None:
    """The judge-visible text of one `session.compact` row, or None.

    A row is one message as the hooks engine shows it: `role`, `text`,
    `toolUses` [{tool_use_id, tool, input}], `toolResults` [{tool_use_id,
    text, isError}], and a `handle`. It is rendered through `block_text`, so
    the same questions, thresholds, and `[tool_use`/`[tool_result]` markers
    apply as on a transcript line, and gated by `judgeable`, as a transcript
    line is; the engine already drops isMeta rows.
    """
    content = [{"type": "text", "text": row.get("text") or ""}]
    content += [{"type": "tool_use", "name": u.get("tool", "?"), "input": u.get("input", {})}
                for u in row.get("toolUses") or [] if isinstance(u, dict)]
    content += [{"type": "tool_result", "content": r.get("text")}
                for r in row.get("toolResults") or [] if isinstance(r, dict)]
    return judgeable(row.get("role"), block_text(content).strip())


def plain_row(row: dict) -> bool:
    """A row with no tool blocks. Only these pass through by handle: a kept
    tool_use whose tool_result was dropped (or the reverse) is an invalid
    message sequence, so tool rows come back as text instead."""
    return not row.get("toolUses") and not row.get("toolResults")


def text_row(role: str, text: str) -> dict:
    """A handle-less row: the engine turns it into a new message."""
    return {"role": role, "text": text, "toolUses": [], "toolResults": []}


def rows_out(blocks: list[dict], kept: list[dict]) -> list[dict]:
    """Kept entries -> rows the engine accepts.

    A plain row whose text survived untouched is passed through as the same
    object, handle and all, and the engine restores the original message
    verbatim. Anything else — a tool row, or a block that was cut — is a text
    row whose bytes are still the transcript's own, cut or with an elision
    note.
    """
    out = [text_row("user", ROWS_HEADER)]
    for k in kept:
        block = blocks[k["i"]]
        if plain_row(block["row"]) and k["text"] == block["text"]:
            out.append(block["row"])
        else:
            out.append(text_row(block["role"], k["text"]))
    return out


def fallback(reason: str) -> int:
    """Answer the module with a reason to call next(e). Always exit 0: a
    failure here must never look like one to the host."""
    print(json.dumps({"fallback": reason}))
    return 0


def log_stats(session_id: str | None, stats: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATS_LOG), exist_ok=True)
        with open(STATS_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "session_id": session_id,
                "source": "rows",
                **stats,
            }) + "\n")
    except OSError:
        pass


def rows(stdin) -> int:
    """`session.compact` bridge: {trigger, instructions, cwd, session_id,
    messages} in, {messages, summary} or {fallback} out. `fallback` tells the
    module to call next(e) so the built-in summary runs; nothing here ever
    leaves the conversation uncompacted."""
    try:
        event = json.load(stdin)
    except ValueError as e:
        return fallback(f"unreadable event: {e}")
    if not isinstance(event, dict):
        return fallback("event is not an object")

    directive = (event.get("instructions") or "").strip()[:DIRECTIVE_CHARS] or None
    incoming = [r for r in event.get("messages") or [] if isinstance(r, dict)]

    blocks = []
    for r in reversed(incoming):
        if len(blocks) == MAX_BLOCKS:
            break
        text = row_text(r)
        if text is not None:
            blocks.append({"role": r.get("role") or "assistant", "text": text, "row": r})
    blocks.reverse()
    if not blocks:
        return fallback("no judgeable rows")
    try:
        kept, stats = select_blocks(blocks, event.get("cwd"), directive)
    except jev.JevError as e:
        return fallback(f"jev: {e}")
    stats["trigger"] = event.get("trigger")
    stats["rows_in"] = len(incoming)
    out = rows_out(blocks, kept)
    stats["rows_out"] = len(out)
    stats["passed_through"] = sum(1 for r in out if r.get("handle"))
    log_stats(event.get("session_id"), stats)
    what = f"{stats['trigger']} compaction" if stats["trigger"] else "compaction"
    print(json.dumps({"messages": out, "summary": (
        f"{what} replaced by {len(out)} rows (kept {stats['kept']}, "
        f"{stats['truncated']} truncated, {stats['reduction']:.0%} smaller, "
        f"{stats['ms']} ms)")}))
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "rows":
        try:
            return rows(sys.stdin)
        except Exception as e:
            return fallback(f"compactor.py: {e}")
    print("usage: compactor.py rows  (reads a session.compact event on stdin)",
          file=sys.stderr)
    return 2

if __name__ == "__main__":
    sys.exit(main())
