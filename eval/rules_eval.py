#!/usr/bin/env python3
"""Is the rule hook effective? Two corpora, one judge.

  extract   every Edit/Write/MultiEdit/NotebookEdit in ~/.claude/projects,
            with the repo it happened in and the prompt that asked for it
            -> eval/data/rules_edits.jsonl. These edits were accepted by the
            person at the time, so the block rate on them is the hook's
            false-positive rate under the repo's *current* instruction files.
  run       judge eval/rules_cases.jsonl (hand-written violations and
            near-miss compliant edits against the real rules of real repos)
            and the extracted edits through scripts/rules.judge_edit — the
            same function the PostToolUse hook calls. Cached per (state,
            questions); re-runs are free.
  report    detection on violations (at the block and flag bands, and
            whether the *expected* rule is the one that fired), false blocks
            on compliant cases and real edits, per-rule calibration.

A record with a `sha` is judged at that commit (a detached worktree under
eval/data/at/), not the live checkout, so editing a repo's rules does not
move old numbers. `extract` stamps the repo's HEAD on every edit.

The judge sees exactly what the hook would send: file path, the user's
request, and the old->new hunk. Nothing is applied to any repo.
"""

from __future__ import annotations

import argparse
import collections
import difflib
import functools
import glob
import hashlib
import json
import os
import random
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import jev
import rules
from observed import prompt_text

DATA = os.path.join(HERE, "data")
EDITS = os.path.join(DATA, "rules_edits.jsonl")

CASES = os.path.join(HERE, "private", "rules_cases.jsonl")
PRED = os.path.join(DATA, "rules_pred.jsonl")
AT = os.path.join(DATA, "at")

GLOBAL = os.path.join(HERE, "global_CLAUDE.md")
CACHE = os.path.join(DATA, "rules_cache.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")

_lock = threading.RLock()


def cmd_extract(args) -> int:
    os.makedirs(DATA, exist_ok=True)
    n = gone = excluded = 0
    with open(EDITS, "w") as out:
        for fp in sorted(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))):
            task = ""
            for line in open(fp, errors="replace"):
                if len(line) > 500_000:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("isSidechain"):
                    continue
                if d.get("type") == "user":
                    t = (prompt_text(d.get("message") or {}) or "").strip()
                    if t and not t.startswith(("<", "/", "#")):
                        task = t[: rules.MAX_TASK_CHARS]
                    continue
                if d.get("type") != "assistant":
                    continue
                for b in (d.get("message") or {}).get("content") or []:
                    if not (isinstance(b, dict) and b.get("type") == "tool_use"
                            and b.get("name") in ("Edit", "Write", "MultiEdit", "NotebookEdit")):
                        continue
                    inp = b.get("input") or {}
                    cwd = d.get("cwd")
                    if not cwd or not inp.get("file_path"):
                        continue

                    if not os.path.isdir(cwd):
                        gone += 1
                        continue
                    rel = rules.relative(inp["file_path"], cwd)
                    if rules.EXCLUDED.search(rel) or rules.outside(rel):
                        excluded += 1
                        continue
                    n += 1
                    out.write(json.dumps({
                        "id": f"{os.path.basename(fp)[:8]}#{n}", "kind": "real",
                        "cwd": cwd, "file_path": inp["file_path"], "sha": head_sha(cwd),
                        "tool_name": b["name"], "tool_input": inp, "task": task,
                        "ts": d.get("timestamp"),
                    }) + "\n")
    print(f"{n} real edits -> {EDITS}"
          f"   (pruned {gone} in repos that are gone, {excluded} on excluded paths)")
    return 0


def load_jsonl(path: str) -> list[dict]:
    try:
        with open(path) as f:
            return [json.loads(l) for l in f if l.strip()]
    except OSError:
        return []


def cached_ask(cache: dict, cache_f):
    real_ask = jev.ask

    def ask(state, questions, model=None, timeout=None):
        key = hashlib.sha256(json.dumps(
            [model or jev.DEFAULT_MODEL, state, questions], sort_keys=True).encode()).hexdigest()
        with _lock:
            if key in cache:
                return cache[key]
        answers = real_ask(state, questions, model=model, timeout=timeout)
        with _lock:
            cache[key] = answers
            cache_f.write(json.dumps({"key": key, "answers": answers}) + "\n")
            cache_f.flush()
        return answers
    return ask


