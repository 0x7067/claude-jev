#!/usr/bin/env python3
"""Score the router's live decisions against what the sessions actually did.

Reads the decision log the hook writes, finds each prompt in its session
transcript, and compares the hint to the behavior that followed. This is the
only measurement that is not a replay: the eval harness asks "what would the
router have said", this asks "what did it say, and was it right".

Usage:
  python3 scripts/stats.py [--log PATH] [--days N] [--examples N]
"""

from __future__ import annotations

import argparse
import collections
import datetime
import functools
import glob
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev
import observed
import prompt_router

DEFAULT_LOG = os.path.join(jev.config_dir(), "jev-router-log.jsonl")
CALLS_LOG = os.path.join(jev.config_dir(), "jev-calls.jsonl")
COMPACT_LOG = os.path.join(jev.config_dir(), "jev-compact-log.jsonl")
PROJECTS = os.path.join(jev.config_dir(), "projects")
NEXT_TOOLS = 40

CMD_CHARS = 40


def load_log(path: str, days: int | None) -> list[dict]:
    if not os.path.exists(path):
        return []
    cutoff = None
    if days:
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    out = []
    with open(path, errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if cutoff:
                try:
                    if datetime.datetime.fromisoformat(d["ts"]) < cutoff:
                        continue
                except (KeyError, ValueError):
                    pass
            out.append(d)
    return out


@functools.cache
def transcripts() -> dict[str, str]:
    index = {}
    for path in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")):
        index.setdefault(os.path.basename(path)[: -len(".jsonl")], path)
    return index


def transcript_for(session_id: str) -> str | None:
    return transcripts().get(session_id)


def parse_ts(value) -> datetime.datetime | None:
    """A log or transcript timestamp as an aware datetime, or None. The two
    files are written by different programs, so one ends in Z and the other
    carries an offset."""
    if not isinstance(value, str):
        return None
    try:
        d = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def quantile(vals: list[float], q: float) -> float:
    s = sorted(vals)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def fmt_q(vals: list[float], q: float) -> str:
    return f"{quantile(vals, q):.0f}" if vals else "-"


_TOOLS_CACHE: dict[str, list[dict]] = {}


def tool_events(path: str) -> list[dict]:
    """Every tool call in a transcript with its timestamp, oldest first.

    `observed.walk_session` drops timestamps, and both the rule and compaction
    sections join on "what did the session do after this log line".
    """
    if path in _TOOLS_CACHE:
        return _TOOLS_CACHE[path]
    out: list[dict] = []
    try:
        with open(path, errors="replace") as f:
            for line in f:
                if len(line) > 500_000:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "assistant" or d.get("isSidechain"):
                    continue
                ts = parse_ts(d.get("timestamp"))
                for b in (d.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        out.append(
                            {"ts": ts, "name": b.get("name", "?"), "input": b.get("input") or {}}
                        )
    except OSError:
        out = []
    _TOOLS_CACHE[path] = out
    return out


def input_hash(inp: dict) -> str:
    """The same digest rules.py logs, so a later edit can be compared to the
    one that was blocked."""
    try:
        return hashlib.sha256(json.dumps(inp, sort_keys=True).encode()).hexdigest()[:16]
    except (TypeError, ValueError):
        return ""


def same_file(a, b) -> bool:
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return a == b or os.path.basename(a) == os.path.basename(b)


def touches_text(inp: dict, head: str) -> bool:
    """Does a later edit remove or rewrite the text a block cited? Matched
    on the first line of the added text, which survives re-indentation and
    partial rewrites better than the whole head does."""
    first = next((ln.strip() for ln in head.splitlines() if ln.strip()), "")
    if len(first) < 8:
        return False
    olds = [inp.get("old_string") or ""]
    olds += [
        (x or {}).get("old_string") or "" for x in inp.get("edits") or [] if isinstance(x, dict)
    ]
    return any(first in o for o in olds)


def rule_outcomes(entries: list[dict]) -> list[dict]:
    """What the session did to a file after a rule blocked an edit to it.

    `abandoned` means no later edit; `retried identical` means the same edit
    came back unchanged, which reads as a false positive the agent worked
    around; `repaired` means a later edit rewrote the blocked text; `ignored`
    means later edits to the file left it alone, which live has been the
    common case: the block lands after the write, so an agent that disagrees
    just says so and moves on. Entries logged before `blocked` existed are
    skipped, not counted as anything.
    """
    out = []
    for e in entries:
        if e.get("kind") != "rules" or e.get("phase") != "edit":
            continue
        blocked = e.get("blocked")
        if not isinstance(blocked, list) or not blocked:
            continue
        sid, target, ts = e.get("session_id"), e.get("file"), parse_ts(e.get("ts"))
        path = transcript_for(sid) if sid else None
        if not path or not target or ts is None:
            out.append({"rules": blocked, "outcome": "unscorable"})
            continue
        later = [
            t
            for t in tool_events(path)
            if t["name"] in observed.EDIT_TOOLS
            and t["ts"] is not None
            and t["ts"] > ts
            and same_file(t["input"].get("file_path"), target)
        ]
        head = (e.get("added_head") or "").strip()
        if not later:
            outcome = "abandoned"
        elif e.get("input_hash") and any(input_hash(t["input"]) == e["input_hash"] for t in later):
            outcome = "retried identical"
        elif head and any(touches_text(t["input"], head) for t in later):
            outcome = "repaired"
        elif head:
            outcome = "ignored"
        else:
            outcome = "repaired"
        out.append({"rules": blocked, "outcome": outcome})
    return out


def refetch_needles(path: str, after: datetime.datetime) -> list[str]:
    """File names and command heads from the tool calls right after a
    compaction — what the session went back for."""
    seen = [t for t in tool_events(path) if t["ts"] is not None and t["ts"] > after][:NEXT_TOOLS]
    needles = []
    for t in seen:
        inp = t["input"]
        if t["name"] == "Bash":
            cmd = " ".join((inp.get("command") or "").split())[:CMD_CHARS]
            if cmd:
                needles.append(cmd)
            continue
        arg = inp.get("file_path") or inp.get("pattern")
        if isinstance(arg, str) and arg:
            needles.append(os.path.basename(arg) or arg)
    return needles


def predicted_intent(entry: dict) -> tuple[str | None, bool]:
    """(intent, whether a hint was actually injected)."""
    hint = entry.get("hint")
    if hint:
        m = re.search(r"intent=(\w+)", hint)
        return (m.group(1) if m else None), True
    return ((entry.get("answers") or {}).get("intent") or {}).get("choice"), False


def match(entries: list[dict]) -> list[dict]:
    """Join each logged decision to the turn it preceded."""
    rows = []
    by_session = collections.defaultdict(list)
    for e in entries:
        by_session[e.get("session_id")].append(e)
    for sid, es in by_session.items():
        path = transcript_for(sid) if sid else None
        segs = observed.segments(path) if path else []
        for e in es:
            prefix = (e.get("prompt") or "").strip()
            if observed.is_synthetic(prefix):
                continue
            seg = (
                next((s for s in segs if s["text"].startswith(prefix[:120])), None)
                if prefix
                else None
            )
            intent, fired = predicted_intent(e)
            conf = ((e.get("answers") or {}).get("intent") or {}).get("confidence", 0.0)
            rows.append(
                {
                    "ts": e.get("ts"),
                    "prompt": prefix,
                    "intent": intent,
                    "fired": fired,
                    "conf": conf,
                    "matched": seg is not None,
                    "observed": seg["label"] if seg else None,
                    "n_tools": seg["n_tools"] if seg else None,
                }
            )
    return rows


def print_calls(days: int | None) -> None:
    """Latency and failures per hook, from the client's own call log."""
    calls = [c for c in load_log(CALLS_LOG, days) if isinstance(c.get("ms"), int)]
    print(f"\nJev calls ({len(calls)} logged at {CALLS_LOG}):")
    if not calls:
        print("  no calls logged yet — the log starts with the next hook run.")
        return
    per = collections.defaultdict(list)
    for c in calls:
        per[c.get("caller") or "?"].append(c)
    print(
        f"  {'caller':<16}{'calls':>7}{'median ms':>11}{'p95 ms':>9}{'errors':>8}{'median qs':>11}"
    )
    for caller, cs in sorted(per.items()):
        ms = [c["ms"] for c in cs]
        qs = [c.get("n_questions") for c in cs if isinstance(c.get("n_questions"), int)]
        errs = sum(1 for c in cs if not c.get("ok", True))
        print(
            f"  {caller:<16}{len(cs):>7}{fmt_q(ms, 0.5):>11}{fmt_q(ms, 0.95):>9}"
            f"{errs:>8}{fmt_q(qs, 0.5):>11}"
        )
    print("  Failures by caller (counts are failed calls, not HTTP status codes):")
    for caller, cs in sorted(per.items()):
        ordered = sorted(cs, key=lambda c: c.get("ts", ""))
        bad = [c for c in ordered if not c.get("ok", True)]
        recent = ordered[-20:]
        failures = sum(not c.get("ok", True) for c in recent)
        print(
            f"    {caller}: latest {ordered[-1].get('ts')}; "
            f"last {len(recent)} calls: {failures} failed"
        )
        categories = collections.Counter()
        for c in bad:
            error = str(c.get("error", "unknown"))
            status = re.match(r"HTTP (\d{3})\b", error)
            category = (
                status.group(0)
                if status
                else "timeout"
                if "timed out" in error.lower()
                else "other"
            )
            categories[category] += 1
        if bad:
            print("      " + ", ".join(f"{k}: {v}" for k, v in sorted(categories.items())))
            print(f"      last failure {bad[-1].get('ts')}: {str(bad[-1].get('error'))[:160]}")
            good = [c for c in ordered if c.get("ok", True)]
            print(f"      last success: {good[-1].get('ts') if good else 'none in window'}")
    print(
        "  Calls alone cannot measure coverage: disabled hooks and missing keys make no API call."
    )


def print_rule_outcomes(entries: list[dict]) -> None:
    """Whether a block led to a repair, and how often the same edit came back."""
    outcomes = rule_outcomes(entries)
    print("\nRule outcomes (what happened after an edit was blocked):")
    print(
        "  Heuristics, not verified fixes: repaired = flagged text touched; "
        "abandoned = no later edit to that file."
    )
    print("  Post-edit blocks do not undo writes. Outcomes exclude whole-turn blocks.")
    if not outcomes:
        print("  no blocked edits logged yet in this window.")
    else:
        totals = collections.Counter(o["outcome"] for o in outcomes)
        print(
            f"  {len(outcomes)} blocks: " + ", ".join(f"{k} {v}" for k, v in sorted(totals.items()))
        )
        if totals["unscorable"]:
            print(
                "  unscorable: no transcript for the session, as with a hand-fed "
                "test event, or no file path on the edit"
            )
        per_rule = collections.defaultdict(collections.Counter)
        for o in outcomes:
            for rid in o["rules"]:
                per_rule[str(rid)][o["outcome"]] += 1
        print(
            f"  {'rule':<34}{'repaired':>9}{'retried':>9}{'ignored':>9}"
            f"{'abandoned':>11}{'unscorable':>11}"
        )
        for rid, c in sorted(per_rule.items()):
            print(
                f"  {rid:<34}{c['repaired']:>9}{c['retried identical']:>9}"
                f"{c['ignored']:>9}{c['abandoned']:>11}{c['unscorable']:>11}"
            )
    flagged = collections.Counter()
    for e in entries:
        if e.get("kind") != "rules":
            continue
        for v in e.get("violations") or []:
            if isinstance(v, dict) and v.get("band") == "flag":
                flagged[str(v.get("rule"))] += 1
    if flagged:
        print("  flagged only (below the act threshold, never sent to the agent):")
        for rid, n in sorted(flagged.items()):
            print(f"    {rid:<34}{n:>5}")


def print_compaction(days: int | None) -> None:
    """Size and speed of each compaction, then whether the agent went back for
    what Jev dropped. This is the live form of the offline eval/compare.py."""
    events = load_log(COMPACT_LOG, days)
    print(f"\nCompaction ({len(events)} logged at {COMPACT_LOG}):")
    if not events:
        print("  no compactions logged yet.")
        return
    red = [e["reduction"] for e in events if isinstance(e.get("reduction"), (int, float))]
    ms = [e["ms"] for e in events if isinstance(e.get("ms"), (int, float))]
    trig = collections.Counter(e.get("trigger") or "?" for e in events)
    if red:
        print(f"  median reduction : {quantile(red, 0.5):.0%}")
    if ms:
        print(f"  median ms        : {quantile(ms, 0.5):.0f}")
    print(f"  triggers         : {dict(sorted(trig.items()))}")

    with_rows = [e for e in events if isinstance(e.get("rows"), list) and e["rows"]]
    if not with_rows:
        print("  no per-row records yet — those start with the next compaction.")
        return
    n_drop = n_trunc = hit_drop = hit_trunc = 0
    for e in with_rows:
        path = transcript_for(e.get("session_id")) if e.get("session_id") else None
        ts = parse_ts(e.get("ts"))
        needles = refetch_needles(path, ts) if path and ts else []
        for r in e["rows"]:
            if not isinstance(r, dict):
                continue
            verdict, ref = r.get("verdict"), r.get("ref") or ""
            if verdict not in ("dropped", "truncated"):
                continue
            back = any(n in ref for n in needles)
            if verdict == "dropped":
                n_drop += 1
                hit_drop += back
            else:
                n_trunc += 1
                hit_trunc += back
    print(
        f"  per-row records in {len(with_rows)} compactions "
        f"(next {NEXT_TOOLS} tool calls examined):"
    )
    for label, n, hit in (("dropped", n_drop, hit_drop), ("truncated", n_trunc, hit_trunc)):
        share = f"{100 * hit / n:.0f}%" if n else "-"
        print(f"    {label:<10}{n:>6} rows, re-fetched {hit:>4} ({share})")


def main() -> int:
    p = argparse.ArgumentParser(prog="jev-stats", description=__doc__.splitlines()[0])
    p.add_argument("--log", default=DEFAULT_LOG)
    p.add_argument("--days", type=int, help="only decisions from the last N days")
    p.add_argument("--examples", type=int, default=0, help="show N mismatches")
    args = p.parse_args()

    entries = load_log(args.log, args.days)
    if not entries:
        print(f"No decisions logged yet at {args.log}.")
        print("The hook writes one line per prompt. Use Claude Code for a while, then re-run.")
        return 0

    router_entries = [e for e in entries if not e.get("kind")]
    rows = match(router_entries)
    fired = [r for r in rows if r["fired"]]
    scored = [r for r in fired if r["matched"] and r["observed"]]
    span = f"{entries[0].get('ts', '?')[:10]} to {entries[-1].get('ts', '?')[:10]}"

    print(f"{len(entries)} decisions logged, {span}; {len(router_entries)} from the prompt router")
    skipped = sum(
        1 for e in router_entries if observed.is_synthetic((e.get("prompt") or "").strip())
    )
    if skipped:
        print(f"  not user prompts : {skipped} (Claude Code's own requests, skipped)")
    print(
        f"  hints injected : {len(fired)} ({100 * len(fired) / max(1, len(rows)):.0f}% of prompts)"
    )
    print(
        f"  suppressed     : {len(rows) - len(fired)} (an intent with no hint, or "
        f"below the confidence floor)"
    )

    unmatched = len(fired) - len(scored)
    if unmatched:
        print(
            f"  not scorable   : {unmatched} (session transcript not found, or the turn "
            f"is still open)"
        )
    counts = collections.Counter(r["observed"] for r in scored)
    pred = collections.Counter(r["intent"] for r in scored)
    if scored:
        ok = sum(1 for r in scored if r["intent"] == r["observed"])
        best = counts.most_common(1)[0]
        print(f"\nOf {len(scored)} scorable hints:")
        print(f"  agreed with what the session did : {ok} ({100 * ok / len(scored):.1f}%)")
        print(f"  always guessing '{best[0]}' would give : {100 * best[1] / len(scored):.1f}%")

        harmful = [r for r in scored if r["intent"] == "chat" and (r["n_tools"] or 0) >= 5]
        print(f"  said 'no tools', session used 5+  : {len(harmful)}")

        floor = prompt_router.MIN_CONFIDENCE
        floored = [
            r
            for r in rows
            if not r["fired"]
            and r["matched"]
            and r["conf"] < floor
            and r["intent"] in prompt_router.GUIDANCE
            and r["intent"] != "chat"
        ]
        if floored:
            right = sum(1 for r in floored if r["observed"] == r["intent"])
            print(
                f"\n  held back by the {floor} confidence floor: {len(floored)}, "
                f"of which {right} ({100 * right / len(floored):.1f}%) would have "
                f"been correct"
            )
    else:
        print("\nNothing scorable yet — come back after a few more sessions.")

    tiered = [e for e in entries if (e.get("answers") or {}).get("model_tier")]
    if tiered:
        dist = collections.Counter(
            ((e["answers"]["model_tier"] or {}).get("choice") or "?") for e in tiered
        )
        shown = sum(1 for e in tiered if e.get("tier_hint"))
        print("\nModel tier (cheapest tier Jev thinks each prompt needs):")
        print(f"  predicted: {dict(sorted(dist.items()))}   mismatch hints shown: {shown}")

    rule_rows = [
        e for e in entries if e.get("kind") == "rules" and isinstance(e.get("probs"), dict)
    ]
    if rule_rows:
        per_rule = collections.defaultdict(list)
        for e in rule_rows:
            for rid, p in e["probs"].items():
                if isinstance(p, (int, float)):
                    per_rule[rid].append(p)
        print(f"\nRule calibration ({len(rule_rows)} checks logged):")
        print(f"  {'rule':<34}{'checks':>7}{'median':>8}{'min':>6}{'max':>6}{'fired':>7}  verdict")
        for rid, ps in sorted(per_rule.items()):
            n = len(ps)
            ordered = sorted(ps)
            med = ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2
            fired_n = sum(1 for p in ps if p >= 0.80)

            if n < 5:
                verdict = "skipped (need 5)"
            elif fired_n / n >= 0.6:
                verdict = "noisy — fires on most edits; narrow it"
            elif max(ps) < 0.7 and med >= 0.25:
                verdict = "weak — sits in the middle; make it concrete"
            else:
                verdict = "decisive"
            print(
                f"  {rid:<34}{n:>7}{med:>8.2f}{min(ps):>6.2f}{max(ps):>6.2f}{fired_n:>7}  {verdict}"
            )

    if scored:
        width = max(8, max(len(c) for c in set(list(counts) + list(pred))))
        print(f"\n  {'intent':<{width + 2}}{'predicted':<12}{'observed':<10}")
        for c in sorted(set(list(pred) + list(counts))):
            print(f"  {c:<{width + 2}}{pred.get(c, 0):<12}{counts.get(c, 0):<10}")

    if args.examples:
        wrong = [r for r in scored if r["intent"] != r["observed"]][: args.examples]
        if wrong:
            print("\n  mismatches:")
            for r in wrong:
                print(
                    f"    said {r['intent']:<8} session did {r['observed']:<8} "
                    f"({r['n_tools']} tools)  {r['prompt'][:60]!r}"
                )

    print_calls(args.days)
    print_rule_outcomes(entries)
    print_compaction(args.days)
    return 0


if __name__ == "__main__":
    sys.exit(main())
