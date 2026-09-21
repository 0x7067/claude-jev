---
name: stats
description: >
  Score the prompt router's live decisions against what the sessions actually
  did, from the hook's decision log. Use when the user asks how the router is
  performing, whether the hints are right, or runs /claude-jev:stats. This
  reports on past decisions; it does not classify anything new.
argument-hint: "[--days N] [--examples N]"
---

# Router stats

Pass the user's arguments through, or none:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/stats.py [--days N] [--examples N]
```

Show the output, then answer three things in a few sentences:

1. Is the router beating the constant-guess baseline printed alongside it? If
   the sample is under ~50 scorable hints, say the number is too small to read
   either way.
2. Are there harmful hints — cases where it said "no tools" and the session
   then used five or more? Any at all is worth naming.
3. If suppressed hints would have been correct, say so: `MIN_CONFIDENCE` in
   `scripts/prompt_router.py` may be set too high.

Do not re-run the classifier and do not edit anything, including the
thresholds question 3 raises. Changing one needs an eval run behind it
(`eval/replay.py`), not a stats read.
