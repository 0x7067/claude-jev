#!/usr/bin/env python3
"""Does the subagent router pick the tier the person would have picked?

extract   every Agent/Task spawn in ~/.claude/projects whose input names a
          model the router knows -> eval/observed/subagent_spawns.jsonl.
          The named model is the person's own routing decision, so it is
          the label.
run       ask the shipped `jev.subagent_bundle` about a seeded sample, with
          the state `src/subagent-router.ts` builds, and append the answers
          to eval/observed/subagent_answers.jsonl. `--variant` swaps in
          other tier text from VARIANTS and writes its own answer file.
          Spawns already answered are skipped, so a re-run only pays for
          new ones.
report    for each gate rule, land every spawn on the routed tier, or on
          the parent's model when the gate holds back, and count matches,
          too-cheap picks (the costly miss), and too-dear picks.
"""

from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import random
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import jev
from rules_eval import load_jsonl as load

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "observed")
SPAWNS = os.path.join(DATA, "subagent_spawns.jsonl")
TIERS = list(jev.TIER_CRITERIA)
VARIANTS = {
    "shipped": {},
    "judgment": {
        "haiku": "Mechanical work with one obvious way to do it: search, fetch, "
        "count, list, run a named command and report its output, or apply "
        "an edit the brief spells out exactly. No judgment about code or "
        "about results",
        "sonnet": "Well-specified implementation: the brief names the files, the "
        "change, and the check, and the work follows an existing pattern. "
        "Needs local judgment about code, but the brief has already made "
        "the design decisions",
        "opus": "Work whose result rests on judgment, even when it edits nothing: "
        "grading, verifying, or reviewing someone else's work; auditing a "
        "setup against its docs; research or data analysis that must reach "
        "a conclusion; implementation that leaves design choices open, "
        "spans many files, or lands in unfamiliar code; debugging without "
        "a clear signal",
    },
}


def answers_path(variant: str) -> str:
    suffix = "" if variant == "shipped" else f"_{variant}"
    return os.path.join(DATA, f"subagent_answers{suffix}.jsonl")


def spawn_key(prompt: str) -> str:
    return hashlib.sha256(prompt.encode()).hexdigest()[:16]


def cmd_extract(_args) -> None:
    os.makedirs(DATA, exist_ok=True)
    seen = set()
    out = []
    for path in glob.glob(
        os.path.join(jev.config_dir(), "projects", "**", "*.jsonl"), recursive=True
    ):
        try:
            with open(path, errors="replace") as f:
                lines = [ln for ln in f if '"Agent"' in ln or '"Task"' in ln]
        except OSError:
            continue
        for line in lines:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "assistant":
                continue
            msg = d.get("message") or {}
            parent = msg.get("model") or ""
            for b in msg.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                if b.get("name") not in ("Agent", "Task"):
                    continue
                inp = b.get("input") or {}
                prompt = inp.get("prompt") or ""
                model = inp.get("model")
                key = spawn_key(prompt)
                if model not in TIERS or not prompt.strip() or key in seen:
                    continue
                seen.add(key)
                out.append(
                    {
                        "key": key,
                        "model": model,
                        "parent": parent,
                        "subagent_type": inp.get("subagent_type") or "",
                        "description": inp.get("description") or "",
                        "prompt": prompt,
                    }
                )
    with open(SPAWNS, "w") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    print(f"{len(out)} spawns -> {SPAWNS}")
    print(dict(collections.Counter(r["model"] for r in out)))


def build_state(r: dict) -> str:
    parts = [f"Agent type: {r['subagent_type'] or 'general'}"]
    if r["description"]:
        parts.append(f"Task summary: {r['description']}")
    parts.append(f"Task: {r['prompt'][:8000]}")
    return "\n\n".join(parts)


