#!/usr/bin/env python3
"""Replay past Claude Code sessions through the Jev router and score it.

Three stages, each a subcommand:

  extract   ~/.claude/projects/**/*.jsonl -> dataset.jsonl
            Each user prompt becomes a row. The label is derived from what
            the agent actually did next, not from a human annotation.
  run       dataset.jsonl -> predictions.jsonl (one Jev call per row, cached)
  report    join the two -> confusion matrix, threshold sweep, calibration

Labels are heuristic. They encode "what happened" as a stand-in for "what
should have happened", which is right often enough to tune a threshold and
wrong often enough that per-cell counts deserve a manual look before you
trust them.
"""

from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import jev  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import variants  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
DATASET = os.path.join(DATA, "dataset.jsonl")
PREDICTIONS = os.path.join(DATA, "predictions.jsonl")
CACHE = os.path.join(DATA, "cache.jsonl")

INTENTS = ["chat", "lookup", "fix", "feature", "refactor", "ops", "unclear"]

# --- stage 1: extract -------------------------------------------------------

from observed import (  # noqa: E402
    EDIT_TOOLS, READ_TOOLS, bash_kind, derive_label, is_synthetic,
    prompt_text, scope_band, segments, summarize, trace, walk_session,
)


def cmd_extract(args) -> int:
    files = glob.glob(os.path.expanduser(args.projects))
    os.makedirs(DATA, exist_ok=True)
    rows = 0
    with open(DATASET, "w") as out:
        for fp in files:
            try:
                turns = list(walk_session(fp))
            except Exception:
                continue
            cur = None
            idx = 0
            prev_user = prev_assistant = ""
            pending_text = ""

            def flush(cur, idx, prev_user, prev_assistant):
                s = summarize(cur["tools"])
                rec = {
                    "id": f"{os.path.basename(fp)[:8]}#{idx}",
                    "ts": cur["ts"],
                    "project": os.path.basename(os.path.dirname(fp)),
                    "prompt": cur["text"][:8000],
                    "n_chars": len(cur["text"]),
                    "turn_index": idx,
                    "is_followup": idx > 0,
                    "synthetic": is_synthetic(cur["text"]),
                    "prev_user": prev_user[:300],
                    "prev_assistant": prev_assistant[-600:],
                    "n_tools": len(cur["tools"]),
                    "tools": list(collections.Counter(t["name"] for t in cur["tools"]).items()),
                    "trace": trace(cur["tools"]),
                    "label": derive_label(cur["tools"], s),
                    "scope_actual": scope_band(len(cur["tools"])),
                    "needs_repo_actual": bool(s["n_edit"] or s["n_read"]),
                    **s,
                }
                out.write(json.dumps(rec) + "\n")

            for kind, payload in turns:
                if kind == "prompt":
                    if cur is not None:
                        flush(cur, idx, prev_user, prev_assistant)
                        rows += 1
                        prev_user = cur["text"]
                        prev_assistant = pending_text
                        idx += 1
                    cur = {"text": payload["text"], "ts": payload["ts"], "tools": []}
                    pending_text = ""
                elif cur is not None:
                    if kind == "tool":
                        cur["tools"].append(payload)
                    else:
                        pending_text = payload["text"]
            if cur is not None:
                flush(cur, idx, prev_user, prev_assistant)
                rows += 1
    print(f"extracted {rows} prompts from {len(files)} transcripts -> {DATASET}")
    return 0


# --- stage 2: run -----------------------------------------------------------

_cache_lock = threading.Lock()


def load_cache() -> dict:
    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, errors="replace") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                cache[d["key"]] = d["answers"]
    return cache


def cache_key(model: str, variant, state: str) -> str:
    # The bundle must be part of the key: changing a question changes the answer.
    return hashlib.sha256(f"{model}|{variant.bundle_hash}|{state}".encode()).hexdigest()


def load_dataset(include_synthetic: bool = False) -> list:
    recs = [json.loads(l) for l in open(DATASET)]
    return recs if include_synthetic else [r for r in recs if not r.get("synthetic")]


def pred_path(name: str) -> str:
    return os.path.join(DATA, f"pred_{name}.jsonl")


