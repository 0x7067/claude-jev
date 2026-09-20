#!/usr/bin/env python3
"""Rule enforcement hooks: PostToolUse on Edit|Write|MultiEdit|NotebookEdit,
and Stop for turn-level rules.

Rules come from a compiled rubric (`.claude/jev-rubric.json`, written by the
/jev:rules-compile command) when one exists, and otherwise from CLAUDE.md,
AGENTS.md, .claude/rules/*, ~/.claude/CLAUDE.md and ~/.claude/jev-rules.md:
each bullet or paragraph is judged once by Jev — is this an instruction to
the agent, or a fact, description or pointer? — and the verdict is cached by
file hash, so the per-edit request carries only real instructions.
Only `model` rules are judged — `lint` rules name what a real linter owns and
are never run or sent to Jev; `deferred` and `unenforceable` are recorded for
the report and skipped. Scope globs (`paths:` front matter, `(scope: glob)`
tails, or the rubric's `scope` field) keep out-of-scope rules out of the
request entirely.

`when: "edit"` rules judge each edit hunk; `when: "turn"` rules judge the
whole session's changes at Stop. Verdicts are banded: at or above ACT the
hook blocks and the agent sees the cited rule; between FLAG and ACT the
uncertainty goes to the user as a notice; below stays silent. One rule may
block the same file at most twice per session — past that it only flags,
because a repair that can't land is a loop, not enforcement.

Always exits 0 and prints nothing on any failure — enforcement must never
corrupt a session.

Env:
  TYPESAFE_API_KEY / TYPESAFE_AI_KEY   required (else silently disabled)
"""

import datetime
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jev  # noqa: E402
import rubric  # noqa: E402

# Bands, not a single cut at 0.5: act above, flag the middle, ignore below.
ACT = 0.80
FLAG = 0.50
MAX_RULES = 40
MAX_STATE_CHARS = 8000
MAX_TASK_CHARS = 600
MAX_BLOCKS = 2         # per rule+file per session; then flag-only
MAX_STOP_BLOCKS = 2    # per session; then flag-only
MAX_HUNK_CHARS = 2000  # per edit, kept for the turn check
MAX_TURN_CHARS = 16000
MAX_PROMPT_TAIL = 400
MAX_NESTED_DEPTH = 4
DEFAULT_LOG = os.path.expanduser("~/.claude/jev-router-log.jsonl")
BLOCK_DIR = os.path.expanduser("~/.claude/jev-rule-blocks")

RULE_FILES = ("CLAUDE.md", "AGENTS.md")
RULE_DIRS = (".claude/rules", ".cursor/rules")
GLOBAL_RULE_FILES = (os.path.expanduser("~/.claude/CLAUDE.md"),
                     os.path.expanduser("~/.claude/jev-rules.md"))
MAX_ITEM_CHARS = 600

EXCLUDED = re.compile(r"(^|/)(node_modules|\.git|dist|build|\.next|coverage|"
                      r"\.claude|vendor|target)(/|$)|\.lock$|"
                      r"package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$")
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", ".next",
             "vendor", "coverage", ".turbo", ".cache", "target", ".claude"}

BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.*)")
HEADING = re.compile(r"^\s*#{1,6}\s+")
NAMED = re.compile(r"^\*\*([\w-]+)\*\*:?\s*(.*)")
SCOPE_TAIL = re.compile(r"\(scope:\s*([^)]+)\)\s*$")
FRONT_MATTER = re.compile(r"^---\s*$")


def slug(text: str) -> str:
    return "-".join(re.findall(r"[a-z0-9]+", text.lower())[:5]) or "rule"


def glob_match(path: str, globs: list[str]) -> bool:
    """Repo-relative posix path vs `**`/`*`/`?` globs (stdlib only).
    `**/` matches zero or more directories, like picomatch."""
    def rx(g: str) -> str:
        out = []
        parts = re.split(r"(\*\*)", g)
        for i, part in enumerate(parts):
            if part == "**":
                nxt = parts[i + 1] if i + 1 < len(parts) else ""
                if nxt.startswith("/"):
                    parts[i + 1] = nxt[1:]
                    out.append("(?:.*/)?")
                else:
                    out.append(".*")
            else:
                out.append(re.escape(part)
                           .replace(r"\*", "[^/]*").replace(r"\?", "[^/]"))
        return "^" + "".join(out) + "$"
    return any(re.match(rx(g.strip()), path) for g in globs if g.strip())


