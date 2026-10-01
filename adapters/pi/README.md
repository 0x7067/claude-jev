# Pi adapter

Jev compaction for [Pi](https://pi.dev), installed from this repository.

```bash
pi install git:github.com/0x7067/claude-jev
```

Pi reads `pi.extensions` in the root `package.json` and loads `adapters/pi/jev.ts`. That module subscribes to `session_before_compact` and registers `/jev`. There is no npm `exports` map. The peer dependency is `@earendil-works/pi-coding-agent`. Node 22 or newer.

`0x7067/pi-jev` is still published. This adapter does not remove it.

## What is shared

`adapters/pi/jev.ts` calls `selectBlocks` from `src/compact/strategy.ts`. The checks, thresholds, windows, and Claude's flat 16,000-character budget stay there. Claude's rows bridge does not pass a budget or a `needs` index, so its fit and its previous-row pairing are unchanged.

A block may set `needs` to the index of the tool call it answers. The Pi adapter sets that from `toolCallId` before the call. When `needs` is absent, selection still pairs a tool result with the previous `[tool_use` row. A truncated block keeps a head and a tail, the same cut `truncateBlock` already uses for Claude. The shared hold for a tool result applies when the preceding tool name is `Read`.

## What stays here

- Pi messages become blocks in `blocks.ts`, including bash output labeled `bash` and earlier summaries labeled `summary`.
- `digest.ts` renders `---[jev:<n>:<role>]---` lines and a `<read-files>` index of at most 40 paths and 2,000 characters. `selectBlocks` is asked to fit the body to 14,000 characters so the index has room inside the same 16,000.
- Paths and `jev-calls.jsonl` / `jev-compact-log.jsonl` use `PI_CODING_AGENT_DIR`, or `~/.pi/agent`.
- No key, from the environment or `$PI_CODING_AGENT_DIR/.env`, makes the hook return nothing. Pi's own summary runs. Any other failure is reported and also returns nothing. The hook does not print Claude's `{fallback}` JSON.

`/jev` shows the plugin version from root `plugin.json`, the key source, the provider, and the last call. It does not show the key.