def cmd_run(args) -> None:
    spawns = load(SPAWNS)
    random.Random(args.seed).shuffle(spawns)
    out = answers_path(args.variant)
    done = {r["key"] for r in load(out)}
    todo = [r for r in spawns[: args.sample] if r["key"] not in done]
    bundle = jev.subagent_bundle(tiers=VARIANTS[args.variant])

    def one(r: dict):
        try:
            return r, jev.ask(build_state(r), bundle), None
        except Exception as e:
            return r, None, str(e)

    failed = 0
    with ThreadPoolExecutor(args.workers) as pool, open(out, "a") as f:
        for r, answers, err in pool.map(one, todo):
            if err:
                failed += 1
                continue
            f.write(json.dumps({"key": r["key"], "model": r["model"], "answers": answers}) + "\n")
    print(f"asked {len(todo)}, failed {failed}, answers -> {out}")


def gate_margin(t: dict, floor: float):
    return t["choice"] if t.get("confidence", 0) >= floor else None


def gate_top(t: dict, floor: float):
    probs = t.get("probabilities") or {}
    return t["choice"] if probs.get(t["choice"], 0) >= floor else None


def gate_argmax(t: dict, _floor: float):
    return t["choice"]


def gate_never(_t: dict, _floor: float):
    return None


def gate_cumulative(t: dict, risk: float):
    probs = t.get("probabilities") or {}
    above = 1.0
    for tier in TIERS:
        above -= probs.get(tier, 0)
        if above <= risk:
            return tier
    return None


GATES = [
    ("margin>=0.75 (0.24.0)", gate_margin, 0.75),
    ("margin>=0.50", gate_margin, 0.50),
    ("top>=0.60", gate_top, 0.60),
    ("top>=0.70", gate_top, 0.70),
    ("cumulative risk<=0.10 (shipped)", gate_cumulative, 0.10),
    ("cumulative risk<=0.20", gate_cumulative, 0.20),
    ("cumulative risk<=0.30", gate_cumulative, 0.30),
    ("argmax", gate_argmax, 0.0),
    ("never route", gate_never, 0.0),
]


ROW = "{:<34}{:>8}{:>8}{:>9}{:>8}"


def tier_of(model: str) -> str | None:
    return next((t for t in TIERS if t in model.lower()), None)


def cmd_report(args) -> None:
    parents = {r["key"]: tier_of(r.get("parent") or "") for r in load(SPAWNS)}
    by_variant = {
        v: {r["key"]: r for r in load(answers_path(v)) if (r["answers"] or {}).get("model_tier")}
        for v in args.variant or ["shipped"]
    }
    common = set.intersection(*(set(rows) for rows in by_variant.values()))
    for variant, answered in by_variant.items():
        print(f"== {variant}")
        report_rows([answered[k] for k in sorted(common) if parents.get(k)], parents)


def report_rows(rows: list[dict], parents: dict) -> None:
    print(
        f"{len(rows)} answered spawns, labels {dict(collections.Counter(r['model'] for r in rows))}"
    )
    print("every spawn lands on the routed tier, or the parent's when the gate holds back")
    print(ROW.format("gate", "routed", "match", "cheaper", "dearer"))
    for name, gate, x in GATES:
        c = collections.Counter()
        for r in rows:
            pick = gate(r["answers"]["model_tier"], x)
            if pick in TIERS:
                c["routed"] += 1
            else:
                pick = parents[r["key"]]
            diff = TIERS.index(pick) - TIERS.index(r["model"])
            c["match" if diff == 0 else "cheaper" if diff < 0 else "dearer"] += 1
        print(ROW.format(name, c["routed"], c["match"], c["cheaper"], c["dearer"]))
    confusion = collections.Counter(
        (r["model"], r["answers"]["model_tier"].get("choice")) for r in rows
    )
    print("\nlabel -> Jev argmax")
    for label in TIERS:
        print(f"  {label:<7}", {k[1]: v for k, v in confusion.items() if k[0] == label})
    print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("extract")
    run = sub.add_parser("run")
    run.add_argument("--sample", type=int, default=300)
    run.add_argument("--seed", type=int, default=0)
    run.add_argument("--workers", type=int, default=8)
    run.add_argument("--variant", choices=list(VARIANTS), default="shipped")
    report = sub.add_parser("report")
    report.add_argument("--variant", choices=list(VARIANTS), action="append")
    args = p.parse_args()
    {"extract": cmd_extract, "run": cmd_run, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