def frontmatter_paths(lines: list[str]) -> list[str]:
    """`paths:` list from YAML front matter at the top of a rules file —
    the same convention .claude/rules/*.md uses."""
    paths = []
    if not lines or not FRONT_MATTER.match(lines[0]):
        return paths
    in_paths = False
    for raw in lines[1:]:
        line = raw.rstrip()
        if FRONT_MATTER.match(line):
            break
        if re.match(r"^paths:\s*$", line):
            in_paths = True
            continue
        if in_paths:
            m = re.match(r'^\s*-\s*["\']?(.*?)["\']?\s*$', line)
            if m:
                paths.append(m.group(1))
                continue
            in_paths = False
        else:
            m = re.match(r"^paths:\s*\[(.*)\]", line)
            if m:
                paths += [p.strip().strip("\"'") for p in m.group(1).split(",")]
    return paths


def markdown_items(lines: list[str]) -> list[tuple[int, str]]:
    """(line, text) per bullet or paragraph, with wrapped lines joined.
    Instruction files wrap at ~80 columns, so a rule is rarely one line;
    judging fragments produced mid-sentence "rules" and lost the rest.
    Code fences, headings and front matter are skipped — examples and
    titles are not rules."""
    items: list[tuple[int, str]] = []
    cur_line, cur = 0, []
    in_fence = False
    in_front = bool(lines) and bool(FRONT_MATTER.match(lines[0]))

    def flush():
        nonlocal cur
        if cur:
            items.append((cur_line, " ".join(x.strip() for x in cur)))
        cur = []

    for i, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        if in_front:
            if i > 1 and FRONT_MATTER.match(line):
                in_front = False
            continue
        if line.strip().startswith("```"):
            in_fence = not in_fence
            flush()
            continue
        if in_fence:
            continue
        if not line.strip() or HEADING.match(line) or line.lstrip().startswith("|"):
            flush()
            continue
        m = BULLET.match(line)
        if m:
            flush()
            cur_line, cur = i, [m.group(1)]
        elif cur and (line.startswith((" ", "\t")) or not BULLET.match(cur[0])):
            cur.append(line)
        else:
            flush()
            cur_line, cur = i, [line]
    flush()
    return items


INSTRUCTION_Q = ("Is item [{i}] an instruction that tells a coding agent what to do "
                 "or not do when it changes code or files in this repository? "
                 "Facts, descriptions, background and pointers to other documents are not.")
INSTRUCTION_CACHE = os.path.expanduser("~/.claude/jev-rules-cache.json")
INSTRUCTION_MIN = 0.5
ITEMS_PER_REQUEST = 60


