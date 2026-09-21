# Claude Code compaction: what the harness offers, and how to use it here

Research notes, 2026-09-21. Sources: the official docs at code.claude.com
(fetched as Markdown), the changelog for 2.1.x, and the strings and code of
the installed native binary, Claude Code 2.1.278. Each fact below is tagged:

- **Documented**: stated on a docs page; the URL is given.
- **Binary**: read from the 2.1.278 binary, not on any docs page. Stable
  enough to rely on for a fail-open hook, not for a contract.
- **Experimental**: gated by a rollout flag or an env var, undocumented, and
  liable to change or vanish.

The point of the research is the friction in today's flow: `/claude-jev:compact`
runs `prepare`, then the user must type `/clear` within ten minutes so that a
`SessionStart` hook re-injects the digest. Auto-compaction cannot use that
path at all; it gets Jev's blocks appended on top of the built-in summary.

## The short version

1. **Move the judgment to `PreCompact`.** Both `/compact` and auto-compaction
   fire it, it carries `transcript_path` and `session_id`, and its stdout is
   appended to the summarizer's instructions in 2.1.278 (Binary). The
   existing `SessionStart` `compact` hook then injects the digest verbatim
   (Documented). Result: one built-in command, or no command at all, and no
   `/clear`, no TTL, no compaction turn to cut out of the transcript.
2. **Keep the digest under 10,000 characters including its header.** Above
   that, Claude Code writes `additionalContext` to a file and hands Claude a
   path plus a 2,000-character preview (Documented). `TARGET_CHARS = 8000`
   is inside the limit; the wrapper text must stay inside it too.
