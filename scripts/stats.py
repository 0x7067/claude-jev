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
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observed  # noqa: E402

DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")


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


def transcript_for(session_id: str) -> str | None:
    hits = glob.glob(os.path.join(PROJECTS, "*", f"{session_id}.jsonl"))
    return hits[0] if hits else None


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
            seg = next((s for s in segs if s["text"].startswith(prefix[:120])), None) if prefix else None
            intent, fired = predicted_intent(e)
            rows.append({
                "ts": e.get("ts"), "prompt": prefix, "intent": intent, "fired": fired,
                "matched": seg is not None,
                "observed": seg["label"] if seg else None,
                "n_tools": seg["n_tools"] if seg else None,
            })
    return rows


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

    rows = match(entries)
    fired = [r for r in rows if r["fired"]]
    scored = [r for r in fired if r["matched"] and r["observed"]]
    span = f"{entries[0].get('ts','?')[:10]} to {entries[-1].get('ts','?')[:10]}"

    print(f"{len(entries)} decisions logged, {span}")
    print(f"  hints injected : {len(fired)} ({100*len(fired)/len(rows):.0f}% of prompts)")
    print(f"  suppressed     : {len(rows)-len(fired)} (below the confidence floor, or the "
          f"no-tools gate stayed shut)")

    unmatched = len(fired) - len(scored)
    if unmatched:
        print(f"  not scorable   : {unmatched} (session transcript not found, or the turn "
              f"is still open)")
    counts = collections.Counter(r["observed"] for r in scored)
    pred = collections.Counter(r["intent"] for r in scored)
    if scored:
        ok = sum(1 for r in scored if r["intent"] == r["observed"])
        best = counts.most_common(1)[0]
        print(f"\nOf {len(scored)} scorable hints:")
        print(f"  agreed with what the session did : {ok} ({100*ok/len(scored):.1f}%)")
        print(f"  always guessing '{best[0]}' would give : "
              f"{100*best[1]/len(scored):.1f}%")

        harmful = [r for r in scored
                   if r["intent"] == "chat" and (r["n_tools"] or 0) >= 5]
        print(f"  said 'no tools', session used 5+  : {len(harmful)}")

        quiet_missed = [r for r in rows
                        if not r["fired"] and r["matched"]
                        and r["observed"] == r["intent"]]
        if quiet_missed:
            print(f"\n{len(quiet_missed)} suppressed hints would have been "
                  f"correct — the floor may be too high.")
    else:
        print("\nNothing scorable yet — come back after a few more sessions.")

    tiered = [e for e in entries if (e.get("answers") or {}).get("model_tier")]
    if tiered:
        dist = collections.Counter(
            ((e["answers"]["model_tier"] or {}).get("choice") or "?") for e in tiered)
        shown = sum(1 for e in tiered if e.get("tier_hint"))
        print("\nModel tier (cheapest tier Jev thinks each prompt needs):")
        print(f"  predicted: {dict(sorted(dist.items()))}   mismatch hints shown: {shown}")

    rule_rows = [e for e in entries
                 if e.get("kind") == "rules" and isinstance(e.get("probs"), dict)]
    if rule_rows:
        per_rule = collections.defaultdict(list)
        for e in rule_rows:
            for rid, p in e["probs"].items():
                if isinstance(p, (int, float)):
                    per_rule[rid].append(p)
        print(f"\nRule calibration ({len(rule_rows)} checks logged):")
        print(f"  {'rule':<34}{'checks':>7}{'median':>8}{'min':>6}{'max':>6}"
              f"{'fired':>7}  verdict")
        for rid, ps in sorted(per_rule.items()):
            n = len(ps)
            ordered = sorted(ps)
            med = ordered[n // 2] if n % 2 else (ordered[n // 2 - 1]
                                                 + ordered[n // 2]) / 2
            fired_n = sum(1 for p in ps if p >= 0.80)
            # abide's calibration bands: <5 samples can't be judged; firing
            # on most hunks means too broad; never reaching the ends means
            # underspecified; decisive rules answer near 0 or near 1.
            if n < 5:
                verdict = "skipped (need 5)"
            elif fired_n / n >= 0.6:
                verdict = "noisy — fires on most edits; narrow it"
            elif max(ps) < 0.7 and med >= 0.25:
                verdict = "weak — sits in the middle; make it concrete"
            else:
                verdict = "decisive"
            print(f"  {rid:<34}{n:>7}{med:>8.2f}{min(ps):>6.2f}"
                  f"{max(ps):>6.2f}{fired_n:>7}  {verdict}")

    if scored:
        width = max(8, max(len(c) for c in set(list(counts) + list(pred))))
        print(f"\n  {'intent':<{width+2}}{'predicted':<12}{'observed':<10}")
        for c in sorted(set(list(pred) + list(counts))):
            print(f"  {c:<{width+2}}{pred.get(c,0):<12}{counts.get(c,0):<10}")

    if args.examples:
        wrong = [r for r in scored if r["intent"] != r["observed"]][: args.examples]
        if wrong:
            print("\n  mismatches:")
            for r in wrong:
                print(f"    said {r['intent']:<8} session did {r['observed']:<8} "
                      f"({r['n_tools']} tools)  {r['prompt'][:60]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
