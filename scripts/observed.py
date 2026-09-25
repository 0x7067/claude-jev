#!/usr/bin/env python3
"""What a session actually did, read back from its transcript.

Shared by the eval harness (eval/replay.py) and the stats command
(scripts/stats.py) so both score a turn the same way. Labels here describe
observed behavior, not intent — they are evidence about a prediction, not a
verdict on it.

Whether a shell command wrote anything comes from Claude Code, not from
reading the command: a Bash result carries `bashEditDiff`, the file-state diff
Claude Code took around the command, naming the git-visible project files it
changed. That is the same notion of a write the live hook in `rules.py` uses.
The command-text patterns below are the fallback for transcripts whose Claude
Code predates the field, where they measure precision 0.25 against it.
"""

from __future__ import annotations

import json
import os
import re

EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
READ_TOOLS = {"Read", "Grep", "Glob", "NotebookRead"}

CMD_START = r"(?:^|[;&|]\s*|\n\s*|(?:then|else|do|{)\s+)"

BASH_DIFF_VERSION = (2, 1, 274)

BASH_WRITE = re.compile(
    CMD_START + r"(rm|mv|cp|mkdir|touch|patch|tee|install)\b"
    r"|sed\s+(?:-i|--in-place)\b|>>|(?<![0-9&])>(?!&)|<<\s*['\"]?[A-Z]"
)
BASH_OPS = re.compile(
    CMD_START + r"(npm|pnpm|yarn|bun|pip|uv|poetry|make|cargo|go|docker|kubectl|"
    r"gh|railway|vercel|pytest|jest|vitest|tsc|eslint|ruff|mypy|black|prettier|"
    r"terraform|ansible|systemctl|brew|claude)\b"
)
GIT_OPS = re.compile(
    r"\bgit\s+(commit|push|pull|fetch|merge|rebase|checkout|switch|"
    r"branch|tag|cherry-pick|reset|revert|stash|clone|add|worktree)\b"
)
GIT_READ = re.compile(r"\bgit\s+(log|diff|status|show|blame|describe|ls-files|remote)\b")
BASH_READ = re.compile(
    CMD_START + r"(cat|head|tail|less|more|grep|rg|ag|ls|find|fd|wc|jq|yq|awk|cut|"
    r"sort|uniq|stat|file|which|tree|column|diff|du|env|printenv|pwd|date)\b"
    r"|sed\s+-n"
)


