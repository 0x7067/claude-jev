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

The judge sees exactly what the hook would send: file path, the user's
request, and the old->new hunk. Nothing is applied to any repo.
"""

from __future__ import annotations

import argparse
import collections
import difflib
import glob
import hashlib
import json
import os
import random
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import jev  # noqa: E402
import rules  # noqa: E402
from observed import prompt_text  # noqa: E402

DATA = os.path.join(HERE, "data")
EDITS = os.path.join(DATA, "rules_edits.jsonl")
# The hand-written cases judge edits inside real repos: `cwd` has to be a
# checkout with its own instruction files. They are not in the repo and are
# not reproducible from a clone, so they live under eval/private/, which is
# gitignored. Absent, `run` just judges whatever else was asked for.
CASES = os.path.join(HERE, "private", "rules_cases.jsonl")
PRED = os.path.join(DATA, "rules_pred.jsonl")
CACHE = os.path.join(DATA, "rules_cache.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")

_lock = threading.RLock()  # load_rules may call the cached ask while held


# --- extract ---------------------------------------------------------------

def cmd_extract(args) -> int:
    os.makedirs(DATA, exist_ok=True)
    n = 0
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
                    n += 1
                    out.write(json.dumps({
                        "id": f"{os.path.basename(fp)[:8]}#{n}", "kind": "real",
                        "cwd": cwd, "file_path": inp["file_path"],
                        "tool_name": b["name"], "tool_input": inp, "task": task,
                        "ts": d.get("timestamp"),
                    }) + "\n")
    print(f"{n} real edits -> {EDITS}")
    return 0


# --- run -------------------------------------------------------------------

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


def judge(rec: dict, rule_cache: dict) -> dict:
    cwd = rec["cwd"]
    rel = rules.relative(rec["file_path"], cwd)
    out = {k: rec.get(k) for k in ("id", "kind", "cwd", "task", "violates", "expect", "note", "tags")}
    out["rel"] = rel
    if rules.EXCLUDED.search(rel):
        out["skipped"] = "excluded path"
        return out
    with _lock:
        if cwd not in rule_cache:
            rule_cache[cwd] = rules.load_rules(cwd)
    all_rules = rule_cache[cwd]
    in_scope = rules.scoped_rules(all_rules, "edit", [rel])
    if rec.get("only_rule"):
        in_scope = [r for r in in_scope if r["text"] == rec["only_rule"]]
    hunk = case_hunk(rec, cwd, rel).strip()
    out.update(n_rules=len(all_rules), n_scope=len(in_scope), hunk_chars=len(hunk))
    if not hunk:
        out["skipped"] = "empty hunk"
        return out
    if not in_scope:
        out["skipped"] = "no rules in scope"
        return out
    t0 = time.time()
    try:
        hits, probs, _ = rules.judge_edit(rel, hunk, rec.get("task") or "", in_scope)
        out.update(hits=[{k: h[k] for k in ("rule", "prob", "band", "text", "file", "line")}
                         for h in hits], probs=probs)
    except Exception as e:  # the hook fails open; the eval records why
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


# --- report ----------------------------------------------------------------

def band(r: dict) -> str:
    bands = {h["band"] for h in r.get("hits") or []}
    return "act" if "act" in bands else "flag" if "flag" in bands else "quiet"


def expected_fired(r: dict, threshold_band: str) -> bool:
    exp = (r.get("expect") or "").lower()
    if not exp:
        return False
    for h in r.get("hits") or []:
        if exp in h["text"].lower() and (threshold_band == "flag" or h["band"] == "act"):
            return True
    return False


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


def side_by_side(cases: list[dict], iso_preds: list[dict]) -> None:
    """Per needle, integration next to isolated. Low isolated means the rule or
    its needle is weak; high isolated with low integration means it lost to the
    other rules competing for the same edit."""
    def group(cs):
        g = collections.defaultdict(list)
        for c in cs:
            g[(c.get("tags") or {}).get("needle", "-")].append(c)
        return g
    iso = [p for p in iso_preds if p.get("kind") == "case"
           and not p.get("skipped") and not p.get("error")]
    ints, isos = group(cases), group(iso)
    print(f"\n  {'needle':<26}{'viol':>5}{'int blk':>8}{'int exp':>8}"
          f"{'iso blk':>8}{'iso exp':>8}{'int fb':>7}{'iso fb':>7}")
    for needle in sorted(ints):
        v = [c for c in ints[needle] if c.get("violates")]
        b = [c for c in ints[needle] if not c.get("violates")]
        iv = [c for c in isos.get(needle, []) if c.get("violates")]
        ib = [c for c in isos.get(needle, []) if not c.get("violates")]
        cell = lambda n, d, w=8: f"{n:>{w}}" if d else f"{'-':>{w}}"
        print(f"  {needle[:25]:<26}{len(v):>5}"
              f"{sum(1 for c in v if band(c) == 'act'):>8}"
              f"{sum(1 for c in v if expected_fired(c, 'act')):>8}"
              f"{cell(sum(1 for c in iv if band(c) == 'act'), iv)}"
              f"{cell(sum(1 for c in iv if expected_fired(c, 'act')), iv)}"
              f"{sum(1 for c in b if band(c) == 'act'):>7}"
              f"{cell(sum(1 for c in ib if band(c) == 'act'), ib, 7)}")
    dropped = sum(1 for p in iso_preds if p.get("skipped") == "no rules in scope")
    if dropped:
        print(f"  {dropped} isolated cases had no rules in scope: the classifier dropped "
              f"that rule,\n  so the hook would never ask about it in a real repo either")


def cmd_report(args) -> int:
    preds = load_jsonl(args.pred)
    judged = [p for p in preds if not p.get("skipped") and not p.get("error")]
    cases = [p for p in judged if p["kind"] == "case"]
    real = [p for p in judged if p["kind"] == "real"]
    skipped = collections.Counter(p["skipped"] for p in preds if p.get("skipped"))
    print(f"{len(preds)} records: {len(judged)} judged, "
          f"{sum(1 for p in preds if p.get('error'))} errors, skipped {dict(skipped)}")

    viol = [c for c in cases if c.get("violates")]
    clean = [c for c in cases if not c.get("violates")]
    if cases:
        fixtures = os.path.join(HERE, "fixtures")
        generated = all(str(c.get("cwd", "")).startswith(fixtures) for c in cases)
        what = ("Generated cases against the fixture rules" if generated
                else "Hand-written cases against real repo rules")
        print(f"\n{what}: {len(viol)} violations, "
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

    twin_blocks = collections.Counter()
    for c in clean:
        for h in c.get("hits") or []:
            if h["band"] == "act":
                twin_blocks[(((c.get("tags") or {}).get("needle") or c["id"]), h["rule"])] += 1
    if twin_blocks:
        # A twin tripped by a rule other than its own pair is a corpus defect.
        print("\nBenign twins blocked, by the rule that fired:")
        print(f"  {'twin':<26}{'blocked by':<42}{'n':>4}")
        for (needle, rid), n in twin_blocks.most_common(20):
            print(f"  {needle[:26]:<26}{rid[:42]:<42}{n:>4}")

    if args.iso:
        side_by_side(cases, load_jsonl(args.iso))

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
    r.add_argument("--cases", default=CASES)
    r.add_argument("--out", default=PRED)
    r.set_defaults(fn=cmd_run)
    rp = sub.add_parser("report", help="detection, false blocks, calibration")
    rp.add_argument("--examples", type=int, default=8)
    rp.add_argument("--rules", type=int, default=25)
    rp.add_argument("--pred", default=PRED)
    rp.add_argument("--iso", help="isolated-mode predictions, shown beside the integration ones")
    rp.add_argument("--by-tag", action="store_true",
                    help="breakdown per tag; the case list shows only misses and false blocks")
    rp.set_defaults(fn=cmd_report)
    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
