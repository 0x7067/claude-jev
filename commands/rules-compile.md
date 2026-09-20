---
description: Compile AGENTS.md/CLAUDE.md and rules files into .claude/jev-rubric.json, the stable rule list the PostToolUse/Stop hooks enforce
---

You are turning the rules a person wrote for coding agents into a rubric that a checker outside your context window can enforce on every edit. The checker sees only one rule and one diff at a time. Nothing else. Every decision below follows from that.

Two facts before you start:

- Rules come only from the user's own files. Never add a rule you think they should have. If a file holds zero rules, the rubric holds zero rules and you say so.
- The rubric is a committed, hand-editable file. A person will read it, and a verdict must trace to a rule they can point at. Quote their wording.

## Step 1. Read the sources

Read, in full: `AGENTS.md`, `CLAUDE.md` at the repo root; any nested `AGENTS.md`/`CLAUDE.md` in subdirectories; every `*.md`/`*.mdc` under `.claude/rules/` and `.cursor/rules/`; `CONTRIBUTING.md` (only sentences that give an instruction); and `~/.claude/jev-rules.md` if it exists — those go in the global rubric at `~/.claude/jev-rubric.json` instead.

- Follow pointer files. A file whose whole content is "Read ./AGENTS.md" is a pointer; read the target as a source in its own right.
- Rules from a file under a subdirectory apply only there — their `scope` is that directory's glob, e.g. `["apps/web/**/*"]`.

## Step 2. Extract every statement that instructs

Go through each file top to bottom. A rule is any sentence that tells the agent to do or not do something about code. Headings, background, and rationale are not rules, but they often say what a rule is for and belong in the wording of its question.

For each rule capture `text` (the user's own words, one or two sentences — do not paraphrase into something more general), `source.path` and `source.line`, and any adjacent code block (a worked example or counterexample carries more signal than prose and belongs in the question's criteria).

Do not merge two rules into one because they sit under one heading. Do not split a rule that is one idea.

## Step 3. Classify each rule into exactly one bucket

Ask the questions in this order and stop at the first yes.

1. Can a linter enforce it exactly? Then `check.type` is `lint` — `"check": {"type": "lint", "how": "the lint rule or AST/grep shape"}`. The hook records these and never runs them and never sends them to the model. The judge is for what a linter cannot express.
2. Does the rule need counting or measuring (line lengths, nesting depth, ordering)? That is mechanical work and the judge cannot count — `check.type` is `deferred` with reason "needs a script, not a judge".
3. Can a judge answer it by looking at a change and nothing else? Then `check.type` is `model`. Most style, structure, comment, error-handling, naming, and "do not do X" rules land here.
4. Does answering need the rest of the repository ("reuse existing error codes", "follow existing patterns")? Then `check.type` is `deferred` with a one-line `reason`.
5. Is it about the conversation or the process rather than the code ("ask when unsure", "run the tests before you finish")? Then `check.type` is `unenforceable` with a `reason`.

Every statement lands somewhere. Count them: the summary you give the user is the four bucket counts.

## Step 4. Write the question for each model rule

The judge is a small, fast model that answers typed questions with a probability. It is good at narrow, concrete questions and bad at vague ones. A vague question scores about 0.4 on everything and never fires, and the user reads that silence as good news. Write every question so a violating diff scores near 1 and a clean diff scores near 0.

- One idea per question. If the rule has two parts, make two rules.
- Ask about the diff: "Does this change add ...", "Does this change put ...". Name the concrete shape to catch — the identifier, the call, the syntax.
- Never put scope in the text. "For a file under apps/web" belongs in `scope`, not the question.
- Keep instructions under about 60 words — every word is billed on every edit.
- Ask for existence, not a judgment of the whole: "is there at least one comment restating the line below it" fires on the first offender; "are the comments appropriate" averages over the hunk and never leaves the middle.
- A rule about volume ("comment sparingly", "minimal code") needs two questions: an existence question for the concrete offence, and a `score` question for the amount.
- Use `criteria` for a worked example: `"criteria": {"true": "...", "false": "..."}`.
- Question types:
  - `boolean` for almost everything — the answer is the probability the rule is broken.
  - `choice` when the rule names a closed set of shapes and only some are wrong: `criteria` maps each option to a description, `violating` lists the wrong ones.
  - `score` when the rule is a matter of degree: `criteria` is an ordered list of levels from compliant (index 0) to worst, `violatingFrom` is the first level that counts as broken.

## Step 5. Decide when each model rule runs

Every model rule carries `when`: `"edit"` or `"turn"`. The wrong phase produces false violations, and each one costs the agent a repair turn.

- `"edit"` runs after every edit, against that one hunk. Use it when the lines in front of the judge are enough: raw error text reaching a user, a narrating comment, a hand-rolled utility, a hardcoded color.
- `"turn"` runs once when the agent finishes, against everything it changed this session. Use it for questions about the change as a whole: scope creep, changes outside what was asked, an abstraction with a single caller, overall length. After edit 1 of 12 these questions have no answer.

The test: if a careful reviewer would want the whole change before answering, it is `"turn"`.

## Step 6. Write the rubric file

Write `.claude/jev-rubric.json` (project rules) and, only if `~/.claude/jev-rules.md` or other global instruction files exist, `~/.claude/jev-rubric.json`:

```json
{
  "version": 1,
  "compiledAt": "<now, iso>",
  "compiledBy": "claude",
  "sources": [{"path": "AGENTS.md", "scope": "**/*"}],
  "rules": [
    {
      "id": "no-raw-error-to-user",
      "text": "Never show a user a raw error.",
      "source": {"path": "AGENTS.md", "line": 120},
      "scope": ["apps/web/src/**/*.ts"],
      "when": "edit",
      "check": {
        "type": "model",
        "question": {
          "type": "boolean",
          "instructions": "Does this change put raw exception text where a user will see it: error.message, String(error) or a template of them reaching a response body, rendered copy, or a displayed column?",
          "criteria": {"true": "res.status(500).json({message: String(error)})", "false": "res.status(500).json({message: 'Could not load this run.'})"}
        }
      }
    },
    {
      "id": "no-console-log",
      "text": "No console.log in committed code.",
      "source": {"path": "AGENTS.md", "line": 41},
      "check": {"type": "lint", "how": "eslint no-console"}
    }
  ]
}
```

Rules of the file:

- `id` is a short kebab-case name that says what the rule catches. Ids must be unique within the file.
- Leave `sha` out of `sources`; the validator computes it.
- Every rule's `source.path` must appear in `sources`.
- No `status` field on new rules (defaults to `active`); no `calibration` field — the hook's log provides the data.
- Plain JSON only. Nothing else goes in the file.

## Step 7. Validate

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/rubric.py --validate .claude/jev-rubric.json
```

Fix every problem it prints and run it again until clean. It fills in the source hashes — after this, editing an instruction file makes the rubric stale and the hook will tell the user to recompile.

## Step 8. Report and move on

Tell the user, in two or three plain sentences: how many rules, split across the four buckets, and that the rubric is at `.claude/jev-rubric.json` for them to read and edit. Do not paste the rubric into the conversation.
