# Settings pane

The `/claude-jev` pane is an interactive Claude Code UI for the plugin's
configuration and live state. It is **out-of-band only**: it needs a real
interactive session with function hooks enabled and the plugin loaded from
disk, which `control-jev` cannot drive headlessly.

## Sub-features

- `pane-rows` lists API key (source · provider), Provider (Auto, TypeSafe,
  OpenRouter; a pinned one reads only its own key variable), Prompt routing hints,
  Subagent model routing, Rule checks, Compaction, Stats, Status, and Close.
- `pane-toggles` flips Prompt routing hints, Subagent model routing, Rule
  checks, or Compaction On/Off on Enter and saves it to `settings.json` under
  `pluginConfigs["claude-jev@inline"].options` (`claude-jev@claude-jev` for
  an installed plugin). The module reloads and a toast confirms the save.
- `pane-key` saves or clears a key; the API key row shows its source and
  provider. The source strings are exactly `from the environment`, `saved`, and
  `missing`, joined to the provider with ` · ` (`keyLabel()`), so a live proof
  asserts on those three words. A key in the environment wins over a saved one.
- `pane-stats` shows the `scripts/stats.py` report; PgUp/PgDn scroll it.
- `pane-escape` returns from a sub-view to the row list on `Esc`.

## How to get to it (user POV)

- Run `/claude-jev` in an interactive Claude Code session with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and `--plugin-dir` pointing at this
  checkout.
- Enter on API key, Provider, or Stats opens its view; Enter on an On/Off row flips it;
  Status prints version, key source, and the last call under the list.

## Driving it with control-jev

Preconditions:

- A real interactive Claude Code session (2.1.278+) with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `--plugin-dir` at this checkout, a
  trusted workspace, and a stored login in whatever `CLAUDE_CONFIG_DIR` the
  session uses — an isolated config dir without one exits
  `Not logged in · Please run /login`.
- `control-jev` has no path into this pane; nothing below is drivable in-band.

- **Manual drive (out-of-band).** Start `claude` with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and `--plugin-dir "$PWD"`, run
  `/claude-jev`, and step through each row. Confirm the API key row shows
  source and provider, an On/Off row flips and flips back, Stats scrolls, and
  `Esc` from a view returns to the list.
- **Proof.** Record the session transcript or a screenshot of each row and the
  toggle result; save under `settings-pane/` in the run's evidence directory.
- **Isolating the session stops at login (attempted, blocked here).** Running
  `claude -p` with `CLAUDE_CONFIG_DIR` pointed under `$VERIFY_HOME` keeps the
  run's `jev-*.jsonl` rows out of the real `~/.claude`, which is what an audit
  wants — but that dir has no stored login, so the session exits 1 with
  `Not logged in · Please run /login`. Proving any pane row therefore needs
  either a `/login` inside the isolated dir or the user's real config dir, and
  the run must say which. Do not report the pane as verified from a
  `control-jev` pass.

## Gotchas

- Toggling a row or saving a key writes the real user `settings.json`,
  not a disposable fixture — read the value first and restore it afterward.
- Close the `/config` menu before typing into the pane; a live `/config`
  session can intercept keystrokes meant for `/claude-jev`.
- Never substitute an in-band `control-jev` fail-open pass for this proof;
  there is no headless equivalent of the pane.
- Wait for the module to load before typing `/claude-jev`: the debug log
  line `hooks module claude-jev@inline loaded` must be from this session.
  Typed earlier, the prompt goes to the model.
- A key saved in this pane reaches hooks only through Claude Code, as
  `CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY`; `control-jev` never sees it.
- The pane writes through Claude Code's config API (`$.config.set`), so the file
  it lands in is whatever config dir the session started with. Under an isolated
  `CLAUDE_CONFIG_DIR` the write is disposable; in a normal session it edits the
  user's real `settings.json`.
