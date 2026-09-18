---
description: Score the router's live decisions against what your sessions actually did
argument-hint: "[--days N] [--examples N]"
---

Run:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/stats.py $ARGUMENTS
```

Show the output, then answer three things in a few sentences:

1. Is the router beating the constant-guess baseline printed alongside it? If
   the sample is under ~50 scorable hints, say the number is too small to read
   either way.
2. Are there harmful hints — cases where it said "no tools" and the session
   then used five or more? Any at all is worth naming.
3. If suppressed hints would have been correct, say so: `JEV_MIN_CONFIDENCE`
   may be set too high.

Do not re-run the classifier or edit anything. This reports on decisions
already made.