3. **The real replacement exists but is gated.** A plugin "hooks module" can
   hook `session.compact` and return the messages to keep; the built-in
   summary then never runs. It also gets `$.session.compact()` to trigger a
   compaction between turns. Rollout flag off by default, env override
   `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, API undocumented, module is
   JavaScript (Experimental). Worth a prototype branch, not a release.

## 1. Hook events around compaction

### PreCompact (Documented, with one Binary addition)

https://code.claude.com/docs/en/hooks.md, section "PreCompact".

- Matcher is the trigger: `manual` for `/compact`, `auto` for auto-compact.
- Input adds `trigger` and `custom_instructions` to the common fields
  (`session_id`, `transcript_path`, `cwd`, `permission_mode`). For `manual`,
  `custom_instructions` is what the user typed after `/compact`, or `null`.
- Exit 2, or JSON `{"decision":"block"}`, blocks compaction. Docs: "If
  compaction was triggered proactively before the context limit, Claude Code
  skips it and the conversation continues uncompacted. If compaction was
  triggered to recover from a context-limit error already returned by the
  API, the underlying error surfaces and the current request fails." So
  blocking `auto` is not a way to substitute our own compaction.
- `systemMessage` and `continue` are discarded. No `additionalContext`.
- **Binary:** in 2.1.278 the trimmed stdout of every PreCompact hook that
  succeeded and did not block is joined with blank lines and appended to the
  summarizer's custom instructions, after whatever the user passed to
  `/compact`. The docs say stdout for "most events" goes to the debug log,
  so treat this as unpromised. A hook that prints nothing loses nothing.
- **Binary:** the summarizer prompt says "There may be additional
  summarization instructions provided in the included context" and gives two
  examples, a `## Compact Instructions` heading and a `# Summary instructions`
  heading. This is the mechanism behind the documented advice to add a
  "Compact Instructions" section to CLAUDE.md
  (https://code.claude.com/docs/en/how-claude-code-works.md).
- **Binary:** "Summarize from here" and "Summarize up to here" in the
  `/rewind` menu also run PreCompact hooks with `trigger: "manual"`.
- **Binary:** for a subagent's compaction only the block result is honored;
  stdout instructions are ignored.

### PostCompact (Documented)

Same page, section "PostCompact". Fires after compaction with `trigger` and
`compact_summary`, the generated summary text. "PostCompact hooks have no
decision control. They can't affect the compaction result but can perform
follow-up tasks." Exit 2 only shows stderr. Useful for logging Jev's hit
rate against the summary, not for injecting anything.

### SessionStart (Documented)

Same page, section "SessionStart".

- Sources: `startup`, `resume`, `clear`, `compact`, `fork`. `fork` is new
  since 2.1.214 (before that forks reported `resume`). Our hooks match
  `compact` and `clear` only, which is right; a fork should not receive a
  digest meant for a `/clear`.
- Only `type: "command"` and `type: "mcp_tool"` hooks run here.
- Plain-text stdout and `hookSpecificOutput.additionalContext` both land in
  Claude's context "at the start of the conversation, before the first
  prompt". Several hooks' values are all delivered.
- **Size rule:** "If a value exceeds 10,000 characters, Claude Code writes
  the text to a file in the session directory and passes Claude the file
  path with a preview of up to the first 2,000 characters instead." Section
  "Add context for Claude". Our `TARGET_CHARS = 8000` plus the two-line
  header is safe today; the cap must be enforced on the emitted string, not
  on the joined blocks alone.
- On `/clear` and at launch, SessionStart hooks run in the background;
  Claude's first response waits for them. Our 15 s timeout is fine.
- `sessionTitle` is ignored on `clear` and `compact`. `initialUserMessage`
  applies only in `-p` mode.
- The "What survives compaction" table
  (https://code.claude.com/docs/en/context-window.md) lists "SessionStart
  hooks that match the compact source: Claude Code runs them and adds their
  output to the compacted context". This is the documented home for what we
  do.

### Stdout parsing (Documented)

Section "Exit code 0". Output that starts with `{` and ends with `}` is
parsed as JSON; two or more lines that each parse as JSON on their own, none
setting a field, are treated as plain text; a failed parse on a context event
means the text is not added (since 2.1.248). `emit_context` prints a single
JSON object with a trailing newline, which is the safe shape.

### Other hook types (Documented)

`type: "prompt"` (single LLM call) and `type: "agent"` (experimental,
tool-using subagent) exist for decision events such as `Stop` and
`PreToolUse`. Neither runs on `SessionStart`, and neither produces context.
Not useful for compaction; noted so nobody spends time on it.

## 2. Commands and controls

| Control | What it does | Tag | Source |
|---|---|---|---|
| `/compact [instructions]` | Summarize now; instructions steer the summary | Documented | commands.md |
| `/compact` in `-p --resume <id>` | The command is marked `supportsNonInteractive`; changelog 2.1.x fixed resuming after `/compact ... via -p --resume` | Binary + changelog | binary; CHANGELOG.md |
| `/rewind` then Summarize from here / up to here | Partial compaction with optional typed instructions | Documented | checkpointing.md "Rewind and summarize" |
| `/autocompact [auto\|<tokens>]`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, setting `autoCompactWindow` | Where auto-compaction fires, 100K to 1M tokens; env var wins over flag over setting | Documented | model-config.md "Set the auto-compact window" |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Percentage of the window; can only lower the threshold | Documented | env-vars.md |
| `autoCompactEnabled`, `DISABLE_AUTO_COMPACT=1` | Turn auto-compaction off; `/compact` still works | Documented | settings-reference.md, env-vars.md |
| `DISABLE_COMPACT=1` | Turn all compaction off, `/compact` included | Documented | env-vars.md |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Correct the assumed window for an unrecognized model ID | Documented | model-config.md |
| `/context` | Live breakdown of what fills the window | Documented | commands.md |
| `precomputeCompactionEnabled` | "Precompute the compaction summary in the background before it is needed. Only applies when auto-compact is on." | Binary (settings schema; not on settings-reference.md) | binary |

Default auto-compact thresholds (model-config.md "Default auto-compact
thresholds"): models with a native 1M window compact at about 967K tokens;
200K-window configurations compact at the 200K boundary; cloud sessions
compact as the conversation approaches the limit.

No hook, skill, or setting can run `/clear`, and no documented mechanism
lets a hook or skill run `/compact`. Skills can run shell commands before
their body is sent, but a slash command in a skill body is text to Claude,
not a command. The one programmatic path is `claude -p --resume <id>
"/compact"` from outside the session, which is a second process writing the
same transcript and is not something a hook should do.

## 3. What compaction keeps, and what it does internally

Documented, context-window.md "What survives compaction":

- System prompt, output style: still apply.
- Project-root CLAUDE.md, unscoped rules, auto memory, the plan-mode plan:
  re-injected from disk.
- Files Claude read or edited: up to five re-read, most recently modified
  first; a file over 5,000 tokens comes back as a path reference. **Binary:**
  the constants are 5 files, 5,000 tokens per file, 50,000 tokens total.
- Invoked skill bodies: re-injected, 5,000 tokens per skill, 25,000 total,
  oldest dropped first.
- Context hooks added earlier: summarized with the rest. Only `SessionStart`
  on `compact` adds fresh context after the summary.
- Background commands and subagents keep running.

Binary, 2.1.278, the pieces around the summary:

- **Microcompact.** Before summarizing, old tool results are cleared in
  place: the transcript shows `[Old tool result content cleared]`, and a
  `microcompact_boundary` system record carries `tokensSaved`. There is a
  time-based variant (`tengu_time_based_microcompact`) and a keep-recent
  variant. `DISABLE_MICROCOMPACT` existed in 2.1.42 and is gone in 2.1.278.
  The docs describe this as "It clears older tool outputs first, then
  summarizes the conversation if needed" (how-claude-code-works.md).
- **Precomputed compaction.** With `precomputeCompactionEnabled`, the summary
  is produced in the background ahead of the threshold and swapped in when
  needed; telemetry names `precomputeLeadMs`, `messagesSincePrecompute`, and
  a re-arm cap after consecutive failures.
- **Reactive compaction.** When the API returns a context-limit error, a
  recovery compaction runs; a PreCompact block here surfaces the error.
- **The boundary record.** A `system` line with `subtype: "compact_boundary"`
  and `compactMetadata: {trigger, preTokens, postTokens, userContext,
  messagesSummarized, precomputed, durationMs}`. The summary itself is a
  `user` line with `isCompactSummary: true`. `eval/compare.py` already keys on
  `compact_boundary`; the field names above are what it can rely on, with the
  documented caveat (sessions.md) that the transcript format "is internal to
  Claude Code and changes between versions".
- **Session-memory compaction is gone.** 2.1.42 had a mode
  (`ENABLE_CLAUDE_CODE_SM_COMPACT`) that used a background-maintained
  `session-memory/summary.md` as the compaction summary. Neither the env var
  nor the template exists in 2.1.278. Do not design against it.
- `USE_API_CONTEXT_MANAGEMENT` is still read in 2.1.278; in 2.1.42 its effect
  was hard-wired off. Server-side context editing is not something Claude
  Code exposes.

## 4. Experimental: hooks modules and a hookable `session.compact`

Everything in this section is Binary and gated. None of it is on a docs page
as of 2026-09-21; plugins-reference.md documents `experimental.themes`,
`experimental.monitors`, and `experimental.evals` only.

- **Gate.** Rollout flag `tengu_plugin_hooks_modules`, default off, with the
  message "installed plugins' hooks modules not loaded: rollout flag is off;
  built-in plugins load regardless". Override: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`.
  Also refused when hooks are disabled for the session and until workspace
  trust is accepted.
- **Shape.** One JavaScript hooks module per plugin ("The plugin names one
  hooks module per plugin"), run in a separate hooks worker. Hooks register
  as `on("<method>", filter, ($, e) => ...)` and chain with `next(e)`. The
  module is scanned statically: "what a hooks module hooks and calls on $ is
  read from its source". The manifest key is not recoverable from the binary
  strings; it belongs to the `experimental` family.
- **`session.compact` is hookable.** The event carries `trigger` (`manual`,
  `auto`, or `precompute`), `agentId`, optional `instructions`, and
  `messages` as rows. A row is one message with `role`, `text`,
  `toolUses: [{tool_use_id, tool, input}]`, `toolResults: [{tool_use_id,
  text, isError}]`, and a `handle`. The hook returns `{messages}` or
  `{skip: "<reason>"}`. Returned rows whose `handle` matches an input row
  pass the original message through verbatim; rows without a handle are
  synthesized. When a hook returns its own rows without calling `next`, the
  log line reads "a hook's N messages stand ... core never ran", and the
  built-in summarizer is skipped entirely (`tengu_compact_replaced_by_hook`).
  Validation refuses "a skip after next() compacted", "an empty messages (a
  compaction leaves at least one)", and non-numeric token counts.
- **`$.session.compact({instructions})`** triggers a compaction from a hook.
  It refuses while a turn is running: "the conversation compacts between
  turns, so call it from turn.complete or later", and refuses under
  `DISABLE_COMPACT`.
- **Other methods that map onto this plugin's hooks:** `prompt.submit`
  (routing), `agent.spawn` (subagent model), `tool.call` and `tool.check`
  (rule enforcement), `model.classify` and `model.complete`, `http.fetch`,
  `store.get/set`, `turn.start/step/complete`. A future version of this
  plugin could be one module instead of five Python processes, but the API
  is unpublished and the module language is JavaScript, against the
  standard-library-Python invariant in AGENTS.md.

## 5. What to change here

Ranked by value over effort. Items 1 to 3 use documented features plus one
binary-verified nicety that degrades to nothing if it disappears.

### 5.1 Judge at PreCompact, inject at SessionStart

Register a `PreCompact` hook (no matcher, so `manual` and `auto` both fire):

```json
"PreCompact": [
  {
    "hooks": [
      { "type": "command",
        "command": "python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compactor.py",
        "timeout": 15 }
    ]
  }
]
```

In `compactor.py`, on `hook_event_name == "PreCompact"`:

1. Read `transcript_path` from the event (no `CLAUDE_CODE_SESSION_ID` lookup,
   no mtime guessing). Judge as today. The skill turn no longer exists, so
   `compaction_marker` has nothing to cut; keep it for old transcripts.
2. Write the digest keyed by `session_id`, not by `cwd`. The `SessionStart`
   `compact` event for the same session follows within seconds, so the TTL
   can drop from ten minutes to something that only guards against a crash
   between the two events, or go away in favor of "consume once".
3. Print, as plain text, an instruction for the summarizer: the blocks in the
   digest are preserved verbatim by a hook and must not be restated; the
   summary should cover only what they do not. In 2.1.278 this shortens the
   summary and removes the double payment measured in the design doc. If a
   later version stops reading PreCompact stdout, the summary is merely the
   default one and the digest still lands.
4. Never exit 2. On `auto`, a block surfaces the API error; on `manual`, it
   only frustrates the user.

On `SessionStart` with `source == "compact"`: load the digest for
`session_id`, delete it, and emit it. Drop the second judging pass that runs
there today; PreCompact already did it, and doing it twice costs a second
API fan-out per compaction. Keep the `clear` path for one release so a user
who has `prepare`'s digest waiting is not stranded, then remove `prepare`,
the `clear` matcher, and the `compact` skill body's `/clear` instruction.
The skill can stay as a thin explainer that tells the user to run `/compact`.

What this buys: one built-in command or nothing at all; auto-compaction gets
the same treatment as manual; `/rewind` summaries get it too; no race with a
ten-minute TTL; no `CLAUDE_CODE_SESSION_ID` dependency; `MIN_REDUCTION`
still applies (print nothing and write no digest when the selection is
weak, and the built-in summary stands alone as before).

What it costs: the built-in summary still runs, so the "no LLM summary in
the loop" claim in README becomes "no LLM summary is needed for the kept
blocks; the summarizer is told to cover only the rest". That is the honest
description of what the `compact` hook already does today.

### 5.2 Enforce the 10,000-character rule on the emitted string

`fit_kept` caps the joined blocks at `TARGET_CHARS`; `emit_context` then
adds a header. Cap the final `additionalContext` string at 9,500 characters
and log when the cap bites. Above 10,000 the digest becomes a file path and
a 2,000-character preview, which is worse than a smaller digest.

### 5.3 Log PostCompact for the eval

A `PostCompact` hook receives `compact_summary`. Appending `{session_id,
trigger, len(compact_summary)}` and which digest paths the summary already
mentions to `STATS_LOG` gives the `refetch_default_covered` column live data
instead of replayed data. It cannot change anything, so it is pure
measurement, and it fails open like the others.

### 5.4 Prototype a hooks module on a branch

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, scaffold with `claude plugin init
--with hooks` to see the current layout, and write the smallest module that
hooks `session.compact`, calls Jev over `$.http.fetch`, and returns the rows
to keep by handle. Success looks like the log line "core never ran". This is
the only path where the summarizer genuinely does not run and the kept bytes
are the model's own messages rather than a system reminder. Do not ship it
until the API is documented; do record what the event and row shapes were
so the design doc's proposals can be re-costed against them.

### 5.5 Things not to do

- Do not block `auto` compaction from PreCompact to run our own; the
  context-limit error surfaces and the request fails.
- Do not spawn `claude -p --resume <id> "/compact"` from a hook; it is a
  second writer on the live transcript.
- Do not rely on `PostCompact` for injection; it has none.
- Do not build on session-memory compaction; it is gone.

## 6. Source index

- https://code.claude.com/docs/en/hooks.md (PreCompact, PostCompact,
  SessionStart, "Add context for Claude", "Exit code 0", "Exit code 2
  behavior per event")
- https://code.claude.com/docs/en/hooks-guide.md ("Re-inject context after
  compaction")
- https://code.claude.com/docs/en/context-window.md ("What survives
  compaction", "When your context fills up")
- https://code.claude.com/docs/en/how-claude-code-works.md ("When context
  fills up")
- https://code.claude.com/docs/en/model-config.md ("Context window and
  auto-compaction")
- https://code.claude.com/docs/en/env-vars.md
- https://code.claude.com/docs/en/settings-reference.md (`autoCompactEnabled`,
  `autoCompactWindow`)
- https://code.claude.com/docs/en/commands.md (`/compact`, `/autocompact`,
  `/context`, `/clear`, `/rewind`)
- https://code.claude.com/docs/en/checkpointing.md ("Rewind and summarize")
- https://code.claude.com/docs/en/sessions.md (transcript format caveat)
- https://code.claude.com/docs/en/plugins-reference.md ("Experimental
  components")
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
  (PreCompact added 1.0.48; PostCompact added 2.1.76; PreCompact blocking
  2.1.105; "Summarize from here" 2.1.32; `/autocompact` 2.1.234)
- Claude Code 2.1.278 native binary, strings and minified code, for every
  item tagged Binary or Experimental.
