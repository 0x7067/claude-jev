# Stop hook: a session's old edits judged against the latest prompt

Incident notes, 2026-09-24. The plugin was v0.18.0 (installed cache), and its
`scripts/rules.py` matches `75f591f` byte for byte. Evidence comes from session
`ccb4b920-8aaf-43a4-9928-280dd8ffee45`: its state file under
`~/.claude/jev-rule-blocks/` and its rows in `~/.claude/jev-router-log.jsonl`.

## The short version

The `Stop` hook blocked twice with this message:

> The changes this turn appear to break a rule from this repository's
> instructions. Rule "change-only-what-the-task" … Repair .zprofile, .zshenv
> before you finish.

Both blocks were false. Neither turn edited `.zprofile` or `.zshenv`. The
edits it quoted came from an earlier turn, and the user had approved them.
There are three causes:

1. **Hunks build up across the whole session and are never reset per turn.**
   The message says "this turn", but the check reads every Edit/Write since
   the session started.
2. **The task is only the latest prompt.** Old hunks are judged against
   whatever the user asked last. The further the conversation moves from the
   edited files, the more those edits look like scope creep.
3. **The hook sees only Edit/Write tool calls.** The work done in the flagged
   turns ran through Bash, so the hook never saw it. The turn it judged was,
   in effect, empty.

## Timeline

Every `turn` row for the session. `p` is the probability Jev gave
`change-only-what-the-task`. The hook blocks at `p ≥ 0.80`.

| UTC | Latest user prompt (the "task") | Edit/Write this turn | p | Outcome |
|---|---|---|---|---|
| 13:33:41 | "y" (approve the zsh restructure) | `.zprofile`, `.zshenv` ×2 | 0.73 | flag |
| 13:35:31 | "replace the chezmoi source with what's live" | none | 0.79 | flag |
| 13:37:51 | "create ~/.config/zai/api-key" | none | 0.91 | **block** |
| 13:38:05 | (same turn, `stop_hook_active`) | none | 0.88 | suppressed |
| 13:39:54 | "wait did we lose .zprofile?" | none | 0.74 | flag |
| 13:44:01 | "change my global gitconfig too…" | none | 0.92 | **block** |
| 13:44:13 | (same turn, `stop_hook_active`) | none | 0.88 | suppressed |

The only edits in the session state are three hunks, all written at
13:31–13:32:

```
files        ['.zprofile', '.zshenv']
stop_blocks  2
hunks        .zprofile  NEW FILE (whole content)
             .zshenv    REMOVED/ADDED (top PATH block)
             .zshenv    REMOVED (. "$HOME/.cargo/env")
```

The same three hunks were judged seven times. The score went up whenever the
prompt was unrelated to shell files: 0.91 for creating a key file and 0.92
for the gitconfig change. The turn that actually made the edits scored lowest
(0.73), because its prompt approved them.

## Causes, in the code

### 1. Session-wide hunks, reported as "this turn"

- `handle_edit` appends every judged hunk to the session state
  (`record_hunk(sstate, rel, state)`, `scripts/rules.py:1017`).
- `session_state` starts `hunks` and `files` empty once per session
  (`:746`). No code path clears them when a turn ends.
- `handle_stop` returns early only when the session has no hunks at all
  (`:1072`). Once a session has one edit, every later `Stop` runs a turn
  check, including turns with no edits.
- The request text says "Files changed this session" (`:1082`). The block
  message says "The changes this turn" and "Repair {files}", where `files`
  is the session list (`:1120`).
- `README.md:63` promises the per-turn behavior: "The `Stop` hook judges them
  against all of the turn's hunks, where scope creep shows."

### 2. The task is the latest prompt only

`handle_stop` uses `last_user_prompt()` (`:1080`). For a turn rule about
scope, the question is whether each change matches the request that caused
it. Pairing older hunks with a newer prompt asks the wrong question. Jev
answered it correctly: a `.zprofile` rewrite is not part of "create
~/.config/zai/api-key".

### 3. Bash-made changes are invisible

The `PostToolUse` matcher is `Edit|Write|MultiEdit|NotebookEdit`
(`hooks/hooks.json:28`). In this session, most file changes went through
Bash:
- a Python script that rewrote `~/.zshrc`
- `cp` into the chezmoi source
- `chezmoi apply`
- `git config` over ssh
- creating the key file

None of these were recorded. So the flagged turns reached `Stop` with zero
recorded changes of their own. The hook judged stale hunks in their place.

## Side effects

- **The block budget is per session and is now spent.** `MAX_STOP_BLOCKS = 2`
  (`:54`), and `stop_blocks` is 2. For the rest of this session, a real
  scope violation can only flag. Two false positives used up the budget for
  true ones.
- **The repair instruction asks for the wrong thing.** "Repair .zprofile,
  .zshenv" told the agent to revert work the user had approved. An agent
  that obeys it undoes the task. The one that got the message checked mtimes
  and diffs and refused, which is the right call but costs a turn each time.
- **One Write left no trace.** `~/.config/shell/path.zsh` was written in the
  same parallel batch as `.zprofile` (13:31:45). It has no log row and no
  hunk. Every early return in `handle_edit` before `log_decision` fails to
  explain it:
  - the path is not `EXCLUDED`
  - the path is inside `cwd`
  - the content is non-empty
  - the same rules were in scope for `.zprofile`

  So the likely causes are an exception that `main()` swallowed, or the
  10-second timeout. This is unconfirmed. Separately, `session_state` and
  `save_state` do an unlocked read-modify-write of one JSON file. Parallel
  `PostToolUse` hooks can therefore drop each other's hunks. That race was
  not observed here, but nothing prevents it.

## Fix directions

In order of how much of this incident each one removes:

1. **Scope the turn check to the turn.** Tag each hunk with the prompt it was
   made under, or with the user-message uuid from the transcript. At `Stop`,
   judge only hunks from the current turn, and skip the call when there are
   none. This removes both blocks above. It also makes "this turn" and
   `README.md:63` true.
2. **Judge each hunk against its own prompt.** If a rule really needs the
   whole session, send the pairs (prompt, hunks) instead of one prompt and a
   pooled diff.
3. **Say what the hook didn't see.** When the turn ran Bash commands that
   write files, either skip the turn check or tell Jev that the diff is
   partial. Recording Bash writes is harder: the hook would need a `git
   diff` or mtime snapshot at turn start.
4. **Name the files from this turn in the message,** so the repair
   instruction never points at approved work.
5. **Lock or merge the session state file** so parallel edits can't drop
   hunks. Log early returns and exceptions in `handle_edit`, so a missing
   row like `path.zsh`'s can be explained.

A regression case for the eval: one session with an approved edit in turn 1,
then an unrelated prompt with no edits in turn 2. The expected result is no
turn check in turn 2. Today it scores 0.91.
