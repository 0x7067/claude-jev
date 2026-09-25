#!/usr/bin/env python3
"""Sweep KEEP_THRESHOLD against a derived keep label.

No hand keep/drop labels exist, so the label is behavioral: a pre-boundary
block is `needed` when the session, after the boundary, re-fetched an
artifact (file, grep, glob, url) whose path or basename appears in that
block. Same events and re-fetch definition as `compare.py compact`; this
replays them through `compactor.select_blocks` to get every block's keep
and full score, caches the rows, and prints precision/recall per threshold,
overall and by role and kind.

  python3 eval/sweep.py --synth 60
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
import random
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import compactor
import compare

SWEEP_CACHE = os.path.join(compare.DATA, "sweep_cache.jsonl")
THRESHOLDS = [round(0.05 * i, 2) for i in range(2, 19)]


def events(synth: int, seed: int) -> list[tuple]:
    files = sorted(
        f
        for f in (os.path.join(dp, fn) for dp, _dn, fns in os.walk(compare.PROJECTS) for fn in fns)
        if f.endswith(".jsonl")
    )
    real, cands = [], []
    for fp in files:
        try:
            with open(fp, errors="replace") as f:
                lines = f.readlines()
        except OSError:
            continue
        evs = compare.boundaries(lines)
        if evs:
            prev = -1
            for n, ev in enumerate(evs):
                end = evs[n + 1]["i"] if n + 1 < len(evs) else len(lines)
                real.append((fp, lines, ev["i"], end, prev, "real"))
                prev = ev["i"]
        else:
            cut = compare.synth_cut(lines)
            if cut is not None:
                cands.append((fp, lines, cut, len(lines), -1, "synth"))
    if synth and len(cands) > synth:
        random.Random(seed).shuffle(cands)
        cands = cands[:synth]
    return real + (cands if synth else [])


def score_event(fp, lines, i, end, prev_i, kind, cache: dict, cache_f) -> dict | None:
    pre_lines = lines[:i]
    key = hashlib.sha256("".join(pre_lines).encode()).hexdigest()
    sig = compare.selection_sig()
    if (key, sig) in cache:
        return cache[(key, sig)]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as tf:
        tf.writelines(pre_lines)
        tmp = tf.name
    try:
        blocks = compactor.transcript_blocks(tmp)[-compactor.MAX_BLOCKS :]
    finally:
        os.unlink(tmp)
    if len(blocks) <= compactor.PIN_TAIL:
        return None
    try:
        _kept, stats = compactor.select_blocks(blocks, None)
    except compactor.jev.JevError as e:
        print(f"  jev failed on {os.path.basename(fp)}: {e}", file=sys.stderr)
        return None
    pre = compare.tool_calls(lines, prev_i + 1, i)
    post = compare.tool_calls(lines, i + (1 if kind == "real" else 0), end)
    reads = set(compare.refetches(pre, post))
    post_keys = {c["key"] for c in post if c["key"].split(":", 1)[0] in compare.REFETCH_KINDS}
    rows = []
    for r, b in zip(stats["rows"], blocks):
        rows.append(
            {
                **r,
                "ref": None,
                "needed": any(compare.covered(k, b["text"]) for k in reads),
                "needed_post": any(compare.covered(k, b["text"]) for k in post_keys),
            }
        )
    d = {
        "key": key,
        "sig": sig,
        "file": os.path.basename(fp),
        "kind": kind,
        "n_reads": len(reads),
        "rows": rows,
    }
    cache[(key, sig)] = d
    cache_f.write(json.dumps(d) + "\n")
    cache_f.flush()
    return d


def load_cache() -> dict:
    out = {}
    if os.path.exists(SWEEP_CACHE):
        for line in open(SWEEP_CACHE):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            out[(d["key"], d["sig"])] = d
    return out


def prf(rows: list[dict], t: float, label: str) -> tuple[int, int, int, float, float, float]:
    tp = sum(1 for r in rows if r["keep"] >= t and r[label])
    fp = sum(1 for r in rows if r["keep"] >= t and not r[label])
    fn = sum(1 for r in rows if r["keep"] < t and r[label])
    p = tp / (tp + fp) if tp + fp else 0.0
    rc = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * rc / (p + rc) if p + rc else 0.0
    return tp, fp, fn, p, rc, f1


def table(rows: list[dict], label: str, title: str) -> None:
    pos = sum(1 for r in rows if r[label])
    print(
        f"\n{title}: {len(rows)} judged blocks, {pos} {label} ({100 * pos / max(len(rows), 1):.0f}%)"
    )
    print(f"  {'t':>5} {'kept%':>6} {'chars%':>7} {'prec':>6} {'recall':>7} {'F1':>6}")
    total_chars = sum(r["chars"] for r in rows) or 1
    for t in THRESHOLDS:
        tp, fp, fn, p, rc, f1 = prf(rows, t, label)
        kept = [r for r in rows if r["keep"] >= t]
        print(
            f"  {t:>5.2f} {100 * len(kept) / len(rows):>5.0f}% {100 * sum(r['chars'] for r in kept) / total_chars:>6.0f}% "
            f"{p:>6.2f} {rc:>7.2f} {f1:>6.2f}{'  <- current' if t == compactor.KEEP_THRESHOLD else ''}"
        )


def auc(rows: list[dict], score, label: str) -> float:
    """Probability a needed block outscores an unneeded one; 0.5 is chance."""
    import bisect

    pos = [score(r) for r in rows if r[label]]
    neg = sorted(score(r) for r in rows if not r[label])
    if not pos or not neg:
        return float("nan")
    s = sum(
        bisect.bisect_left(neg, p)
        + 0.5 * (bisect.bisect_right(neg, p) - bisect.bisect_left(neg, p))
        for p in pos
    )
    return s / (len(pos) * len(neg))


def auc_table(rows: list[dict], label: str) -> None:
    kinds = ("text", "tool_use", "tool_result")
    names = ["keep", "full"] + sorted({c for r in rows for c in (r.get("checks") or {})})
    print(f"\nAUC vs {label} (all / {' / '.join(kinds)}):")
    for name in names:
        score = (
            (lambda r, n=name: r[n])
            if name in ("keep", "full")
            else (lambda r, n=name: (r.get("checks") or {}).get(n, 0.0))
        )
        cells = [auc(rows, score, label)] + [
            auc([r for r in rows if r["kind"].split(":")[0] == k], score, label) for k in kinds
        ]
        print(f"  {name:11} " + "  ".join(f"{c:.3f}" for c in cells))


def histogram(rows: list[dict]) -> None:
    bins = collections.Counter(min(int(r["keep"] * 10), 9) for r in rows)
    n = len(rows)
    print(f"\nkeep score distribution ({n} blocks):")
    for b in range(10):
        c = bins.get(b, 0)
        print(f"  {b / 10:.1f}-{(b + 1) / 10:.1f} {c:5d} {'#' * int(60 * c / n)}")
    band = sum(1 for r in rows if 0.35 <= r["keep"] < 0.65)
    print(f"  in 0.35-0.65: {100 * band / n:.0f}%")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--label", default="needed", choices=["needed", "needed_post"])
    args = ap.parse_args()

    cache = load_cache()
    todo = events(args.synth, args.seed)
    print(
        f"{len(todo)} events ({sum(1 for t in todo if t[-1] == 'real')} real), "
        f"{sum(1 for t in todo if (hashlib.sha256(''.join(t[1][: t[2]]).encode()).hexdigest(), compare.selection_sig()) in cache)} cached"
    )
    results = []
    with (
        open(SWEEP_CACHE, "a") as cache_f,
        concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex,
    ):
        futs = [ex.submit(score_event, *t, cache, cache_f) for t in todo]
        for f in concurrent.futures.as_completed(futs):
            d = f.result()
            if d:
                results.append(d)

    rows = [r for d in results for r in d["rows"] if r["keep"] is not None]
    with_reads = [r for d in results if d["n_reads"] for r in d["rows"] if r["keep"] is not None]
    print(
        f"\n{len(results)} events scored, {sum(1 for d in results if d['n_reads'])} with post-boundary re-fetches"
    )
    histogram(rows)
    auc_table(with_reads, args.label)
    table(with_reads, args.label, "all roles (events with re-fetches)")
    for role in ("user", "assistant"):
        table([r for r in with_reads if r["role"] == role], args.label, f"role={role}")
    for kind in ("text", "tool_result"):
        table([r for r in with_reads if r["kind"] == kind], args.label, f"kind={kind}")
    tu = [r for r in with_reads if r["kind"].startswith("tool_use")]
    if tu:
        table(tu, args.label, "kind=tool_use")
    return 0


if __name__ == "__main__":
    sys.exit(main())
