---
description: Compact context with Jev — it picks what still matters, nothing is summarized by an LLM
---

Run:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compactor.py prepare
```

Its output says how many transcript blocks Jev kept and how much smaller the
result is. Relay that one line to the user, then tell them to run `/clear` to
finish: the kept context is re-injected verbatim when the fresh session starts.
If `prepare` printed an error, report it and stop — do not improvise a digest.
