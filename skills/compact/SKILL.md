---
name: compact
description: >
  Compact the current session's context with Jev instead of an LLM summary.
  Jev judges each transcript block keep, truncate or drop, and the kept blocks
  survive verbatim. Use when the user asks to compact, free up context, or run
  /claude-jev:compact. Do not use for Claude Code's own /compact.
---

# Jev compaction

Run:

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