def instruction_lines(path: str, lines: list[str],
                      items: list[tuple[int, str]]) -> set[int]:
    """Line numbers of the items Jev judges to be instructions. One batched
    request per file, cached by content hash — the file changes rarely, the
    hook runs on every edit."""
    digest = hashlib.sha256("".join(lines).encode()).hexdigest()
    try:
        with open(INSTRUCTION_CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    if cache.get(digest) is not None:
        return set(cache[digest])
    keep: set[int] = set()
    for start in range(0, len(items), ITEMS_PER_REQUEST):
        chunk = items[start:start + ITEMS_PER_REQUEST]
        state = "\n\n".join(f"[{i}] {text}" for i, (_ln, text) in enumerate(chunk))
        questions = {f"q{i}": {"type": "noul", "instructions": INSTRUCTION_Q.format(i=i)}
                     for i in range(len(chunk))}
        answers = jev.ask(state, questions)
        for i, (ln, _text) in enumerate(chunk):
            p = (answers.get(f"q{i}") or {}).get("noul")
            if isinstance(p, (int, float)) and p >= INSTRUCTION_MIN:
                keep.add(ln)
    cache[digest] = sorted(keep)
    try:
        with open(INSTRUCTION_CACHE, "w") as f:
            json.dump(cache, f)
    except OSError:
        pass
    return keep


def parse_rules(path: str, base_label: str | None = None,
                file_scope: list[str] | None = None) -> list[dict]:
    """Instructions from a markdown file, each with its line for citation.
    Only items that tell the agent to do or not do something qualify."""
    rules = []
    try:
        with open(path, errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return rules
    base = base_label or os.path.basename(path)
    scope0 = list(file_scope or []) + frontmatter_paths(lines)
    items = [(ln, t.strip()) for ln, t in markdown_items(lines) if len(t.strip()) >= 20]
    keep = instruction_lines(path, lines, items)
    for line_no, text in items:
        if line_no not in keep:
            continue
        if len(text) > MAX_ITEM_CHARS:
            cut = text.rfind(". ", 0, MAX_ITEM_CHARS)
            text = text[: cut + 1] if cut > 100 else text[:MAX_ITEM_CHARS]
        scope = list(scope0)
        sm = SCOPE_TAIL.search(text)
        if sm:
            scope += [g.strip() for g in sm.group(1).split(",")]
            text = text[: sm.start()].strip()
        name = None
        nm = NAMED.match(text)
        if nm:
            name, text = nm.group(1), nm.group(2).strip() or text
        rules.append({"id": name or slug(text), "text": text,
                      "file": base, "line": line_no, "scope": scope,
                      "when": "edit", "check": {"type": "model"},
                      "status": "active"})
    return rules


def nested_files(cwd: str) -> list[tuple[str, str]]:
    """(path, scope-glob) for AGENTS.md/CLAUDE.md below the root — abide's
    convention: a nested instruction file governs its own tree. Root files
    are the caller's job."""
    out = []
    def walk(d: str, depth: int):
        if depth > MAX_NESTED_DEPTH:
            return
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            return
        if depth > 0:
            rel = os.path.relpath(d, cwd)
            for name in RULE_FILES:
                p = os.path.join(d, name)
                if os.path.isfile(p):
                    out.append((p, f"{rel}/**"))
        for e in entries:
            sub = os.path.join(d, e)
            if (os.path.isdir(sub) and e not in SKIP_DIRS
                    and not e.startswith(".")
                    and not os.path.exists(os.path.join(sub, ".git"))):
                walk(sub, depth + 1)
    walk(cwd, 0)
    return out


def dedupe(rules: list[dict]) -> list[dict]:
    """AGENTS.md is often a byte-for-byte copy of CLAUDE.md; one judgment
    per distinct instruction, first source wins the citation."""
    seen, out = set(), []
    for r in rules:
        key = " ".join(r["text"].lower().split())
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def load_rules(cwd: str) -> tuple[list[dict], dict]:
    """Rubric where one exists, markdown elsewhere; rubric project rules win
    an id clash against the global rubric, and markdown only fills the domain
    a rubric doesn't cover."""
    meta = rubric.load(cwd)
    rules = list(meta["rules"])
    if not meta["has_project"]:
        for name in RULE_FILES:
            rules += parse_rules(os.path.join(cwd, name))
        for d in RULE_DIRS:
            path = os.path.join(cwd, d)
            if os.path.isdir(path):
                for fn in sorted(os.listdir(path)):
                    if fn.endswith((".md", ".mdc")):
                        rules += parse_rules(os.path.join(path, fn),
                                             base_label=f"{d}/{fn}")
        for path, scope in nested_files(cwd):
            rules += parse_rules(path,
                                 base_label=os.path.relpath(path, cwd),
                                 file_scope=[scope])
    if not meta["has_global"]:
        for path in GLOBAL_RULE_FILES:
            rules += parse_rules(path, base_label="~/" + os.path.relpath(
                path, os.path.expanduser("~")))
    return dedupe(rules), meta


def relative(path: str, cwd: str) -> str:
    try:
        return os.path.relpath(path, cwd)
    except ValueError:
        return path


def last_user_prompt(transcript_path: str | None) -> str:
    """What the user last asked for — rules like "don't touch generated
    files" only mean something against the task."""
    if not transcript_path:
        return ""
    try:
        with open(transcript_path, errors="replace") as f:
            lines = f.readlines()[-400:]
    except OSError:
        return ""
    for line in reversed(lines):
        if len(line) > 500_000:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") != "user" or d.get("isSidechain"):
            continue
        c = (d.get("message") or {}).get("content")
        text = c if isinstance(c, str) else ""
        if isinstance(c, list):
            text = "\n".join(b.get("text", "") for b in c
                             if isinstance(b, dict) and b.get("type") == "text")
        text = (text or "").strip()
        if text and not text.startswith(("<", "/", "#")):
            return text[:MAX_TASK_CHARS]
    return ""


def edit_hunks(inp: dict) -> str:
    """Old→new per edit: rules about *removing* something need both sides."""
    if isinstance(inp.get("edits"), list):  # MultiEdit
        parts = []
        for e in inp["edits"]:
            if isinstance(e, dict):
                hunk = ""
                if e.get("old_string"):
                    hunk += f"REMOVED:\n{e['old_string']}\n"
                if e.get("new_string"):
                    hunk += f"ADDED:\n{e['new_string']}"
                parts.append(hunk)
        return "\n\n".join(p for p in parts if p)
    old, new = inp.get("old_string"), inp.get("new_string")
    if old is not None or new is not None:  # Edit
        hunk = ""
        if old:
            hunk += f"REMOVED:\n{old}\n"
        if new:
            hunk += f"ADDED:\n{new}"
        return hunk
    return inp.get("content") or inp.get("new_source") or ""


def rule_question(rule: dict) -> dict | None:
    """A rubric model rule carries its own question; a markdown-derived rule
    gets the generic one."""
    q = rubric.jev_question(rule)
    if q is not None:
        return q
    return {"type": "noul",
            "instructions": "Does this edit violate the repository rule: "
                            f"\"{rule['text']}\"?"}


def verdict(rule: dict, answer: dict | None) -> tuple[float, str | None]:
    """(violation probability, picked-label) whatever the question shape."""
    if (rule["check"] or {}).get("question"):
        return rubric.violation_probability(rule, answer)
    p = (answer or {}).get("noul")
    return (p if isinstance(p, (int, float)) else 0.0), None


# --- per-session state: block counts, accumulated hunks, turn bookkeeping ---

def session_path(session_id: str) -> str:
    safe = re.sub(r"[^\w-]", "_", session_id or "unknown")
    return os.path.join(BLOCK_DIR, f"{safe}.json")


def session_state(session_id: str) -> dict:
    try:
        with open(session_path(session_id)) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"blocks": {}, "hunks": [], "files": [], "stop_blocks": 0}
    if "blocks" not in data:  # pre-rubric format was a bare counts dict
        return {"blocks": data, "hunks": [], "files": [], "stop_blocks": 0}
    return data


def save_state(session_id: str, state: dict) -> None:
    try:
        os.makedirs(BLOCK_DIR, exist_ok=True)
        with open(session_path(session_id), "w") as f:
            json.dump(state, f)
    except OSError:
        pass


def record_hunk(state: dict, rel: str, hunk: str) -> None:
    """What the agent changed, kept for the Stop-time turn check."""
    total = sum(len(h) for h in state["hunks"])
    room = MAX_TURN_CHARS - total
    if room <= 0:
        return
    state["hunks"].append(f"--- {rel}\n{hunk[:min(MAX_HUNK_CHARS, room)]}")
    if rel not in state["files"]:
        state["files"].append(rel)


def log_decision(event: dict, answers: dict, probs: dict, violations: list,
                 n_rules: int, n_scoped_out: int, phase: str) -> None:
    try:
        with open(DEFAULT_LOG, "a") as f:
            f.write(json.dumps({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "kind": "rules",
                "phase": phase,
                "session_id": event.get("session_id"),
                "cwd": event.get("cwd"),
                "file": (event.get("tool_input") or {}).get("file_path"),
                "n_rules": n_rules,
                "n_scoped_out": n_scoped_out,
                "probs": probs,
                "violations": violations,
                "answers": answers,
            }) + "\n")
    except OSError:
        pass


def cite(v: dict) -> str:
    text = " ".join(v["text"].split())
    if len(text) > 220:
        text = text[:217] + "..."
    where = f"{v['file']} line {v['line']}" if v.get("line") else v["file"]
    judged = f" Judged: {v['label']}." if v.get("label") else ""
    return (f"- Rule \"{v['rule']}\" from {where}: "
            f"\"{text}\" ({v['prob']:.2f}){judged}")


def ask_rules(state_text: str, rules: list[dict]) -> dict:
    """One batched request, questions keyed by rule id."""
    if not rules:
        return {}
    questions, seen = {}, set()
    for r in rules:
        key = r["id"]
        n = 2
        while key in seen:
            key = f"{r['id']}-{n}"
            n += 1
        seen.add(key)
        r["_qkey"] = key
        questions[key] = rule_question(r)
    return jev.ask(state_text, questions)


def collect_verdicts(rules: list[dict], answers: dict,
                     act: float, flag: float) -> tuple[list[dict], dict]:
    """(hits at or above flag, every rule's probability for calibration)."""
    hits, probs = [], {}
    for r in rules:
        p, label = verdict(r, answers.get(r.get("_qkey") or r["id"]))
        probs[r["id"]] = round(p, 3)
        if p >= flag:
            hits.append({"rule": r["id"], "text": r["text"],
                         "file": r["file"], "line": r.get("line", 0),
                         "prob": round(p, 2),
                         "band": "act" if p >= act else "flag",
                         "label": label})
    return hits, probs


def model_rules(rules: list[dict], phase: str) -> list[dict]:
    """Only the judge's share: active model rules for this phase. Lint,
    deferred and unenforceable rules are never sent to the model."""
    return [r for r in rules if r["status"] == "active"
            and r["check"]["type"] == "model" and r.get("when") == phase]


def scoped_rules(rules: list[dict], phase: str, files: list[str]) -> list[dict]:
    """The questions one request carries: model rules for the phase whose
    scope covers a changed file, capped after scoping so a scoped rule is
    never crowded out by unscoped ones loaded before it."""
    hit = [r for r in model_rules(rules, phase)
           if not r["scope"] or any(glob_match(f, r["scope"]) for f in files)]
    # A rule written for this path outranks a repo-wide one, and the repo's
    # own rules outrank the user's global ones.
    hit.sort(key=lambda r: (not r["scope"], r["file"].startswith("~/")))
    return hit[:MAX_RULES]


def judge_edit(rel: str, hunk: str, task: str, in_scope: list[dict],
               act: float = ACT, flag: float = FLAG) -> tuple[list[dict], dict, dict]:
    """One judged edit, no session side effects: (hits, probs, answers).
    The hook and the eval harness share this so they measure the same thing."""
    parts = [f"File: {rel}"]
    if task:
        parts.append(f"The user's current request: {task}")
    parts.append(f"The edit:\n{hunk[:MAX_STATE_CHARS]}")
    answers = ask_rules("\n\n".join(parts), in_scope)
    hits, probs = collect_verdicts(in_scope, answers, act, flag)
    return hits, probs, answers


def stale_notice(meta: dict, state: dict) -> str | None:
    if meta.get("stale") and not state.get("stale_warned"):
        state["stale_warned"] = True
        return ("rubric is stale (an instruction file changed since it was "
                "compiled) — run /jev:rules-compile")
    return None


def handle_edit(event: dict) -> dict:
    inp = event.get("tool_input") or {}
    cwd = event.get("cwd") or os.getcwd()
    file_path = inp.get("file_path") or ""
    rel = relative(file_path, cwd)
    if EXCLUDED.search(rel):
        return {}
    rules, meta = load_rules(cwd)
    if not rules:
        return {}
    in_scope = scoped_rules(rules, "edit", [rel])
    state = edit_hunks(inp).strip()
    if not state:
        return {}
    sid = event.get("session_id") or "unknown"
    sstate = session_state(sid)
    record_hunk(sstate, rel, state)
    out = {}
    note = stale_notice(meta, sstate)
    if note:
        out["systemMessage"] = f"[jev rules] {note}"
    if not in_scope:
        save_state(sid, sstate)
        if out:
            return out
        return {}

    task = last_user_prompt(event.get("transcript_path"))
    t = meta["thresholds"] or {}
    act, flag = t.get("act", ACT), t.get("flag", FLAG)
    hits, probs, answers = judge_edit(rel, state, task, in_scope, act, flag)
    acting, flagged = [], []
    for v in hits:
        key = f"{v['rule']}|{rel}"
        if v["band"] == "act" and sstate["blocks"].get(key, 0) < MAX_BLOCKS:
            sstate["blocks"][key] = sstate["blocks"].get(key, 0) + 1
            acting.append(v)
        else:
            flagged.append(v)
    save_state(sid, sstate)
    log_decision(event, answers, probs,
                 [{k: v[k] for k in ("rule", "file", "line", "prob", "band")}
                  for v in hits],
                 len(rules), len(rules) - len(in_scope), "edit")

    if flagged:
        listed = ", ".join(f"{v['rule']} {v['prob']:.2f}" for v in flagged)
        flag_msg = (f"[jev rules] uncertain about {listed} on "
                    f"{rel} — not sent to the agent")
        out["systemMessage"] = (out["systemMessage"] + "  " + flag_msg
                                if out.get("systemMessage") else flag_msg)
    if acting:
        lines = ["This edit appears to break a rule from this "
                 "repository's instructions."]
        lines += [cite(v) for v in acting]
        lines.append(f"Repair {rel} now, then continue with the task.")
        out["decision"] = "block"
        out["reason"] = "\n".join(lines)
    return out


def handle_stop(event: dict) -> dict:
    """Turn rules judge the session's changes as a whole — the questions a
    per-edit hunk can't answer (scope creep, an abstraction with one caller,
    a file that grew past its cap)."""
    sid = event.get("session_id") or "unknown"
    sstate = session_state(sid)
    if not sstate["hunks"]:
        return {}
    cwd = event.get("cwd") or os.getcwd()
    rules, meta = load_rules(cwd)
    turn_rules = scoped_rules(rules, "turn", sstate["files"])
    if not turn_rules:
        return {}

    task = last_user_prompt(event.get("transcript_path"))
    diff = "\n\n".join(sstate["hunks"])
    parts = [f"Files changed this session: {', '.join(sstate['files'])}"]
    if task:
        parts.append(f"The user's current request: {task}")
    parts.append(f"The changes:\n{diff[:MAX_TURN_CHARS]}")
    answers = ask_rules("\n\n".join(parts), turn_rules)

    t = meta["thresholds"] or {}
    act, flag = t.get("act", ACT), t.get("flag", FLAG)
    hits, probs = collect_verdicts(turn_rules, answers, act, flag)
    already = bool(event.get("stop_hook_active"))
    acting, flagged = [], []
    for v in hits:
        if (v["band"] == "act" and not already
                and sstate["stop_blocks"] < MAX_STOP_BLOCKS):
            sstate["stop_blocks"] += 1
            acting.append(v)
        else:
            flagged.append(v)
    save_state(sid, sstate)
    log_decision(event, answers, probs,
                 [{k: v[k] for k in ("rule", "file", "line", "prob", "band")}
                  for v in hits],
                 len(rules), len(rules) - len(turn_rules), "turn")

    out = {}
    if flagged:
        listed = ", ".join(f"{v['rule']} {v['prob']:.2f}" for v in flagged)
        out["systemMessage"] = (f"[jev rules] uncertain about {listed} at "
                                "end of turn — not sent to the agent")
    if acting:
        files = ", ".join(sstate["files"])
        lines = ["The changes this turn appear to break a rule from this "
                 "repository's instructions."]
        lines += [cite(v) for v in acting]
        lines.append(f"Repair {files} before you finish. Keep the fix to "
                     "what the rule asks.")
        out["decision"] = "block"
        out["reason"] = "\n".join(lines)
    return out


def main() -> None:
    try:
        event = json.load(sys.stdin)
        name = event.get("hook_event_name") or "PostToolUse"
        out = handle_stop(event) if name == "Stop" else handle_edit(event)
        if out:
            json.dump(out, sys.stdout)
            sys.stdout.write("\n")
    except Exception:
        return  # fail open


if __name__ == "__main__":
    main()
    sys.exit(0)
