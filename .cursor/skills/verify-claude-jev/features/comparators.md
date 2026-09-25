# Comparators (ast-grep)

`scripts/comparators.py` is the only place claude-jev reaches for an external
program. It looks up code the edited block repeats, using a pinned ast-grep
binary, and the rule judgment is the same with or without it: when the binary is
absent every comparator answers `""`. The rules hook fetches the pinned build in
a detached process outside the hook's 10s budget, into the Claude config dir,
and never blocks on it.

## Sub-features

- `sg-which` prints the resolved path and state without downloading anything.
- `sg-degraded` shows a judgment completing with no binary: `comparators: {}` and
  `sg: none` on the decision row.
- `sg-cached` shows the same fields once the pinned binary is in place: `sg: cached`.
- `sg-fetch` downloads the pinned version to `<config dir>/jev-bin/ast-grep-<VERSION>`.
- `sg-isolation` proves the binary belongs to the config dir the run uses, so a
  verify home and the real `~/.claude` resolve to different paths.

## How to get to it (user POV)

- Nothing to run by hand in normal use: the `rules.py` hook consults comparators on
  a `PostToolUse` edit and kicks the fetch when the binary is missing.
- `python3 scripts/comparators.py which` answers what the hook would run, and
  `python3 scripts/comparators.py fetch` downloads the pinned build. `control-jev
  doctor` already runs `which` and records it as `comparators_which=`.

## Driving it with control-jev

Preconditions:

- `control-jev doctor` reports `doctor=ok` for this run, and its
  `comparators_which=` line is read before driving.
- Disposable verify home is set by `control-jev launch`.
- Both keys unset for `sg-degraded`; a live key for `sg-cached`.

- **Which (fresh home).** Right after `launch`, run
  `CLAUDE_CONFIG_DIR="$VERIFY_HOME/.claude" python3 scripts/comparators.py which`. Exit
  code `0`, and stdout starts `(none)  [none]  pinned <VERSION> -> $VERIFY_HOME/.claude/jev-bin/…`
  — the path is inside the verify home, never the real `~/.claude`. Pass
  `CLAUDE_CONFIG_DIR`, not just `HOME`: `config_dir()` prefers the former, and this
  script is not driven through `control-jev`, which pins it for you. Save as
  `comparators/which-fresh.txt`. The state token in brackets is one of
  `path` / `cached` / `none`.
- **Degraded judgment.** With both keys unset, drive the **Edit event no key**
  recipe in `rule-enforcement.md`, then with a live key drive **Live block budget**.
  Read the `rules` row: `"comparators": {}` and `"sg": "none"` prove the judgment ran
  with no binary. Exit code `0` either way.
- **Fetch lands.** After a live-key edit judgment, wait a few seconds and run the
  `which` command again. stdout now starts with the path and `[cached]`, and
  `$VERIFY_HOME/.claude/jev-bin/ast-grep-<VERSION>/ast-grep --version` prints
  `ast-grep <VERSION>` matching the pinned `VERSION` in `scripts/comparators.py`.
  A later live judgment shows `"sg": "cached"` in its decision row. Save both `which`
  outputs and the version line as `comparators/fetch.txt`.
- **Fetch by hand, and its exit code.** `CLAUDE_CONFIG_DIR="$VERIFY_HOME/.claude" python3
  scripts/comparators.py fetch` exits `0` on success and `1` on failure. It compares
  the download against the pinned `SHA256` map before keeping it — on a mismatch it
  deletes the file it wrote and gives up, so a bad download never stays installed.
- **Isolation.** Run `python3 scripts/comparators.py which` without the `HOME=` prefix.
  On a machine whose real `~/.claude` already holds the binary it resolves under
  `/Users/…/.claude/jev-bin/…`, a different path from the verify home answer.

## Gotchas

- The fetch is a real download of a ~50 MB binary into the config dir, triggered as a
  side effect of driving the rules hook with a live key. It is not a failure and not a
  leak — it lands in `$VERIFY_HOME`, and `control-jev cleanup` removes it with the
  home. Do not run `comparators.py fetch` without pinning the config dir: with a bare
  `HOME=` prefix, or none at all, it writes the user's real `~/.claude/jev-bin`.
- The first rows of a run say `sg: none` and later ones `sg: cached` because the
  detached fetch finished in between. That ordering is the proof, not noise; never
  conclude the comparator path is broken from an empty `comparators` object.
- `comparators: {}` is also correct when the binary exists and nothing matched, so
  pair it with `sg` before claiming degradation.
- The state token is not just installed-vs-not: a system `ast-grep` found on `PATH`
  **wins over the pinned download** and prints `[path]`, at whatever version the host
  has. So a machine with a global ast-grep cannot show the `[none]` degraded state at
  all, and its comparator evidence comes from an unpinned binary — record the state
  token with every artifact, and never assume `[none]` means "not installed here" when
  a `brew`/`npm` ast-grep may be on `PATH`.
- `which` never downloads and `fetch` never judges: neither call touches Jev, so both
  are in-band regardless of keys.
- The pinned version lives in `scripts/comparators.py` as `VERSION` with a sha256. If
  that constant changes, the cached directory name changes with it and an old
  `ast-grep-<old>` dir is left behind unused.
