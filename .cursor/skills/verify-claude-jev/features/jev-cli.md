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
- **Proof.** Save stderr/stdout/exit under `jev-cli/missing-key.txt` for the no-key case. The artifact shows exit `2` and the set-key string.

## Gotchas

- Exit `2` is the in-band success proof for the missing-key path; do not retry with a fake key.
- Live calls append `$VERIFY_HOME/.claude/jev-calls.jsonl` under the disposable home and are out-of-band.
- A key saved in the `/claude-jev` settings pane does not apply under `control-jev`: Claude Code hands it to hooks as `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`, and `control-jev` runs the scripts directly.
- Do not use Jev to generate prose; verification only checks typed CLI answers.
