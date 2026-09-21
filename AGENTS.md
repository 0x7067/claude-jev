# claude-jev

A Claude Code plugin. Five hooks send small judgments to TypeSafe's Jev, a
System One model that returns typed answers instead of text. `README.md`
explains what each hook decides and why. Read it before changing behavior.

## Layout

| Path | What lives there |
|---|---|
| `scripts/jev.py` | API client and CLI. Every other script imports it. |
| `scripts/prompt_router.py` | `UserPromptSubmit` — routing hint |
| `scripts/subagent_router.py` | `PreToolUse` on `Agent\|Task` — sets subagent model |
| `scripts/rules.py` | `PostToolUse` on edits, and `Stop` — rule enforcement |
| `scripts/compactor.py` | `SessionStart` on `compact`/`clear`, the `rows` bridge, plus `prepare` CLI |
| `hooks/register.ts` | Experimental function-hooks module: `session.compact` -> `compactor.py rows`. A bridge, not a second implementation. |
| `scripts/observed.py` | Scores what a past turn actually did |
| `scripts/stats.py` | `/claude-jev:stats` — scores live decisions |
| `eval/` | Offline measurement. See `eval/README.md`. |
| `skills/` | User-facing entry points. `/claude-jev:<dir name>`. |
| `hooks/hooks.json` | Hook registration. New hook means an entry here. `modules` names the function-hooks module; older Claude Code ignores the key. |

## Invariants

- **Hooks fail open.** A hook exits 0 and prints nothing on any error, missing
  key, or timeout. Keep the `except Exception: return` at the top of every
  hook `main`. Never add a path where a failure blocks or corrupts a session.
  `compactor.py prepare` is the exception: it runs as a CLI and prints errors.
- **Python 3 standard library only.** No dependency file, no third-party
  imports. `urllib.request` is the HTTP client. The one non-Python file,
  `hooks/register.ts`, exists because Claude Code loads function-hook modules
  as JavaScript; it holds no judgment, only the call into `compactor.py rows`
  and the fail-open fallthrough to `next(e)`. Keep it that way.
- **One environment variable:** `TYPESAFE_API_KEY`. Do not add another, and
  do not add a fallback name. Every other tunable is a module-level constant.
- **A constant carries a comment saying why it has that value.** Thresholds
  like `ACT`, `MIN_CONFIDENCE`, and `KEEP_THRESHOLD` came out of the evals.
  Changing one without eval evidence is a guess.
- **`scripts/observed.py` is the shared scorer.** `eval/replay.py` and
  `scripts/stats.py` both call it. Editing it moves every accuracy number in
  `README.md`.
- Hook scripts import siblings through `sys.path.insert(0, dirname(__file__))`.
  Keep that, because Claude Code runs them from arbitrary directories.

## Conventions

- Each script's module docstring states the hook it serves, the fail-open
  contract, and the env var. Keep that shape when you add one.
- Question definitions live in `scripts/jev.py` (`intent_bundle`,
  `subagent_bundle`) or next to the hook that asks them. Put the meaning in
  the `instructions` and `criteria` text — Jev never sees the key names.
- Write rules in this file as bullets, one instruction each. `rules.py` parses
  instruction files bullet by bullet, and a rule buried inside a prose
  paragraph classifies poorly.
- User-facing entry points are skills under `skills/`, not commands. There is
  no `commands/` directory; do not add one.

## Verify

There is no test suite. After changing a script, run both:

```bash
python3 -m compileall -q scripts eval
echo '{"prompt":"hi","transcript_path":""}' | python3 scripts/prompt_router.py; echo "exit=$?"
```

Every hook must exit 0 on a malformed or empty event. Feed the script you
changed a matching JSON event on stdin and check the exit code.

The `rows` bridge answers bad input with `{"fallback": ...}` and exit 0:

```bash
echo '' | python3 scripts/compactor.py rows
```

To exercise the function-hooks module end to end, run a session with the
plugin loaded from disk, compact it, and read the debug log:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude -p "..." --session-id "$ID" --plugin-dir "$PWD"
claude -p "/compact" --resume "$ID" --plugin-dir "$PWD" -d
grep 'jev-compact\|core never ran' ~/.claude/debug/"$ID".txt
```

"a hook's N messages stand ... core never ran" means the summary was
replaced; "built-in summary runs" means the bridge fell through.

To measure a routing or threshold change, run the relevant eval and compare
against the table in `README.md`:

```bash
python3 eval/replay.py run --variant v7_no_unclear --sample 250
python3 eval/rules_eval.py run --sample 250
```

These call `api.typesafe.ai` with real past prompts and cost money. Ask before
running a full sweep.

## Data and numbers

- `eval/data/` and `eval/private/` are gitignored. They hold extracted
  transcripts and repo-specific cases, and they do not survive a clone. Do not
  commit them or write code that assumes they exist.
- Numbers in `README.md` and `eval/README.md` come from eval runs. Change one
  only with a run behind it, and say which run.
- Bump `version` in `.claude-plugin/plugin.json` for a behavior change.
