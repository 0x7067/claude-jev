# Subagent routing

Subagent routing runs on `PreToolUse` for `Agent|Task`. When the caller did not
set `model`, it may set `updatedInput.model` to a tier. Failures must never
block the spawn.

## Sub-features

- `subagent-explicit` leaves an already-set model alone and prints nothing.
- `subagent-fail-open` exits 0 with empty stdout when the key is missing or input is bad.
- `subagent-route` (out-of-band; live key) may emit `hookSpecificOutput.updatedInput.model`.
- `subagent-brief` (out-of-band; live key) denies a file-changing brief missing paths, acceptance criteria, verification command, or commit policy: `permissionDecision: deny` once per session per brief, then `systemMessage` only.

## How to get to it (user POV)

- Spawn an Agent/Task tool without an explicit model in Claude Code.
- Spawn one with `model` already set (explicit wins).
- Run the plugin without `TYPESAFE_API_KEY`.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` if the recipe needs exported run vars.

- **Explicit model.** Pass a model in tool input. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers","subagent_type":"Explore","model":"haiku"}}'`. Exit code `0` and stdout empty.
- **Fail open no key.** Unset the key and omit model. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers of parse_opt","subagent_type":"Explore"}}'`. Exit code `0` and stdout empty.
- **Malformed.** Feed non-JSON. Run `printf 'not-json\n' | control-jev hook subagent_router`. Exit code `0` and stdout empty.
- **Live route (out-of-band).** Needs `TYPESAFE_API_KEY` on a machine that can call Jev. Omit model and run the Explore prompt above. Exit code `0`; if confidence ≥ 0.75, stdout is JSON containing `updatedInput.model` in `haiku|sonnet|opus|fable`.
- **Live brief check (out-of-band).** Omit model and pass a writing brief with no paths or commit policy, e.g. `"Rename the helper in the parser module and update callers"`. First run: stdout JSON with `permissionDecision: "deny"` and a reason naming the missing parts. Same input again with the same `session_id`: no deny, `systemMessage` says "spawned anyway".
- **Proof.** Save stdout/stderr/exit for explicit and fail-open cases under `subagent-routing/`. Both no-key cases show empty stdout and exit `0`.

## Gotchas

- An explicit `model` skips the tier question but not the brief check.
- An explicit `model` always wins; do not expect `updatedInput` on that path.
- Below `MIN_CONFIDENCE` (0.75) a live call also prints nothing — empty stdout is not only a missing-key signal.
- Do not mark the live route verified when the key was unset; that path is out-of-band.
