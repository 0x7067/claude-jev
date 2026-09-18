---
description: Classify a request with Jev and propose how to handle it
argument-hint: <request text>
---

Classify the following request by running:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/jev.py intent "$ARGUMENTS"
```

Then reply with, in this order:
1. The Jev answers (intent, confidence, scope, needs_tools) in one line.
2. A one-sentence handling plan implied by that classification.
3. If intent confidence is below 0.75: say the classification is weak and give
   the single most useful clarifying question to ask the user instead.

Request: $ARGUMENTS
