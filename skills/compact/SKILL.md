---
name: compact
description: >
  Compact the current session's context with Jev instead of an LLM summary.
  Jev judges each transcript block keep, truncate or drop, and the kept blocks
  survive verbatim. Use when the user asks to compact, free up context, or run
  /claude-jev:compact. Do not use for Claude Code's own /compact.
---

# Jev compaction

If the session runs with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` on Claude Code
2.1.278 or later, tell the user to run the built-in `/compact` instead: the
plugin's hooks module replaces the summary with Jev's selection there, in one
step and with no `/clear`. You cannot tell from inside the session whether the
flag is on, so say that in one line and let the user choose.

Otherwise, run:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compactor.py prepare
```

`prepare` judges the transcript, writes the kept blocks to a digest, and
prints one line: how many blocks Jev kept, how many it kept only as truncated
heads, and how much smaller the result is.

Then:

- **It printed a plan.** Relay that line and tell the user to run `/clear`.
  The digest is re-injected verbatim when the fresh session starts. You cannot
  run `/clear` yourself, and the digest expires 10 minutes after `prepare`.
- **It says the selection wasn't worth applying.** Relay that and stop. The
  selection did not shrink the transcript enough, and compacting anyway costs
  a re-cached prompt for no gain.
- **It printed an error.** Report it and stop. Never hand-write a digest or
  summarize the transcript yourself — a generated summary is the thing this
  replaces.

Done when you have relayed `prepare`'s output and, on the first case, told the
user to run `/clear`.
