# claude-jev

A Claude Code plugin that routes the token-burning decision-making —
classifying intent, choosing tools, routing — through
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model that
returns typed judgments instead of generating text.

Not an agentic-coding replacement: it doesn't write code. It makes the small
judgments cheaper.

## What you get

- **`UserPromptSubmit` hook** — each prompt is classified in one API call
  (intent × scope × needs-repo-context) and a one-line routing hint is injected
  as context. `chat` → answer directly; `lookup` → one targeted search;
  `fix` → focused edit + narrow verification; `feature` → brief plan first;
  `unclear` → ask before working. Sub-0.55 confidence = no hint.
- **`jev` skill** — teaches the agent to offload snap decisions to the bundled
  CLI: choose between options (`choose`), yes/no gates (`noul`), rubric scores
  (`score`), or batched raw questions (`ask`).
- **`/jev:route <request>`** — classify a request on demand and get a handling
  plan.

## Setup

```bash
claude plugin marketplace add 0x7067/claude-jev
claude plugin install claude-jev@claude-jev
```

Set your key (either name works):

```bash
export TYPESAFE_API_KEY="..."   # or TYPESAFE_AI_KEY
```

Requires `python3` (stdlib only, no pip installs).

## Env vars

| Var | Default | Effect |
|---|---|---|
| `TYPESAFE_API_KEY` / `TYPESAFE_AI_KEY` | — | required; hook silently disables without it |
| `JEV_MODEL` | `jev-latest` | model id |
| `JEV_TIMEOUT` | `8` | HTTP timeout (s) |
| `JEV_MIN_CONFIDENCE` | `0.55` | intent confidence floor for injecting hints |
| `JEV_OFF` | unset | `1` disables the hook |

## Design notes

- The hook **fails open**: any error, missing key, or timeout produces no
  output and never blocks a prompt.
- Prompts are sent to `api.typesafe.ai` for classification. Slash commands,
  `#` lines, and prompts under 3 chars are skipped locally.
- All routing logic lives in `scripts/prompt_router.py`; question definitions
  in `scripts/jev.py::intent_bundle` — edit to taste.
