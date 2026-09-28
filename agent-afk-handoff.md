# agent-afk issues found while porting claude-jev

Found on 2026-09-27 while getting the claude-jev AFK adapter to run under agent-afk. Line numbers in items 1–9 are from `griffinwork40/agent-afk` at `v5.257.3` (`4a23882b`).

Status as of 2026-09-28, against agent-afk `main` at `09897d8e` (v5.265.3):

| # | Kind | Summary | Status |
|---|---|---|---|
| 1 | Bug | `afk plugin install --ref <branch>` fails on a fresh clone | Fixed upstream in v5.257.8 (#2357, #2361) |
| 2 | Bug | `afk plugin update` ignores a tracked branch when the repo has tags; `--ref` not recorded when already at the tip | Tag part fixed upstream in v5.257.9 (#2358, #2360). Recording `--ref` at the tip: PR #2457 |
| 3 | Bug | A marketplace root plugin loads without being installed, and plugins nested under it never load | PR #2456 |
| 4 | Bug | `afk status` says `Found (ANTHROPIC_API_KEY)` for any Anthropic credential | PR #2458 |
| 5 | Bug | `afk chat` hangs on Linux with Claude OAuth | Gone in v5.265.3: on denguinho-server it answers in 2s with `CLAUDE_CODE_OAUTH_TOKEN` and no API key |
| 6 | Bug | 5.244.0 exits silently when five plugin hooks load | Fixed by v5.257.3 |
| 7 | Feature request | No way to pass a secret to a plugin hook | Proposal filed as issue #2459 |
| 8 | Feature request | Command hooks honor only `additionalContext` from `hookSpecificOutput` | Upstream issue #2371; design proposal posted as a comment |
| 9 | Doc gap | Plugin hooks are not documented | Mostly documented upstream now; remaining gaps in PR #2463 |

Also fixed upstream since this was written: Claude Code matchers and `timeout` in seconds (#2377, v5.258.2), and `tool_input` on PostToolUse (#2376, v5.258.2). Non-secret plugin options and a data directory are upstream issue #2373, with a design proposal posted.

PR and issue numbers refer to `griffinwork40/agent-afk`. The PRs come from `0x7067/agent-afk`, one signed-off commit each on `main`. Their Vercel check fails because Vercel asks the maintainer to authorize fork deploys. Lint, build, and test CI is waiting for maintainer approval.

The claude-jev adapter README now installs with `--ref afk` and requires agent-afk 5.258.2 or later. Its remaining workarounds (reading the key from `afk.env`, advisory-only subagent routing, no provider pin, logs under `~/.claude`) go away once #2459, #2371, and #2373 land.

## 1. `afk plugin install --ref <branch>` fails on a fresh clone

**Repro**

```sh
afk plugin install 0x7067/claude-jev claude-jev --ref afk -y
# fatal: '--detach' cannot be used with '-b/-B/--orphan'
```

A tag or a full SHA works. Only a branch name fails.

**Cause.** `installFromGit` (`src/agent/plugins/install.ts:192-204`) passes the user's ref straight to `git.checkout`, which always runs `git checkout --detach <ref>` (`src/agent/plugins/git.ts:181-187`). A fresh clone has only `refs/remotes/origin/<branch>`, not a local branch. So git's checkout DWIM rewrites `checkout <branch>` into `checkout -b <branch> --track origin/<branch>`, and that conflicts with `--detach`.

**Fix.** Before checking out, resolve a branch name to its remote-tracking ref (`refs/remotes/origin/<ref>`) when that ref exists. The updaters already do this, via `tryRevParse` in `src/agent/plugins/update.ts` and `src/agent/marketplaces/update.ts`.

## 2. `afk plugin update` ignores a tracked branch when the repo has tags

**Repro.** Install a plugin that tracks a branch in a repo that also has semver tags. For example, claude-jev's `afk` branch holds the AFK adapter, and the `v0.27.0` tags are the Claude Code plugin.

```sh
afk plugin install 0x7067/claude-jev claude-jev --ref <sha of afk> -y
afk plugin update claude-jev --ref afk   # index now records ref: "afk"
afk plugin update claude-jev             # checks out v0.27.0, a different plugin
```

**Cause.** `src/agent/plugins/update.ts:170-182` picks the latest semver tag first. It falls back to `entry.ref` only when there are no tags. But the comment right below (`:184-197`) says a "tracked `entry.ref` … keeps following the remote-tracking branch". The code doesn't match that stated intent. `src/agent/marketplaces/update.ts:100-112` has the same order.

**Second cause, found while testing the fix.** `afk plugin update <name> --ref afk` doesn't save `afk` when the checkout is already at that branch's tip. The up-to-date early return (`src/agent/plugins/update.ts:214`, `src/agent/marketplaces/update.ts:142`) skips the index write. So after "install by SHA, then update --ref afk", the index still holds the SHA, and the next bare update jumps to the tag anyway.

**Fix.** When there is no `--ref`, `entry.ref` names a remote branch (`refs/remotes/origin/<entry.ref>` resolves), and it isn't also a tag name, follow that branch. Fall back to the latest semver tag only otherwise. An `entry.ref` that is a tag, which is what a tag-picked install records, still moves to the latest tag, as it does today. Also save an explicit `--ref` even when nothing moved.

## 3. Marketplace plugins nested under a plugin repo never load

**Repro.** Add a marketplace entry whose `source` is a subdirectory of a repo whose root is also a plugin:

```json
{ "name": "claude-jev-afk", "source": "./adapters/afk" }
```

```sh
afk marketplace install 0x7067/claude-jev
afk marketplace install-plugin claude-jev claude-jev-afk   # reports success
```

The plugin shows as enabled in `afk plugin list`, but its hooks never run.

**Cause.** Two problems in `src/agent/plugins-scanner.ts`:

- `indexKeyForPath` (`:282-305`) handles cache layout only for three or more path segments. The marketplace root `cache/<mp>` has two, so it's classified as a **flat** plugin named `cache`. Flat plugins load unless disabled, so a single-plugin marketplace's root (`source: "./"`) loads even when nobody installed it. With claude-jev, AFK loaded the Claude Code plugin's hooks. They stayed silent only because the key was missing.
- `walk` (`:140-213`) returns as soon as a directory has `.claude-plugin/plugin.json`, so it never reaches `adapters/afk` below the root.

**Fix.** Treat `cache/<mp>` as cache layout, keyed through `marketplace.json` like its children. In the cache layout, keep walking into the children of a plugin directory that isn't loaded. An installed root plugin still loads.

## 4. `afk status` mislabels the Anthropic credential source

**Repro.** On a host with no `ANTHROPIC_API_KEY` that uses a Claude OAuth token:

```sh
afk status                 # Auth: Found (ANTHROPIC_API_KEY)
afk status --format json   # "source": "CLAUDE_CODE_OAUTH_TOKEN"
```

**Cause.** The text panel in `src/cli/commands/status.ts:85-92` prints a fixed string whenever `apiKey` is truthy. The JSON branch in the same file computes the real source.

**Fix.** Use the same source logic for the text panel as for the JSON output.

## 5. `afk chat` hangs on Linux with Claude OAuth (unresolved)

**Host.** Ubuntu 24.04, Node 24.20.0, agent-afk 5.257.3, over SSH. The credential is the Claude OAuth token from `~/.claude/.credentials.json`, valid for 4 more hours at the time. `ANTHROPIC_API_KEY` is not set.

**Repro**

```sh
timeout 120 afk chat -m haiku --max-turns 2 "Reply ok." </dev/null; echo $?   # 124
```

**What I established**

- It hangs after `AgentSession: queued framework context (479 chars) for the next user message`, with `AFK_DEBUG=1`.
- It isn't plugin hooks. It hangs with `enablePluginHooks: false` too.
- It isn't stdin. It hangs with `</dev/null`, and on macOS an open stdin pipe works.
- It isn't the network. `NODE_DEBUG=net,tls,http` shows two TLS connections to `api.anthropic.com` that close without sending a request. On the same host, curl over IPv4 and IPv6 gets `401` in about 0.2s, with 300 KB bodies too.
- A Mac with `ANTHROPIC_API_KEY` in `afk.env` works with the same version.

- It isn't a timeout. It still hangs after 300s.
- It isn't the credentials file. It hangs the same way with the same access token passed as `CLAUDE_CODE_OAUTH_TOKEN`.
- A Node diagnostic report (`--report-on-signal`), taken 40s in, shows no JS on the stack and no TCP or file handles. There's one referenced one-shot timer, a few unreferenced timers and async handles, and signal handlers. So the process is idle, awaiting a promise that never settles, with no request in flight.

**Next step.** Run it under `node --inspect` on the server and look at the pending promise chain after the "queued framework context" line (`src/agent/session/turn-stream-runner.ts:328`). The remaining untested difference from the working Mac is Linux plus OAuth, with no `ANTHROPIC_API_KEY` to test. Trying a real API key on this host would show whether OAuth matters at all.

## 6. 5.244.0 exits silently with five plugin hooks (fixed by 5.257.3)

On macOS with 5.244.0, `afk chat` printed `Initializing agent...` and exited 0 without calling the model whenever all five claude-jev hooks were loaded. Every subset of four or fewer worked. It stopped happening on 5.257.3, so there's nothing to send upstream unless they want a regression test.

## 7. Feature request: pass a secret to a plugin hook

`executeCommand` (`src/agent/hooks/command-executor.ts:118-170`) builds the hook environment from a fixed allowlist and drops every `AFK_*` variable with a credential suffix. The code comment explains why: it's a deliberate security choice. But a plugin hook that calls its own API then has no supported way to get its key. The comment's suggestion, setting variables "via the hook command itself", means writing the secret into `hooks.json`.

claude-jev works around this by reading its key from `$AFK_HOME/config/afk.env` when `AFK_HOOK_EVENT` is set. That couples a plugin to AFK's config layout.

**Proposal.** An opt-in, per-plugin allowlist the user controls, for example in `afk.config.json`:

```json
{ "pluginHookEnv": { "claude-jev": ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"] } }
```

It's opt-in, so the default stays as strict as today.

## 8. Feature request: more of `hookSpecificOutput` for command hooks

`parseStdoutDecision` (`src/agent/hooks/command-executor.ts:330-362`) reads `continue`, `decision`, `reason`, and `hookSpecificOutput.additionalContext`. It ignores `hookSpecificOutput.updatedInput` and `permissionDecision` / `permissionDecisionReason`. A Claude Code plugin that rewrites tool input, such as setting a subagent's `model`, or denies with a reason in Claude Code's format, silently does nothing under AFK. The dispatcher already applies `updatedInput` from the permission policy. Accepting it from PreToolUse command hooks would close the gap for plugins shared with Claude Code.

## 9. Doc gap: plugin hooks

docs.agentafk.com doesn't cover any of these, and I found each one by reading source:

- Plugin hooks run only with `"enablePluginHooks": true` in `~/.afk/config/afk.config.json`. The only hint is a runtime warning.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin directory.
- `matcher` is a `/regex/flags` string or `*`. Tool names are AFK's own (`agent`, `bash`, `edit_file`, `write_file`, `patch_apply`), not Claude Code's (`Agent`, `Bash`, `Edit`).
- The stdin payload: `session_id` (omitted when unknown, as in `afk chat`), `hook_event_name`, `cwd`, `tool_name`, `tool_input`, `tool_output`, `prompt`, `transcript_path` (always `null`).
- The environment allowlist (item 7) and the honored output fields (item 8).
- Exit code 2 blocks, with stderr as the reason.

## Verification

Each PR's new tests fail on `main` and pass with the fix. `pnpm lint` is clean. With #2456–#2458 merged together, the full `pnpm test` had 22,802 passing and 6 failing. All 6 were in `src/agent/afk-mode-gate.test.ts`, and they also fail on untouched `main`, so they predate these PRs. #2463 is docs only, checked against the source. The docs site wasn't built.