def case_hunk(rec: dict, cwd: str, rel: str) -> str:
    """The hook diffs a Write against git after the file changed; here the
    file is unchanged on disk, so diff the payload against it the same way."""
    inp = rec["tool_input"]
    content = inp.get("content")
    if content is None:
        return rules.edit_hunks(inp)
    try:
        with open(os.path.join(cwd, rel), errors="replace") as f:
            old = f.read()
    except OSError:
        return f"NEW FILE (whole content):\n{content}"
    diff = difflib.unified_diff(old.splitlines(keepends=True), content.splitlines(keepends=True),
                                fromfile=f"a/{rel}", tofile=f"b/{rel}", n=3)
    return "".join(diff)


def git_out(cwd: str, *args: str) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


@functools.lru_cache(maxsize=None)
def repo_root(cwd: str) -> str | None:
    return git_out(cwd, "rev-parse", "--show-toplevel") if os.path.isdir(cwd) else None


@functools.lru_cache(maxsize=None)
def head_sha(cwd: str) -> str | None:
    top = repo_root(cwd)
    return git_out(top, "rev-parse", "HEAD") if top else None


def at_commit(cwd: str, sha: str) -> str:
    """`cwd` as it was at `sha`: the same relative place inside a detached
    worktree of that commit, created on first use. Several corpus cwds are
    subdirectories of one repo, so the worktree is per repo root."""
    top = repo_root(cwd)
    if not top:
        raise SystemExit(f"{cwd} is not in a git repo; drop its sha")
    dest = os.path.join(AT, f"{os.path.basename(top)}-{sha[:12]}")
    if not os.path.exists(os.path.join(dest, ".git")):
        os.makedirs(AT, exist_ok=True)
        r = subprocess.run(["git", "worktree", "add", "--detach", dest, sha], cwd=top,
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise SystemExit(f"cannot check out {top} at {sha[:12]}: {r.stderr.strip()}")
    return os.path.normpath(os.path.join(dest, os.path.relpath(cwd, top)))


def judge(rec: dict, rule_cache: dict) -> dict:
    cwd = rec["cwd"]
    rel = rules.relative(rec["file_path"], cwd)
    out = {k: rec.get(k) for k in ("id", "kind", "cwd", "sha", "task", "violates", "expect", "note", "tags")}
    out["rel"] = rel
    if rec.get("sha"):
        with _lock:
            cwd = at_commit(cwd, rec["sha"])
    if rules.EXCLUDED.search(rel) or rules.outside(rel):
        out["skipped"] = "excluded path"
        return out
    with _lock:
        if cwd not in rule_cache:
            rule_cache[cwd] = rules.load_rules(cwd)
    all_rules = rule_cache[cwd]
    in_scope = rules.scoped_rules(all_rules, "edit", [rel])
    hunk = case_hunk(rec, cwd, rel).strip()
    out.update(n_rules=len(all_rules), n_scope=len(in_scope), hunk_chars=len(hunk))
    if not hunk:
        out["skipped"] = "empty hunk"
        return out
    if not in_scope:
        out["skipped"] = "no rules in scope"
        return out

    abs_path = os.path.join(cwd, rel)
    context = rules.file_context(abs_path, rules.needle_of(rec["tool_input"]))
    siblings = rules.sibling_modules(abs_path)
    block = rules.enclosing_block(abs_path, rules.needle_of(rec["tool_input"]))
    t0 = time.time()
    try:
        hits, probs, _, skipped, escalated, cmp_chars = rules.judge_edit(
            rel, hunk, rec.get("task") or "", in_scope, context, siblings,
            block, cwd)
        out.update(hits=[{k: h.get(k) for k in
                          ("rule", "prob", "band", "text", "file", "line",
                           "polarity", "subject")} for h in hits],
                   probs=probs, n_irrelevant=len(skipped),
                   context_chars=len(context), escalated=escalated,
                   comparators=cmp_chars)
    except Exception as e:
        out["error"] = str(e)[:300]
    out["latency"] = round(time.time() - t0, 3)
    return out


def cmd_run(args) -> int:
    os.makedirs(DATA, exist_ok=True)
    recs = []
    if not args.edits_only:
        if os.path.exists(args.cases):
            recs += load_jsonl(args.cases)
        elif args.cases == CASES:
            print(f"no private cases at {args.cases}; skipping them")
        else:
            raise SystemExit(f"no cases file at {args.cases}")
    if not args.cases_only:
        real = load_jsonl(EDITS)
        if args.sample and len(real) > args.sample:
            random.Random(args.seed).shuffle(real)
            real = real[: args.sample]
        recs += real
    cache = {d["key"]: d["answers"] for d in load_jsonl(CACHE)}
    cache_f = open(CACHE, "a")
    jev.ask = cached_ask(cache, cache_f)
    rules.jev.ask = jev.ask
    rule_cache: dict = {}
    rules.GLOBAL_RULE_FILES = (GLOBAL,)
    if args.no_comparators:
        rules.COMPARATORS = False
        print("  comparators off (control run)", file=sys.stderr)
    live = sum(1 for r in recs if not r.get("sha"))
    if live:
        print(f"  {live}/{len(recs)} records have no sha; judged at the live checkout",
              file=sys.stderr)
    done = 0
    results = []

    def work(rec):
        nonlocal done
        r = judge(rec, rule_cache)
        with _lock:
            results.append(r)
            done += 1
            if done % 20 == 0 or done == len(recs):
                print(f"\r  {done}/{len(recs)}", end="", file=sys.stderr, flush=True)
        return r

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, recs))
    print(file=sys.stderr)
    cache_f.close()
    with open(args.out, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    errors = sum(1 for r in results if r.get("error"))
    print(f"{len(results)} judged ({errors} errors) -> {args.out}")
    if errors:
        print("  first error:", next(r["error"] for r in results if r.get("error")))
    return 0

CALIB: dict = {}


def act_of(rule_id: str) -> float:
    return rules.act_for({"id": rule_id}, calib=CALIB)


def band(r: dict) -> str:
    """The band the hook would land in. Recomputed from the stored
    probabilities when a calibration is in play, so a threshold change can be
    scored without re-judging anything."""
    if not CALIB:
        bands = {h["band"] for h in r.get("hits") or []}
        return "act" if "act" in bands else "flag" if "flag" in bands else "quiet"
    out = "quiet"
    for rid, p in (r.get("probs") or {}).items():
        if p >= act_of(rid):
            return "act"
        if p >= rules.FLAG:
            out = "flag"
    return out


def expected_fired(r: dict, threshold_band: str) -> bool:
    exp = (r.get("expect") or "").lower()
    if not exp:
        return False
    for h in r.get("hits") or []:
        acted = h["prob"] >= act_of(h["rule"]) if CALIB else h["band"] == "act"
        if exp in h["text"].lower() and (threshold_band == "flag" or acted):
            return True
    return False


def write_calib(real: list[dict], path: str) -> None:
    """Per-rule {median, n} over the real edits in this prediction file —
    what `rules.act_for` reads to give a decisive rule a lower bar."""
    per = collections.defaultdict(list)
    for r in real:
        for rid, p in (r.get("probs") or {}).items():
            per[rid].append(p)
    calib = {rid: {"median": round(statistics.median(ps), 3), "n": len(ps)}
             for rid, ps in per.items()}
    with open(path, "w") as f:
        json.dump(calib, f, indent=1, sort_keys=True)
    print(f"calibration for {len(calib)} rules -> {path}")


def top_prob(r: dict) -> float | None:
    """The record's highest rule probability, which is what any ACT compares
    against. `judge` stores every in-scope rule's probability; prediction
    files written before it did have only the hits, so fall back to those
    (their maximum is right whenever the record fired at all)."""
    probs = r.get("probs")
    if probs:
        return max(probs.values())
    hits = r.get("hits")
    if hits:
        return max(h["prob"] for h in hits)
    return None


def sweep(viol: list[dict], clean: list[dict], real: list[dict]) -> None:
    """What moving ACT would have done, FLAG held at 0.50. Same shape as
    `replay.py report --sweep`: one row per candidate threshold, the live
    value marked."""
    pv = [p for p in (top_prob(r) for r in viol) if p is not None]
    pc = [p for p in (top_prob(r) for r in clean) if p is not None]
    pr = [p for p in (top_prob(r) for r in real) if p is not None]
    missing = ((len(viol) - len(pv)) + (len(clean) - len(pc)) + (len(real) - len(pr)))
    print(f"\nthreshold sweep (FLAG={rules.FLAG} fixed)")
    if missing:
        print(f"  {missing} judged records carry no probabilities; "
              "re-run `run` to refresh the prediction file")
    print(f"  {'ACT':<7}{'real blocked':<16}{'violations caught':<20}"
          f"{'near-misses blocked':<21}")
    print("  " + "-" * 64)
    for i in range(60, 100, 5):
        act = i / 100
        nb = sum(1 for p in pr if p >= act)
        nv = sum(1 for p in pv if p >= act)
        nc = sum(1 for p in pc if p >= act)
        rate = f"{nb} ({100*nb/len(pr):.1f}%)" if pr else "-"
        mark = "  <- current" if abs(act - rules.ACT) < 1e-9 else ""
        print(f"  {act:<7.2f}{rate:<16}{f'{nv}/{len(pv)}':<20}"
              f"{f'{nc}/{len(pc)}':<21}{mark}")


def by_tag(cases: list[dict]) -> None:
    """Detection and false-block rate per tag value — where does the judge
    break: whole-file writes, needles at the end, large files?"""
    keys = sorted({k for c in cases for k in (c.get("tags") or {})})
    for key in keys:
        groups = collections.defaultdict(list)
        for c in cases:
            groups[(c.get("tags") or {}).get(key, "-")].append(c)
        print(f"\n  by {key:<10} {'violations':>11} {'blocked':>8} {'flagged+':>9}"
              f" {'benign':>7} {'false blk':>10} {'expected rule':>14}")
        for val, cs in sorted(groups.items()):
            v = [c for c in cs if c.get("violates")]
            b = [c for c in cs if not c.get("violates")]
            print(f"  {str(val):<13}{len(v):>11}{sum(1 for c in v if band(c) == 'act'):>8}"
                  f"{sum(1 for c in v if band(c) != 'quiet'):>9}"
                  f"{len(b):>8}{sum(1 for c in b if band(c) == 'act'):>10}"
                  f"{sum(1 for c in v if expected_fired(c, 'act')):>14}")


def cmd_report(args) -> int:
    global CALIB
    preds = load_jsonl(args.pred)
    if args.calib:
        CALIB = json.load(open(args.calib))
        print(f"per-rule thresholds from {args.calib} "
              f"({len(CALIB)} rules; decisive {rules.ACT_DECISIVE}, "
              f"noisy {rules.ACT_NOISY}, else {rules.ACT})")
    judged = [p for p in preds if not p.get("skipped") and not p.get("error")]
    cases = [p for p in judged if p["kind"] == "case"]
    real = [p for p in judged if p["kind"] == "real"]
    skipped = collections.Counter(p["skipped"] for p in preds if p.get("skipped"))
    print(f"{len(preds)} records: {len(judged)} judged, "
          f"{sum(1 for p in preds if p.get('error'))} errors, skipped {dict(skipped)}")

    viol = [c for c in cases if c.get("violates")]
    clean = [c for c in cases if not c.get("violates")]
    if cases:
        print(f"\nHand-written cases against real repo rules: {len(viol)} violations, "
              f"{len(clean)} compliant near-misses")
        det_act = sum(1 for c in viol if band(c) == "act")
        det_flag = sum(1 for c in viol if band(c) != "quiet")
        exp_act = sum(1 for c in viol if expected_fired(c, "act"))
        exp_flag = sum(1 for c in viol if expected_fired(c, "flag"))
        print(f"  violations blocked (>= {rules.ACT}) : {det_act}/{len(viol)}"
              f"   by the expected rule: {exp_act}/{len(viol)}")
        print(f"  violations blocked or flagged (>= {rules.FLAG}) : {det_flag}/{len(viol)}"
              f"   by the expected rule: {exp_flag}/{len(viol)}")
        fb = sum(1 for c in clean if band(c) == "act")
        ff = sum(1 for c in clean if band(c) == "flag")
        print(f"  compliant edits blocked : {fb}/{len(clean)}   flagged only: {ff}/{len(clean)}")
        if args.by_tag:
            by_tag(cases)
        print("\n  case                          violates  band   top rule (p)")
        for c in (cases if not args.by_tag else
                  [c for c in cases if (c.get("violates") and band(c) != "act")
                   or (not c.get("violates") and band(c) == "act")]):
            hits = sorted(c.get("hits") or [], key=lambda h: -h["prob"])
            top = f"{hits[0]['rule'][:34]} ({hits[0]['prob']:.2f})" if hits else "-"
            mark = ""
            if c.get("violates") and band(c) != "act":
                mark = "  <- MISSED"
            elif not c.get("violates") and band(c) == "act":
                mark = "  <- FALSE BLOCK"
            elif c.get("violates") and not expected_fired(c, "act"):
                mark = "  <- blocked, but by another rule"
            print(f"  {c['id']:<30}{'yes' if c.get('violates') else 'no ':<10}"
                  f"{band(c):<7}{top}{mark}")

    if real:
        blocked = [r for r in real if band(r) == "act"]
        flagged = [r for r in real if band(r) == "flag"]
        lat = [r["latency"] for r in real if r.get("latency")]
        print(f"\nReal edits from your transcripts (accepted at the time): {len(real)} judged")
        print(f"  would block : {len(blocked)} ({100*len(blocked)/len(real):.1f}%)"
              f"   flag only: {len(flagged)} ({100*len(flagged)/len(real):.1f}%)")
        if lat:
            print(f"  latency     : median {statistics.median(lat):.2f}s  "
                  f"p90 {sorted(lat)[int(0.9*(len(lat)-1))]:.2f}s  "
                  f"questions/edit median {statistics.median(r['n_scope'] for r in real)}")
        irr = [r.get("n_irrelevant", 0) for r in real]
        if any(irr):
            asked = [r["n_scope"] - r.get("n_irrelevant", 0) for r in real]
            print(f"  relevance   : in scope {sum(r['n_scope'] for r in real)}, "
                  f"skipped as irrelevant {sum(irr)} "
                  f"({100*sum(irr)/max(1, sum(r['n_scope'] for r in real)):.1f}%), "
                  f"asked median {statistics.median(asked)}")
        ctx = [r.get("context_chars", 0) for r in real]
        if any(ctx):
            print(f"  context     : {sum(1 for c in ctx if c)}/{len(real)} edits "
                  f"carried surrounding lines")
        by_rule = collections.Counter(h["rule"] for r in blocked for h in r["hits"]
                                      if h["band"] == "act")
        if by_rule:
            print("  rules behind the blocks:")
            for rid, n in by_rule.most_common(12):
                print(f"    {n:>3}  {rid}")
        if args.examples:
            print(f"\n  first {args.examples} real edits the hook would have blocked:")
            for r in blocked[: args.examples]:
                h = max(r["hits"], key=lambda h: h["prob"])
                print(f"  - {r['rel']}  [{h['rule']} {h['prob']:.2f}] "
                      f"\"{' '.join(h['text'].split())[:110]}\"")
                if r.get("task"):
                    print(f"      task: {' '.join(r['task'].split())[:110]}")

    if args.sweep:
        sweep(viol, clean, real)

    if args.write_calib:
        write_calib(real, args.write_calib)

    per_rule = collections.defaultdict(list)
    for r in judged:
        for rid, p in (r.get("probs") or {}).items():
            per_rule[rid].append(p)
    if per_rule:
        print(f"\nPer-rule calibration over every judged edit "
              f"(fired = >= {rules.ACT}; a rule firing on most edits is too broad):")
        print(f"  {'rule':<40}{'checks':>7}{'median':>8}{'max':>6}{'fired':>7}")
        rows = sorted(per_rule.items(), key=lambda kv: -sum(1 for p in kv[1] if p >= rules.ACT))
        for rid, ps in rows[: args.rules]:
            fired = sum(1 for p in ps if p >= rules.ACT)
            print(f"  {rid[:40]:<40}{len(ps):>7}{statistics.median(ps):>8.2f}"
                  f"{max(ps):>6.2f}{fired:>7}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="rules_eval", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract", help="real edits from local transcripts")
    e.set_defaults(fn=cmd_extract)
    r = sub.add_parser("run", help="judge cases and real edits (cached)")
    r.add_argument("--cases-only", action="store_true")
    r.add_argument("--edits-only", action="store_true")
    r.add_argument("--sample", type=int, default=0, help="cap on real edits")
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--no-comparators", action="store_true",
                   help="control run: judge without the ast-grep lookups")
    r.add_argument("--cases", default=CASES)
    r.add_argument("--out", default=PRED)
    r.set_defaults(fn=cmd_run)
    rp = sub.add_parser("report", help="detection, false blocks, calibration")
    rp.add_argument("--examples", type=int, default=8)
    rp.add_argument("--rules", type=int, default=25)
    rp.add_argument("--pred", default=PRED)
    rp.add_argument("--calib", default=None,
                    help="score with per-rule act thresholds from this file")
    rp.add_argument("--write-calib", nargs="?", const=rules.CALIB_FILE,
                    default=None, metavar="PATH",
                    help="write per-rule medians for the hook to read")
    rp.add_argument("--sweep", action="store_true",
                    help="what each ACT from 0.60 to 0.95 would have blocked")
    rp.add_argument("--by-tag", action="store_true",
                    help="breakdown per tag; the case list shows only misses and false blocks")
    rp.set_defaults(fn=cmd_report)
    args = p.parse_args()
    return args.fn(args)

if __name__ == "__main__":
    sys.exit(main())
