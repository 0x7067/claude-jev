# Subagent routing

Subagent routing runs on `PreToolUse` for `Agent|Task`. When nothing else chose
the spawn's model, it sets `updatedInput.model` to the cheapest tier where Jev
puts at most a 0.10 chance on the task needing a stronger one. It also checks
every brief. Failures must never block the spawn.

## Sub-features

- `subagent-explicit` leaves an already-set model alone and prints nothing.
- `subagent-own-model` leaves a spawn alone when its model is chosen elsewhere: `CLAUDE_CODE_SUBAGENT_MODEL` set (and not `inherit`), an agent definition with a `model:` other than `inherit`, the fixed-model built-ins `statusline-setup` and `claude-code-guide`, or an agent type whose definition the hook cannot find. It still checks the brief.
- `subagent-fail-open` exits 0 with empty stdout when the key is missing or input is bad.
- `subagent-route` (out-of-band; live key) may emit `hookSpecificOutput.updatedInput.model`.
- `subagent-tier-criteria` reads a subagent tier's description from the user's `CLAUDE.md` "Delegating to sub-agents" bullets, which is the Claude config dir's file — under this harness, `$VERIFY_HOME/.claude/CLAUDE.md`.
- `subagent-brief` (out-of-band; live key) denies a file-changing brief missing paths, acceptance criteria, verification command, or commit policy: `permissionDecision: deny` once per session per brief, then `systemMessage` only.
- `subagent-toggle-off` makes no Jev call when `subagentRouter` ("Subagent model routing" in `/claude-jev` or `/config`) is off.

## How to get to it (user POV)

