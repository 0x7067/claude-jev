# Pi adapter

Jev compaction for [Pi](https://pi.dev), installed from this repository.

```bash
pi install git:github.com/0x7067/claude-jev
```

Pi reads `pi.extensions` in the root `package.json` and loads `adapters/pi/jev.ts`. That module subscribes to `session_before_compact` and registers `/jev`. There is no npm `exports` map. The peer dependency is `@earendil-works/pi-coding-agent`. Node 22 or newer.

`0x7067/pi-jev` is still published. This adapter does not remove it.

## What is shared

`adapters/pi/jev.ts` calls `selectBlocks` from `src/compact/strategy.ts`. The checks, thresholds, windows, and Claude's flat 16,000-character budget stay there. Claude's rows bridge does not pass a budget or a `needs` index, so its fit stays 16,000 characters.

A block may set `needs` to the index of the tool call it answers. The Pi adapter sets that from `toolCallId` before the call. When `needs` is absent, a `[tool_result]`, including a named stamp such as `[tool_result read]`, walks back past earlier results on that turn to the tool call it answers. A truncated block keeps a head and a tail, the same cut `truncateBlock` already uses for Claude. A Pi tool result names its tool, and only a `read` result is held, including when the same assistant turn also called another tool. An unlabeled Claude `[tool_result]` is held when the single tool call it answers is a Read, in any capitalization. When that call ran several tools, only the result lined up with the Read is held.

## What stays here

- Pi messages become blocks in `blocks.ts`, including bash output labeled `bash` and earlier summaries labeled `summary`.
- `digest.ts` renders `---[jev:<n>:<role>]---` lines. The summary then appends one `<read-files>` list and Pi's `<modified-files>`. The read list merges Pi's own reads with paths from dropped or truncated calls. Only those pointer paths are capped at 40 lines and 2,000 characters, and a modified path is skipped while that list is filled. Pi's own read paths and `<modified-files>` are extra, like `DIGEST_HEADER` and the `---[jev:…]---` delimiters. `selectBlocks` is asked to fit the body to 14,000 characters. Those 16,000 characters are the body plus that pointer reservation.
- Paths and `jev-calls.jsonl` / `jev-compact-log.jsonl` use `PI_CODING_AGENT_DIR`, or `~/.pi/agent`.
- No key, from the environment or `$PI_CODING_AGENT_DIR/.env`, makes the hook return nothing. Pi's own summary runs. Any other failure is reported and also returns nothing. The hook does not print Claude's `{fallback}` JSON.

`/jev` shows the plugin version from root `plugin.json`, the key source, the provider, and the last call. It does not show the key.
