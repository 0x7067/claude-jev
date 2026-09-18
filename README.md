# claude-jev

A Claude Code plugin that routes the token-burning decision-making —
classifying intent, choosing tools, routing — through
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model that
returns typed judgments instead of generating text.

Not an agentic-coding replacement: it doesn't write code. It makes the small
judgments cheaper.

## What you get

- **`UserPromptSubmit` hook** — each prompt is classified in one API call
  (intent × scope × needs-tools) and a one-line routing hint is injected as
  context. The previous turn goes into the classification, because most
  prompts are follow-ups. `lookup` → one targeted search; `fix` → focused edit
  + narrow verification; `feature` → brief plan first; `ops` → run it and
  report. Below 0.75 confidence, no hint. The "answer directly, no tools" hint
  fires only when a separate yes/no question is near-certain.
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
| `JEV_MIN_CONFIDENCE` | `0.75` | intent confidence floor for injecting hints |
| `JEV_MAX_QUIET` | `0.10` | a "no tools needed" hint requires needs_tools at or below this |
| `JEV_OFF` | unset | `1` disables the hook |

## Does it work?

`eval/` replays your own past sessions through the router and scores each
prediction against what the agent actually did next. On 1,613 real prompts:

| Variant | Coverage | Accuracy | Best constant guess | Lift | Harmful hints |
|---|---|---|---|---|---|
| v0 — as first published | 68% | 19.6% | 27.8% | −8.2 | 68 |
| v1 — + previous turn as context | 66% | 28.3% | 28.8% | −0.5 | 108 |
| v2 — − `needs_repo` | 65% | 28.3% | 28.4% | −0.1 | 111 |
| v3 — − `refactor` | 65% | 30.4% | 29.0% | +1.3 | 85 |
| v4 — gate the no-tools hint | 53% | 31.1% | 30.4% | +0.7 | 3 |
| v5 — 3-way / binary taxonomy | 66% / 39% | 58.8% / 75.4% | 64.7% / 82.6% | −5.9 / −7.2 | 102 / 69 |
| **v7 — shipped** | 42% | 34.6% | 29.3% | **+6.0** | **8** |

A harmful hint tells the agent to skip work it then needed: a "no tools"
routing hint followed by five or more tool calls. Accuracy is measured against
behavior derived from transcripts, not human labels, so treat the absolute
numbers as noisy and the deltas as the signal.

Reproduce it on your own history:

```bash
python3 eval/replay.py extract                     # your transcripts -> dataset
python3 eval/replay.py run --variant v7_no_unclear # cached; re-runs are free
python3 eval/replay.py report --variant v7_no_unclear --sweep
python3 eval/replay.py compare
```

The run sends your past prompts to `api.typesafe.ai`. Start with `--sample 250`
if that matters for your repos.

## Design notes

- The hook **fails open**: any error, missing key, or timeout produces no
  output and never blocks a prompt.
- Prompts are sent to `api.typesafe.ai` for classification. Slash commands,
  `#` lines, and prompts under 3 chars are skipped locally.
- The question bundle dropped `refactor`, `unclear`, and `needs_repo`.
  The first two never reached usable precision; a hardcoded "yes" beat
  `needs_repo` by 18 points.
- A smaller taxonomy scores higher and helps less. Collapsing to talk/read/act
  reaches 58.8%, but always guessing "act" reaches 64.7% — the model is
  reliable exactly where the default assumption already is.
- All routing logic lives in `scripts/prompt_router.py`; question definitions
  in `scripts/jev.py::intent_bundle`. If you edit either, re-run `eval/` —
  the shipped bundle is meant to stay identical to the measured one.