def cmd_run(args) -> int:
    variant = variants.VARIANTS[args.variant]
    recs = load_dataset(args.include_synthetic)
    if args.sample:
        random.Random(args.seed).shuffle(recs)
        recs = recs[: args.sample]
    model = args.model
    cache = load_cache()
    os.makedirs(DATA, exist_ok=True)
    out = args.out or pred_path(variant.name)
    cache_f, out_f = open(CACHE, "a"), open(out, "w")
    done = errors = hits = 0
    total = len(recs)

    def work(rec):
        nonlocal done, errors, hits
        state = variant.state(rec)
        key = cache_key(model, variant, state)
        with _cache_lock:
            cached = cache.get(key)
        if cached is not None:
            answers, err, dt = cached, None, 0.0
            with _cache_lock:
                hits += 1
        else:
            t0 = time.time()
            try:
                answers, err = jev.ask(state, variant.bundle, model=model), None
            except Exception as e:
                answers, err = {}, str(e)[:200]
            dt = time.time() - t0
            if err is None:
                with _cache_lock:
                    cache[key] = answers
                    cache_f.write(json.dumps({"key": key, "answers": answers}) + "\n")
                    cache_f.flush()
        with _cache_lock:
            done += 1
            errors += bool(err)
            out_f.write(json.dumps({"id": rec["id"], "answers": answers,
                                    "error": err, "latency": round(dt, 3)}) + "\n")
            if done % 100 == 0 or done == total:
                print(f"\r  {variant.name}: {done}/{total} cached={hits} errors={errors}",
                      end="", file=sys.stderr, flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, recs))
    print(file=sys.stderr)
    out_f.close()
    cache_f.close()
    print(f"{done} predictions ({hits} cached, {errors} errors) -> {out}")
    return 0


# --- stage 3: score ---------------------------------------------------------

def join(variant, preds_path: str, floor: float):
    """-> list of (record, predicted class or None, confidence)"""
    ds = {r["id"]: r for r in load_dataset(True)}
    rows = []
    with open(preds_path) as f:
        for line in f:
            d = json.loads(line)
            if d.get("error") or d["id"] not in ds:
                continue
            c, conf = variant.rule(d["answers"], floor)
            rows.append((ds[d["id"]], c, conf, d["answers"]))
    return rows


def metrics(variant, rows, floor: float) -> dict:
    fired = [(r, c, cf) for r, c, cf, _a in rows if c is not None]
    n = len(fired)
    ok = sum(1 for r, c, _ in fired if c == variant.truth(r))
    truths = collections.Counter(variant.truth(r) for r, _c, _cf in fired)
    best_const = max(truths.values()) / n if n else 0.0
    # A wrong quiet hint tells the agent to skip work it actually needed.
    quiet = [r for r, c, _ in fired if c == variant.quiet_class]
    harmful = [r for r in quiet if r["n_tools"] >= 5]
    return {
        "n_scored": len(rows),
        "coverage": n / max(1, len(rows)),
        "n_fired": n,
        "accuracy": ok / max(1, n),
        "best_constant": best_const,
        "lift": ok / max(1, n) - best_const,
        "quiet_hints": len(quiet),
        "harmful_quiet": len(harmful),
        "harmful_rate": len(harmful) / max(1, n),
    }


