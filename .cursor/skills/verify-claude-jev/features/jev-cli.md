# Jev CLI

`scripts/jev.py` is the API client every hook imports, and it doubles as a CLI
for manual checks (`ask`, `choose`, `noul`, `score`, `intent`, `status` —
listed by `python3 scripts/jev.py --help`). Without `TYPESAFE_API_KEY` or
`OPENROUTER_API_KEY` the CLI exits 2 and prints `jev: set TYPESAFE_API_KEY or
OPENROUTER_API_KEY`; a hook that imports it must continue without blocking.

## Sub-features

- `jev-missing-key` exits 2 with the set-key message when both env vars are absent.
- `jev-usage` rejects incomplete `choose` / `score` invocations with exit 2.
- `jev-noul-live` (out-of-band; live key) returns JSON with a `noul` probability.
- `jev-status` prints the key source, provider, pinned provider, version, and last call as JSON, never the key.
- `jev-pinned` reads only the pinned provider's variable: pinned to OpenRouter with no `OPENROUTER_API_KEY`, the CLI exits 2 with `jev: set OPENROUTER_API_KEY`.

## How to get to it (user POV)

- Run `python3 scripts/jev.py ...` directly, or let a hook import it, from a Claude Code session.
- Run the same CLI under `control-jev` during verification.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable verify home is set by `control-jev launch`.
- `eval "$(control-jev env)"` if the recipe needs exported run vars.

- **Missing key.** Unset both `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY`. Run `control-jev jev -- noul "Is 2 even?" "2"`. Exit code `2` and stderr contains `jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY`.
- **Bad choose.** Run `control-jev jev -- choose "pick" "state" --opt only=one`. Exit code `2` (needs at least two `--opt`).
- **Live noul (out-of-band).** Needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Run `control-jev jev -- noul "Is 2 even?" "2"`. Exit code `0` and stdout JSON includes `"noul"`.
- **Status.** With both keys unset, run `control-jev jev -- status`. Exit code `0`; JSON has `"key": "missing"`, `"provider": null`, `"pinned": "auto"`. With `TYPESAFE_API_KEY=ts-fake OPENROUTER_API_KEY=sk-or-v1-fake` it has `"key": "env"`, `"provider": "typesafe"` (TypeSafe's variable is read first on `auto`). No network call.
- **Pinned provider.** Run `CLAUDE_PLUGIN_OPTION_PROVIDER=openrouter control-jev jev -- status` with only `OPENROUTER_API_KEY=sk-or-v1-fake` set: `"provider": "openrouter"`, `"pinned": "openrouter"`. With both keys unset, `CLAUDE_PLUGIN_OPTION_PROVIDER=openrouter control-jev jev -- noul q s` exits `2` with `jev: set OPENROUTER_API_KEY`.
- **Proof.** Save stderr/stdout/exit under `jev-cli/missing-key.txt` for the no-key case. The artifact shows exit `2` and the set-key string.

## Gotchas

- Pinning a provider changes which variable is read. Under `CLAUDE_PLUGIN_OPTION_PROVIDER=typesafe` an `OPENROUTER_API_KEY` alone counts as missing.
- Exit `2` is the in-band success proof for the missing-key path; do not retry with a fake key.
- Live calls append `$VERIFY_HOME/.claude/jev-calls.jsonl` under the disposable home and are out-of-band.
- A key saved in the `/claude-jev` settings pane does not apply under `control-jev`: Claude Code hands it to hooks as `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`, and `control-jev` runs the scripts directly.
- Do not use Jev to generate prose; verification only checks typed CLI answers.