- Spawn an Agent/Task tool without an explicit model in Claude Code. `general-purpose`, `Explore`, `Plan`, `claude`, and an omitted type are routed.
- Spawn a custom agent defined in `.claude/agents/` (found by walking up from the event's `cwd`), `~/.claude/agents/`, or an installed plugin's `agents/` (`plugin:path:name`).
- Spawn one with `model` already set (explicit wins).
- Spawn one without a model while your `CLAUDE.md` defines tier criteria (its text is what Jev reads).
- Run the plugin without `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` if the recipe needs exported run vars.

- **Explicit model.** Pass a model in tool input. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers","subagent_type":"Explore","model":"haiku"}}'`. Exit code `0` and stdout empty.
- **Fail open no key.** Unset the key and omit model. Run `control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers of parse_opt","subagent_type":"Explore"}}'`. Exit code `0` and stdout empty.
- **Malformed.** Feed non-JSON. Run `printf 'not-json\n' | control-jev hook subagent_router`. Exit code `0` and stdout empty.
- **Live route (out-of-band).** Needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` on a machine that can call Jev (Claude Code is not required — `control-jev` drives it). Run `control-jev hook subagent_router '{"tool_input":{"prompt":"grep the repo for the literal string parse_opt and list the files that contain it, nothing else","subagent_type":"Explore"},"session_id":"liveroute1"}'`. Exit code `0`, and stdout is `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...,"model":"haiku"}},"systemMessage":"[jev router] subagent → haiku (p=1.00)"}`. The tier is one of `haiku|sonnet|opus|fable` (`TIERS` in `adapters/afk/src/shared/questions.ts`, read from the tier criteria). `p=` is Jev's probability for the chosen tier, not a confidence gate: the rule walks the tiers cheapest first and stops once the probability left on stronger tiers is ≤ 0.10, so `sonnet (p=0.67)` is a normal pick.
- **Live brief check (out-of-band).** `control-jev hook subagent_router '{"tool_input":{"prompt":"Rename the helper in the parser module and update callers","subagent_type":"general-purpose"},"session_id":"livebrief1"}'`, sent twice with the same `session_id`. First send: `"permissionDecision": "deny"` with a reason naming the four missing parts (files or paths, acceptance criteria, verification command, commit policy). Second send: no `permissionDecision`, `updatedInput.model` set, and a two-line `systemMessage`: `[jev router] brief still missing … — spawned anyway (denied once already)` then `[jev router] subagent → <tier> (p=…)`.
- **Own model (out-of-band).** Plant `/tmp/proj/.claude/agents/pinned-agent.md` with frontmatter `name: pinned-agent` and `model: haiku`, then run `control-jev hook subagent_router '{"cwd":"/tmp/proj","tool_input":{"prompt":"grep the repo for the literal string parse_opt and list the files that contain it, nothing else","subagent_type":"pinned-agent"},"session_id":"pinned1"}'`. Exit `0` and stdout empty. The last `jev-router-log.jsonl` row has `model_routed: null` and no `model_tier` answer, only the five `brief_*` answers.
- **Toggle off.** Export a fake key so a call, if made, is logged: `export OPENROUTER_API_KEY=sk-or-v1-fake` (a bare assignment does not reach `control-jev`). Count lines in `$VERIFY_HOME/.claude/jev-calls.jsonl`, run `CLAUDE_PLUGIN_OPTION_SUBAGENTROUTER=false control-jev hook subagent_router '{"tool_input":{"prompt":"search for callers of parse_opt","subagent_type":"Explore"}}'`, and count again. Exit code `0`, stdout empty, and no line added. The same run without the variable adds one line (a failed call on the fake key), which proves the count can move. Save both counts as `subagent-routing/toggle-off.txt`. Run `unset OPENROUTER_API_KEY` afterward; the no-key recipes need it unset.
- **Tier criteria.** Write `$VERIFY_HOME/.claude/CLAUDE.md` containing a `Delegating to sub-agents` heading with `- haiku: <text>` style bullets, then run either live recipe. Exit code `0`; the observable is the `subagent` row in `jev-router-log.jsonl` — with your file present the tier question is asked against your own descriptions. Delete the file before the no-key recipes; they do not read it.
- **Proof.** Save stdout/stderr/exit for explicit and fail-open cases under `subagent-routing/`. Both no-key cases show empty stdout and exit `0`. `subagent-routing/toggle-off.txt` shows 0 calls with the toggle off and a rise with it on. With a key, save the routed stdout and the two brief sends as `subagent-routing/live-route.txt`, and the own-model run as `subagent-routing/pinned-agent.txt`.

## Gotchas

- An explicit `model` skips the tier question but not the brief check.
- A whitespace-only `tool_input.prompt` returns before any Jev call and writes no log row — it is a skip, not a fail-open signal.
- The tier-criteria heading also matches a `subagents` spelling (normalized to `sub-agents`), and a `plugin:<path>:<name>` type resolves under `$CLAUDE_CONFIG_DIR/plugins/cache/<marketplace>/<plugin>/<version>/agents/`.
- An explicit `model` always wins; do not expect `updatedInput` on that path.
- The **Explicit model** recipe's empty stdout is not evidence that the model was left alone: with no key every input prints empty. It is a no-crash proof only; the deny path still runs on that event, so an explicit model plus an incomplete brief can print a denial.
- A brief is judged missing only when `brief_writes` clears `MIN_CONFIDENCE` (0.75) and each named part is at or under `BRIEF_MISSING` (0.25). A "confidently missing" part scoring 0.30 lists nothing and prints nothing.
- On the second send of a brief that also gets routed, `systemMessage` carries both notes, one per line. Before 0.25.0 the route line replaced the missing-parts line.
- Denial state has no file of its own: `already_denied` re-reads `jev-router-log.jsonl` for a `kind: "subagent"` row with the same `session_id`, `brief_denied: true`, and the same first 200 characters of prompt. A missing or truncated log resets the denial. Both `session_id`s being absent also match (`None == None`).
- Tier criteria come from `CLAUDE.md` **in the config dir the run uses**, so under `control-jev` the real `~/.claude/CLAUDE.md` is never read and every live route proof silently runs on shipped defaults unless you plant the file.
- The toggle count rises by one row per hook run on a fake `sk-or-` key. The hook's client (`adapters/afk/src/shared/jev-client.ts`) makes one attempt and logs one row for an `HTTP 401` or a network error alike; only `scripts/jev.py` retries under `FAST_FAIL`, and no hook uses it.
- A routable spawn with a live key routes whenever Jev returns tier probabilities, so empty stdout with a key means an own-model spawn, a toggle, or a failed call. It does not mean low confidence. The explicit read-only "grep for a literal, list the files" brief routes to `haiku` at `p=1.00`.
- The own-model lookup reads definition files on every spawn: project `.claude/agents/` starting at the event's `cwd` and walking up to 11 ancestors (12 candidate dirs total), then `$CLAUDE_CONFIG_DIR/agents/` (`$VERIFY_HOME/.claude/agents/` under this harness), then `$CLAUDE_CONFIG_DIR/plugins/cache/*/<plugin>/*/agents/` for a `plugin:…` type. A stray definition in any directory above `cwd` changes the result, and the real `~/.claude/agents/` is never read under `control-jev`.
- A brief-check denial is spent per `(session_id, prompt-head)` pair, read back from `jev-router-log.jsonl`. Reusing a `session_id` across live brief probes turns a later denial into `systemMessage` only.
- Do not mark the live route verified when the key was unset; that path is out-of-band.
