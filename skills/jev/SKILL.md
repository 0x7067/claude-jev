---
name: jev
description: >
  Offload small decisions to TypeSafe's Jev System One model instead of
  reasoning them out in text. Use when picking between a known set of options
  (which tool, which file, which approach), answering yes/no checks (is this
  done, is this ambiguous, is this safe to run), or rating something on a rubric
  (complexity, risk, quality). Jev returns typed values and probabilities in
  ~100–500 ms — cheaper and faster than generating reasoning text.
---

# Jev decision primitives

Jev evaluates a `state` (any text or JSON) against typed questions and returns
typed answers — no text generation, no parsing. Use it for snap judgments where
the answer space is known.

Requires `TYPESAFE_API_KEY` (or `TYPESAFE_AI_KEY`) in the environment. If unset,
make the call yourself — do not block on it.

## CLI

`${CLAUDE_PLUGIN_ROOT}/scripts/jev.py` (python3, stdlib only):

```bash
# Pick one option — prints {"choice": "...", "confidence": 0.8, "probabilities": {...}}
jev.py choose "Which search tool best fits this task?" "find where the retry timeout is set" \
  --opt 'Grep=search file contents for a string or regex' \
  --opt 'Glob=find files by name pattern' \
  --opt 'Explore=open-ended codebase exploration'

# Yes/no probability — prints {"noul": 0.93}
jev.py noul "Does this diff preserve the public API?" @diff.patch
jev.py noul "Is the user's request ambiguous enough to need clarification?" "make it faster"

# Ordered rubric — prints {"score": 1.4, "confidence": ...}
jev.py score "How risky is running this command?" "rm -rf build/" \
  --level 'safe — reversible, local, read-only-ish' \
  --level 'moderate — modifies state but recoverable' \
  --level 'dangerous — destructive or hard to undo'

# Raw request — full control over state and question set
echo '{"state": "...", "questions": {...}}' | jev.py ask
```

State args accept a literal string, `@file`, or `-` for stdin.

## When to use it

- **Choosing between candidates**: files to edit, libraries to use, commands to
  run, which of N search hits is the one the user meant. Pass the candidates as
  `--opt` and the situation as state.
- **Binary gates**: "is this task complete?", "does this need tests?", "is this
  a breaking change?" — `noul` returns a probability you can threshold in code.
- **Ambiguity checks**: unsure what the user wants? `noul` it; ask a clarifying
  question only when the probability says it's warranted.
- **Rubric judgments**: complexity, risk, relevance — `score` gives a weighted
  value plus confidence.

## How to ask well

- One focused judgment per question — the kind a knowledgeable person makes in
  a few seconds. Decompose multi-factor judgments into several questions.
- Write complete `instructions`; option keys are not shown to the model — put
  meaning in the `=DESC` part of each `--opt`.
- Check `confidence`: below ~0.55, treat the answer as a coin flip and fall
  back to your own judgment or ask the user.
- Fan out: several questions in one `ask` request evaluate in parallel against
  the same state — cheaper than sequential calls.

## What NOT to offload

Generating text, code, explanations, or plans. Jev only makes typed judgments;
writing is your job. Also skip it for decisions where the answer is already
deterministic in code (exact lookups, arithmetic).
