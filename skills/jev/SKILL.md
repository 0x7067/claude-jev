---
name: jev
description: >
  Offload a snap decision to TypeSafe's Jev, a System One model that returns a
  typed answer with a probability in ~100–500 ms. Use when picking among a
  known set of options (which tool, which file, which approach), answering a
  yes/no check (is this done, is this ambiguous, is this safe to run), or
  rating something on a rubric (complexity, risk, quality). Do not use it to
  generate text, code, or plans — Jev returns values, not prose.
---

# Jev decision primitives

Jev evaluates a `state` (any text or JSON) against typed questions and returns
typed answers. No text generation, no output parsing.

Requires `TYPESAFE_API_KEY` and `python3`. If the key is unset the CLI exits 2
with `jev: set TYPESAFE_API_KEY` — make the judgment yourself and carry on.
Never block on this.

## CLI

`${CLAUDE_PLUGIN_ROOT}/scripts/jev.py`, stdlib only. State is a literal
string, `@file`, or `-` for stdin.

```bash
# Pick one option — prints {"choice": "...", "confidence": 0.8, "probabilities": {...}}
jev.py choose "Which search tool best fits this task?" "find where the retry timeout is set" \
  --opt 'Grep=search file contents for a string or regex' \
  --opt 'Glob=find files by name pattern' \
  --opt 'Explore=open-ended codebase exploration'

# Yes/no probability — prints {"noul": 0.93}
jev.py noul "Does this diff preserve the public API?" @diff.patch

# Ordered rubric, lowest level first — prints {"score": 1.4, "confidence": ...}
jev.py score "How risky is running this command?" "rm -rf build/" \
  --level 'safe — reversible, local, read-only-ish' \
  --level 'moderate — modifies state but recoverable' \
  --level 'dangerous — destructive or hard to undo'

# Raw request — several questions against one state, evaluated in parallel
echo '{"state": "...", "questions": {...}}' | jev.py ask
```

## Asking well

- One focused judgment per question — the kind a knowledgeable person makes in
  a few seconds. Split a multi-factor judgment into several questions and send
  them in one `ask`; that is one call, not several.
- Put the meaning in the text. Jev never sees the question key or the `--opt`
  name, only `instructions` and the `=DESC` half of each option.
- `choose` needs at least two `--opt`, `score` at least two `--level`.

## Using the answer

Read `confidence` before you act on it. Below about 0.55 the answer is a coin
flip: fall back to your own judgment, or ask the user if the decision is
theirs. A `noul` probability is meant to be thresholded, so pick the threshold
before you see the number.

Jev is advice, not authority. It does not widen what you are allowed to do — a
low risk score is not permission to run a destructive command, and a "yes,
this is done" does not replace the verification the task actually calls for.

Skip it entirely when the answer is already deterministic in code: exact
lookups, arithmetic, anything a grep settles.