def cmd_report(args) -> int:
    variant = variants.VARIANTS[args.variant]
    path = args.preds or pred_path(variant.name)
    rows = join(variant, path, args.floor)
    m = metrics(variant, rows, args.floor)
    fired = [(r, c) for r, c, _cf, _a in rows if c is not None]
    print(f"{variant.name} — {variant.why}")
    print(f"  scored {m['n_scored']}   hints at conf>={args.floor}: {m['n_fired']} "
          f"({100*m['coverage']:.1f}%)")
    print(f"  accuracy {100*m['accuracy']:.1f}%   best constant {100*m['best_constant']:.1f}%   "
          f"lift {100*m['lift']:+.1f}pts")
    print(f"  harmful quiet hints ({variant.quiet_class} then >=5 tool calls): "
          f"{m['harmful_quiet']} ({100*m['harmful_rate']:.1f}% of hints)")

    cm = collections.Counter((variant.truth(r), c) for r, c in fired)
    cols = variant.classes
    actual = [c for c in cols if c not in variant.unscorable]
    table("confusion (row = observed, col = predicted)",
          ["obs\\pred"] + cols + ["n"],
          [[a] + [cm.get((a, p), 0) for p in cols] + [sum(cm.get((a, p), 0) for p in cols)]
           for a in actual],
          [12] + [10] * len(cols) + [6])
    table("per-class", ["class", "obs", "pred", "precision", "recall", "f1"],
          [[l, a, p, f"{pr:.2f}", f"{rc:.2f}", f"{f1:.2f}"]
           for l, a, p, pr, rc, f1 in prf(cm, cols)],
          [11, 7, 7, 11, 9, 6])

    if args.sweep:
        rows_ = []
        for f in [i / 20 for i in range(0, 20)]:
            rr = join(variant, path, f)
            mm = metrics(variant, rr, f)
            if mm["n_fired"]:
                rows_.append([f"{f:.2f}", mm["n_fired"], f"{100*mm['coverage']:.1f}%",
                              f"{100*mm['accuracy']:.1f}%", f"{100*mm['lift']:+.1f}",
                              mm["harmful_quiet"]])
        table("threshold sweep", ["floor", "hints", "coverage", "accuracy", "lift", "harmful"],
              rows_, [8, 8, 11, 11, 8, 9])
    return 0


def prf(matrix, labels):
    out = []
    for lab in labels:
        tp = matrix.get((lab, lab), 0)
        pred = sum(v for (_a, p), v in matrix.items() if p == lab)
        act = sum(v for (a, _p), v in matrix.items() if a == lab)
        pr = tp / pred if pred else 0.0
        rc = tp / act if act else 0.0
        f1 = 2 * pr * rc / (pr + rc) if pr + rc else 0.0
        out.append((lab, act, pred, pr, rc, f1))
    return out


def table(title, header, rows, widths):
    print(f"\n{title}")
    print("  " + "".join(str(h).ljust(w) for h, w in zip(header, widths)))
    print("  " + "-" * sum(widths))
    for r in rows:
        print("  " + "".join(str(c).ljust(w) for c, w in zip(r, widths)))


def cmd_compare(args) -> int:
    rows = []
    for name, v in variants.VARIANTS.items():
        path = pred_path(name)
        if not os.path.exists(path):
            continue
        m = metrics(v, join(v, path, args.floor), args.floor)
        rows.append([name, f"{100*m['coverage']:.0f}%", f"{100*m['accuracy']:.1f}%",
                     f"{100*m['best_constant']:.1f}%", f"{100*m['lift']:+.1f}",
                     m["harmful_quiet"], f"{100*m['harmful_rate']:.1f}%"])
    table(f"variant comparison at conf>={args.floor}",
          ["variant", "coverage", "accuracy", "constant", "lift", "harmful", "harm rate"],
          rows, [19, 10, 10, 10, 8, 9, 10])
    print("\n  accuracy is against behavior observed in the transcript;")
    print("  constant = always guessing that variant's most common class;")
    print("  harmful = told the agent not to use tools, agent then made >=5 tool calls.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="replay", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extract", help="build dataset.jsonl from local transcripts")
    e.add_argument("--projects", default="~/.claude/projects/*/*.jsonl")
    e.set_defaults(fn=cmd_extract)

    r = sub.add_parser("run", help="classify each prompt with jev (cached)")
    r.add_argument("--variant", default="v0_shipped", choices=list(variants.VARIANTS))
    r.add_argument("--model", default=jev.DEFAULT_MODEL)
    r.add_argument("--sample", type=int)
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--workers", type=int, default=10)
    r.add_argument("--include-synthetic", action="store_true")
    r.add_argument("--out")
    r.set_defaults(fn=cmd_run)

    rp = sub.add_parser("report", help="score one variant")
    rp.add_argument("--variant", default="v0_shipped", choices=list(variants.VARIANTS))
    rp.add_argument("--preds")
    rp.add_argument("--floor", type=float, default=0.55)
    rp.add_argument("--sweep", action="store_true")
    rp.set_defaults(fn=cmd_report)

    cp = sub.add_parser("compare", help="one table across every variant already run")
    cp.add_argument("--floor", type=float, default=0.55)
    cp.set_defaults(fn=cmd_compare)

    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
