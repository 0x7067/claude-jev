#!/usr/bin/env python3
"""Planted-constraint survival: the failure seen live, measured.

For each compaction event, plant one user constraint among the judged blocks
and, separately, bury a restatement of it at the end of an existing assistant
reply. Run the selection and record whether each planted block survived (kept
whole or as a head that still contains the constraint). `--old` loads the
question set from a git ref so two wordings can be compared on the same
events and plants.

  python3 eval/planted.py --synth 60
  python3 eval/planted.py --synth 60 --old HEAD
"""

from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import os
import random
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compactor

CONSTRAINTS = [
    "One constraint: do not touch anything under migrations/, the DBA owns that folder.",
    "Use pnpm for everything here, never npm or yarn.",
    "The ticket is PROJ-4471 and the deadline is Friday. Do not open a PR before then.",
    "Keep all changes inside src/billing/. Anything outside it needs my sign-off first.",
    "Do not bump any dependency versions in this task, even if a fix suggests it.",
    "Write the tests with vitest, not jest; we are mid-migration.",
    "Never force-push to main. Use a branch named fix/ledger-rounding.",
    "The API must stay backwards compatible with v2 clients until October.",
    "Log lines must use the structured logger, not print or console.log.",
    "Do not run the seed script against the shared staging database.",
]
RESTATE = "Noted, and I'll keep to your constraint: {c}"
KEYS = [
    "migrations/",
    "pnpm",
    "PROJ-4471",
    "src/billing/",
    "dependency versions",
    "vitest",
    "fix/ledger-rounding",
    "v2 clients",
    "structured logger",
    "seed script",
]


def load_old(ref: str):
    src = subprocess.check_output(["git", "show", f"{ref}:scripts/compactor.py"], text=True)
    with tempfile.NamedTemporaryFile(
        "w", suffix=".py", delete=False, dir=os.path.dirname(compactor.__file__)
    ) as tf:
        tf.write(src)
        path = tf.name
    spec = importlib.util.spec_from_file_location("compactor_old", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    os.unlink(path)
    return mod


def plant(blocks: list[dict], rng: random.Random) -> tuple[list[dict], dict]:
    """One user constraint block and one buried restatement, both in the
    judged range and at least 8 blocks apart from the pinned tail."""
    n = len(blocks) - compactor.PIN_TAIL
    k = rng.randrange(len(CONSTRAINTS))
    c, key = CONSTRAINTS[k], KEYS[k]
    out = list(blocks)
    pos_user = rng.randrange(max(1, n // 5), max(2, n - 8))
    out.insert(pos_user, {"role": "user", "text": c})
    cands = [
        i
        for i, b in enumerate(out)
        if b["role"] == "assistant"
        and i > pos_user + 1
        and i < len(out) - 8
        and not b["text"].startswith("[tool_use")
        and len(b["text"]) < 900
    ]
    pos_buried = rng.choice(cands) if cands else None
    if pos_buried is not None:
        out[pos_buried] = {
            "role": "assistant",
            "text": out[pos_buried]["text"].rstrip() + "\n\n" + RESTATE.format(c=c),
        }
    return out, {"key": key, "user": pos_user, "buried": pos_buried}


def run_event(mod, fp, lines, i, kind, seed: int) -> dict | None:
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as tf:
        tf.writelines(lines[:i])
        tmp = tf.name
    try:
        blocks = mod.transcript_blocks(tmp)[-mod.MAX_BLOCKS :]
    finally:
        os.unlink(tmp)
    if len(blocks) < 30:
        return None
    planted, meta = plant(blocks, random.Random(f"{seed}:{os.path.basename(fp)}"))
    try:
        kept, stats = mod.select_blocks(planted, None)
    except mod.jev.JevError as e:
        print(f"  jev failed on {os.path.basename(fp)}: {e}", file=sys.stderr)
        return None
    final = {k["i"]: k for k in kept}

    def fate(pos):
        if pos is None:
            return None
        k = final.get(pos)
        if k is None:
            return "dropped"
        return "kept" if meta["key"] in k["text"] else "cut"

    rows = stats["rows"]
    return {
        "file": os.path.basename(fp),
        "kind": kind,
        "key": meta["key"],
        "user": fate(meta["user"]),
        "user_keep": rows[meta["user"]]["keep"],
        "buried": fate(meta["buried"]),
        "buried_keep": rows[meta["buried"]]["keep"] if meta["buried"] is not None else None,
        "kept": stats["kept"],
        "blocks": len(planted),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--old", help="git ref whose scripts/compactor.py supplies the questions")
    ap.add_argument("--out", help="write per-event results here as jsonl")
    args = ap.parse_args()
    mod = load_old(args.old) if args.old else compactor

    import sweep

    todo = sweep.events(args.synth, args.seed)
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [
            ex.submit(run_event, mod, fp, lines, i, kind, args.seed)
            for fp, lines, i, _end, _prev, kind in todo
        ]
        for f in concurrent.futures.as_completed(futs):
            r = f.result()
            if r:
                results.append(r)
    if args.out:
        with open(args.out, "w") as f:
            for r in results:
                f.write(json.dumps(r) + "\n")

    def summary(field):
        vals = [r[field] for r in results if r[field]]
        n = len(vals)
        return n, {v: sum(1 for x in vals if x == v) for v in ("kept", "cut", "dropped")}

    label = f"questions from {args.old}" if args.old else "current questions"
    print(
        f"\n{label}: {len(results)} events, "
        f"mean kept {sum(r['kept'] for r in results) / max(len(results), 1):.1f} of "
        f"{sum(r['blocks'] for r in results) / max(len(results), 1):.0f} blocks"
    )
    for field in ("user", "buried"):
        n, c = summary(field)
        scores = sorted(r[f"{field}_keep"] for r in results if r[f"{field}_keep"] is not None)
        med = scores[len(scores) // 2] if scores else float("nan")
        print(
            f"  planted {field:6}: n={n:3d} survived {100 * c['kept'] / max(n, 1):3.0f}% "
            f"(kept {c['kept']}, cut {c['cut']}, dropped {c['dropped']})  median keep score {med:.2f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
