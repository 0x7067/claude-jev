# Vision

claude-jev exists so that a coding agent's dozens of small per-turn judgments cost a System One model's price instead of a frontier model's price.
It serves coding-agent users who already keep instruction files and want their agent held to them.
It turns prompts, edits, subagent briefs, and full transcripts into typed judgments: routing hints, block decisions with citations, model tiers, and the rows a next session needs.
It ships today as five hooks for Claude Code, and it owns the judgments, the hooks that deliver them, and the evals that measure them.

## Fail open, then measure what slipped

A hook that cannot reach Jev, a missing key, a timeout, or a malformed event produces no output and never blocks a prompt.
Compaction falls back to Claude Code's own summary, and a chunk that fails scores nothing while keeping its blocks.
An accepted edit is an edit the user kept; blocking one is the first cost every rules change reports.
When a judgment is wrong, the fix is a measured rate, not a guard that widens.

## Numbers come from named runs

A performance claim in the README carries the run behind it, or it comes out.
Evals run on real transcripts and real repos.
A corpus invented to test the judge measures the fixture, not the plugin, and is deleted when that shows.
A probe never fakes the Jev client; if cost is the problem the sample shrinks, the client does not.
Real corpora may be anonymized and committed, so any clone can rerun the numbers behind a claim.
A provider beyond Jev, local or remote, earns its place only by matching Jev on the same named runs.
Work that was not verified live is reported as not verified live.

## The user owns the configuration

Rules come from the instruction files the user already keeps, judged in the user's own wording.
What the plugin learns from overrides persists in a durable file the user can read and edit, never in an ephemeral cache.
A structured rule format may join prose as an option the user picks, and prose keeps working unchanged.
No committed rubric, no required schema, and no compile step stands between the user's files and the judge.
Tunables settle into source constants; an environment variable exists only for a key or a per-deployment value, one variable per provider, read in one order.

## One path per job

When a stricter design removes a mechanism, the change that ships it deletes the other in the same commit.
The classic compaction hooks died the day session.compact shipped; the rubric died the day Jev classified phase itself.
Stats and evals measure what shipped, not what was dropped.
Every Jev call is instrumented, because an unmeasured hook cannot be tuned, only guessed at.
Edit verdicts may be cached, and a cache key carries everything that changed the verdict, the lesson of the answers feature, or the cache does not ship.

## Optional parts stay optional

ast-grep is pinned and auto-fetched, and every comparator answers empty without it.
The function-hooks flag is Claude Code's own experimental switch: on, compaction is judged; off, Claude Code summarizes and every other hook works unchanged.
A new provider is one new entry in one table, not a second code path.
A new host is one adapter over the same judgments, not a fork of them.
A machine with only python3 can run the shipped checks and claim exactly what they cover.

## Scope

claude-jev is not a rules engine, not a linter, and not a CI system.
Jev answers small typed questions; it never writes code, never writes summaries, and never overrides the model that executes.
It may shape a turn with pointers to search, edit, and verify, and the executing model owns the result.
Hooks judge what a turn changed; a turn that edited nothing has nothing to enforce.
Hooks judge work inside the project and ignore slash commands, # lines, and prompts under three characters.
A denied subagent brief is denied again until it carries its paths, acceptance, verification, and commit policy.
Denials are not small judgments, so the frontier model may confirm one before it lands.
Silence is the default output; near-misses land in the decision log and the Stats row, never as chat noise.
Its own source bans comments, imports only the standard library, and passes the checks it ships.
Numbers about the plugin change only with a run behind them.

## Direction

Claude Code is the first host; Codex, Cursor, Grok, Pi, and OpenCode follow behind the same judgments.
The router grows from a one-line hint toward a short plan of the turn.

A change aligns when it moves a judgment to Jev, deletes a second path, replaces an invented fixture with real data, or removes a tunable.
A change should be resisted when it can block a session on a hook failure, adds a dependency beyond the standard library and pinned ast-grep, requires new configuration before it works, or states a number without its run.
