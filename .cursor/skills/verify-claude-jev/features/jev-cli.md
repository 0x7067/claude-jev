# Jev CLI

The `/claude-jev:jev` skill exposes `scripts/jev.py` so an agent can offload a
typed judgment. Without `TYPESAFE_API_KEY` the CLI exits 2 and prints
`jev: set TYPESAFE_API_KEY`; the agent must continue without blocking.

## Sub-features

- `jev-missing-key` exits 2 with the set-key message when the env var is absent.
- `jev-usage` rejects incomplete `choose` / `score` invocations with exit 2.
- `jev-noul-live` (live key) returns JSON with a `noul` probability.

## How to get to it (user POV)

- Invoke the `jev` skill / run `python3 scripts/jev.py ...` from a Claude Code session.
- Run the same CLI under `control-jev` during verification.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run.
- Disposable `HOME` is set by `control-jev launch`.

- **Missing key.** Unset `TYPESAFE_API_KEY`. Run `control-jev jev -- noul "Is 2 even?" "2"`. Exit code `2` and stderr contains `jev: set TYPESAFE_API_KEY`.
- **Bad choose.** Run `control-jev jev -- choose "pick" "state" --opt only=one`. Exit code `2` (needs at least two `--opt`).
- **Live noul (optional).** With the key set, run `control-jev jev -- noul "Is 2 even?" "2"`. Exit code `0` and stdout JSON includes `"noul"`.
- **Proof.** Save stderr/stdout/exit under `jev-cli/missing-key.txt` for the no-key case. The artifact shows exit `2` and the set-key string.

## Gotchas

- Exit `2` is the success proof for the missing-key path; do not retry with a fake key.
- Live calls append `$HOME/.claude/jev-calls.jsonl` under the disposable home.
- Do not use Jev to generate prose; verification only checks typed CLI answers.