def version_tuple(version: str | None) -> tuple[int, ...]:
    parts = []
    for piece in str(version or "").split(".")[:3]:
        digits = "".join(c for c in piece if c.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def reports_bash_diffs(version: str | None) -> bool:
    """Whether this session's Claude Code records what a shell command changed.
    2.1.274 is where `bashEditDiff` first appears in the transcript corpus;
    below it a missing field means "unknown", not "wrote nothing", so the
    command-text patterns still decide."""
    return version_tuple(version) >= BASH_DIFF_VERSION


def bash_changed_files(result: object) -> list[str]:
    """The project files Claude Code's own diff says one Bash command wrote.
    Gitignored paths and paths outside the project never appear in it."""
    if not isinstance(result, dict):
        return []
    diff = result.get("bashEditDiff")
    if not isinstance(diff, dict):
        return []
    found = [p for p in diff.get("changedFiles") or [] if isinstance(p, str)]
    found += [
        f["filePath"]
        for f in diff.get("files") or []
        if isinstance(f, dict) and isinstance(f.get("filePath"), str)
    ]
    return sorted(set(found))


def bash_kind(cmd: str) -> str:
    if not cmd:
        return "other"
    if GIT_READ.search(cmd) and not GIT_OPS.search(cmd):
        return "read"
    if GIT_OPS.search(cmd) or BASH_OPS.search(cmd):
        return "ops"
    if BASH_WRITE.search(cmd):
        return "write"
    if BASH_READ.search(cmd):
        return "read"
    return "other"


def prompt_text(msg: dict) -> str | None:
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return None


def is_real_prompt(txt: str) -> bool:
    """Drop injected context and slash commands — the hook skips those too."""
    if len(txt) < 3:
        return False
    return not txt.startswith(("<", "/", "#", "Caveat", "[Request interrupted"))


SYNTHETIC = re.compile(
    r"^(Another Claude session sent a message:"
    r"|Workspace boundary \(important\):"
    r"|Base directory for this skill:"
    r"|Continue from where you left off\."
    r"|Review this change for security vulnerabilities\."
    r"|You previously flagged these candidate vulnerabilities:"
    r"|Fabric actor message from"
    r"|\[Usage limit approaching"
    r"|\[Image:"
    r"|\[Request interrupted"
    r"|This session is being continued from"
    r"|Your task is to create a detailed summary"
    r"|Please continue the conversation from where"
    r"|Permission granted for:"
    r"|\[Your previous response had no visible output"
    r"|reply with exactly:|Reply with exactly:)",
    re.IGNORECASE,
)


def is_synthetic(txt: str) -> bool:
    return (
        bool(SYNTHETIC.match(txt))
        or "<teammate-message" in txt[:200]
        or "<agent-message" in txt[:200]
    )


def is_bash_result(result: object) -> bool:
    """Whether a tool result came from Bash, so a missing `bashEditDiff` on it
    means the command changed no project file. A result from another tool, or
    one Claude Code never finished writing, says nothing either way and leaves
    the turn to the command-text patterns."""
    return isinstance(result, dict) and "stdout" in result


def flush_tools(pending: list[dict], results: dict, version: str | None):
    """Hand back the tools of one turn with Claude Code's verdict on what each
    Bash call wrote. Results follow their tool call in the transcript, so the
    turn is buffered until its boundary and joined here."""
    diffed = reports_bash_diffs(version)
    for tool in pending:
        if tool["name"] == "Bash" and tool["id"] in results:
            tool["changed"] = results[tool["id"]]
            tool["diffed"] = diffed
        yield "tool", tool
    pending.clear()


def walk_session(path: str):
    """Yield (kind, payload) turns in order. kind is prompt | tool | text. A
    Bash tool's payload carries `changed`, the files Claude Code's diff says it
    wrote, and `diffed`, whether that verdict is available for this session."""
    version = None
    pending: list[dict] = []
    results: dict[str, list[str]] = {}
    with open(path, errors="replace") as f:
        for line in f:
            if len(line) > 500_000:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if version is None and isinstance(d.get("version"), str):
                version = d["version"]
            if d.get("isSidechain"):
                continue
            t = d.get("type")
            msg = d.get("message") or {}
            if t == "user":
                result = d.get("toolUseResult")
                if is_bash_result(result) and isinstance(msg.get("content"), list):
                    for b in msg["content"]:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            results[b.get("tool_use_id")] = bash_changed_files(result)
                txt = prompt_text(msg)
                if txt and is_real_prompt(txt.strip()):
                    yield from flush_tools(pending, results, version)
                    yield (
                        "prompt",
                        {"text": txt.strip(), "ts": d.get("timestamp"), "cwd": d.get("cwd")},
                    )
            elif t == "assistant":
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use":
                        pending.append(
                            {
                                "name": b.get("name", "?"),
                                "input": b.get("input") or {},
                                "id": b.get("id"),
                            }
                        )
                    elif b.get("type") == "text" and b.get("text"):
                        yield "text", {"text": b["text"]}
    yield from flush_tools(pending, results, version)


def summarize(tools: list[dict]) -> dict:
    n_edit = n_read = n_ops = 0
    files = set()
    for t in tools:
        name, inp = t["name"], t["input"]
        if name in EDIT_TOOLS:
            n_edit += 1
            if isinstance(inp.get("file_path"), str):
                files.add(inp["file_path"])
        elif name in READ_TOOLS:
            n_read += 1
        elif name == "Bash":
            k = bash_kind(inp.get("command") or "")
            changed = t.get("changed") or []
            if t.get("diffed"):
                k = "write" if changed else ("other" if k == "write" else k)
            if k == "write":
                n_edit += 1
                files.update(changed)
            elif k == "read":
                n_read += 1
            elif k == "ops":
                n_ops += 1
    return {"n_edit": n_edit, "n_read": n_read, "n_ops": n_ops, "n_files": len(files)}


def trace(tools: list[dict], limit: int = 12) -> list[str]:
    """Readable tool sequence, so a human can label what the turn really was."""
    out = []
    for t in tools[:limit]:
        name, inp = t["name"], t["input"]
        if name == "Bash":
            out.append("$ " + " ".join((inp.get("command") or "").split())[:80])
        elif name in EDIT_TOOLS or name in READ_TOOLS:
            arg = inp.get("file_path") or inp.get("pattern") or ""
            out.append(f"{name} {os.path.basename(str(arg))[:40]}")
        else:
            out.append(name)
    if len(tools) > limit:
        out.append(f"... +{len(tools) - limit} more")
    return out


def derive_label(tools: list[dict], s: dict) -> str:
    """Map observed behavior onto the router's intent vocabulary.

    `refactor` is deliberately absent: nothing in a transcript distinguishes a
    behavior-preserving restructure from a fix, so those rows land in fix or
    feature and the report treats refactor predictions as unscorable.
    """
    names = [t["name"] for t in tools]
    if not tools:
        return "chat"
    if "AskUserQuestion" in names[:2]:
        return "unclear"
    if s["n_edit"] > 0:
        substantial = s["n_files"] >= 3 or len(tools) >= 20 or "Agent" in names
        return "feature" if substantial else "fix"
    if s["n_ops"] > 0 and s["n_ops"] >= s["n_read"]:
        return "ops"
    return "lookup"


def scope_band(n_tools: int) -> str:

    if n_tools <= 2:
        return "trivial"
    if n_tools <= 9:
        return "small"
    return "substantial"


def segments(path: str) -> list[dict]:
    """Split a transcript into one segment per user prompt, each holding the
    tool calls that followed it."""
    out, cur = [], None
    last_text = ""
    try:
        turns = list(walk_session(path))
    except OSError:
        return []
    for kind, payload in turns:
        if kind == "prompt":
            if cur is not None:
                cur["next_assistant"] = last_text
                out.append(cur)
            cur = {"text": payload["text"], "ts": payload["ts"], "tools": []}
            last_text = ""
        elif cur is not None:
            if kind == "tool":
                cur["tools"].append(payload)
            else:
                last_text = payload["text"]
    if cur is not None:
        cur["next_assistant"] = last_text
        out.append(cur)
    for s in out:
        s.update(summarize(s["tools"]))
        s["label"] = derive_label(s["tools"], s)
        s["n_tools"] = len(s["tools"])
    return out
