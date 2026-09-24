# Prompt craft for Jev

How you phrase a question changes the answer more than which tool you pick.
This document records measured effects on real codebases, not general advice.

## Applying this to the rule verifier

The measurements below concern small file-analysis samples. They are hypotheses
for rule enforcement, not grounds to change its thresholds or skip short edits.
The verifier already asks one binary question per rule in the direction of
detecting a violation. See [the rule prompt review](rule-prompt-review.md) for a
bounded comparison of concrete wording, applicability, and evidence sufficiency.
A missing approval history or external definition is missing evidence, not proof
of compliance. Validate candidate wording against both violations and compliant
contrasts before changing the hook.

## Concrete beats abstract

Tested on 5 source files with known ground truth (independently verified by
subagent code reads):

| Prompt style | Example | Avg score on known-splittable files |
|---|---|---|
| Abstract | "Does this file contain distinct concerns?" | 0.73 (3 of 5 uncertain) |
| Concrete | "Could you extract a 30+ line block into a sibling file where the block has a single responsibility and the interface is a small number of function calls?" | 0.86 (5 of 5 yes) |

The concrete prompt gives Jev a checkable criterion. The abstract prompt
asks for a judgment that depends on what "distinct" means to the reader.

**Rule: make the question operationally testable.** A good Jev question
could be settled by a knowledgeable person looking at the artifact for ten
seconds. If it requires weighing tradeoffs, split it into the individual
checks that feed the tradeoff.

| Instead of | Ask |
|---|---|
| "Is this code risky?" | "Could a developer safely edit one section without reading the rest?" |
| "Is this well-designed?" | "Does this module have more than 3 public exports that serve different consumers?" |
| "Is this PR important?" | "Does this diff change a function signature that appears in another module's import?" |

## Positive framing only

Jev is sensitive to prompt polarity. Measured on the same files, same session,
same Jev model:

| Framing | Score on a known-splittable file |
|---|---|
| Positive: "Could you extract a 30+ line block with a clean interface?" | 0.84 |
| Negative: "Is this file so cohesive that splitting it would be artificial?" | 0.52 |

The 0.32-point swing is not random variance (run-to-run variance on these
files was 0.13). The framing determines the answer. This was consistent
across all five test files and both directions of the question.

**Rule: always frame in the direction of what you want to detect.** If you
want to find splittable files, ask about splitting. If you want to find
risky files, ask about risk. Never ask "is this safe?" to find danger — ask
"is this dangerous?"

## Decompose over aggregate

`jev_ask` with 5 specific binary checks outperformed `jev_triage` with 1
aggregate `score` on every file tested. Measured on 4 files with known
properties:

| Approach | Ordering-dep file | Clean file | Signal |
|---|---|---|---|
| Aggregate score (0-4 rubric) | 3.0-3.4 | 1.2-1.5 | Direction correct, magnitude ambiguous |
| `ordering_constraints` check | 0.97-0.98 | 0.08-0.12 | Extreme separation |
| `safe_partial_edit` check | 0.11-0.12 | 0.85-0.91 | Extreme separation |

The aggregate buries the signal. The decomposed questions isolate it. Extra
questions in a single `jev_ask` call add almost no latency because Jev
prefills the state once.

**Rule: ask 5 specific `noul` questions via `jev_ask` instead of 1 broad
`score`.** The cost is the same. The signal is sharper.

Good decomposition dimensions for source files:

| Question | What it catches |
|---|---|
| "Does this file contain mutable shared state that two functions both read and write?" | Concurrency and ordering bugs |
| "Are there ordering constraints — must some functions run before others?" | Initialization and lifecycle bugs |
| "Could a developer safely edit one section without reading the rest?" | Coupling and blast radius |
| "Could you extract a block of 30+ lines with a clean interface?" | Splittability |
| "Has significant code been extracted from this file in the last 5 commits?" | Active refactoring (less reliable — Jev does not see git history) |

## The unreliable band: 0.60-0.75

Measured run-to-run variance on identical inputs: up to 0.13 points. A file
scored 0.69 on one run and 0.82 on the next — flipping the verdict from
"uncertain" to "yes" at the default 0.70 threshold.

Scores in the 0.60-0.75 band are not actionable on a single run.

Options:

- **Raise the threshold.** `act_above: 0.85` requires a stronger signal and
  avoids the variance band entirely. Use for consequential decisions (blocking
  an edit, skipping a review).
- **Run twice.** Take the lower score. If both runs agree, the signal is real.
- **Decompose.** A `jev_ask` with 5 binary checks gives you 5 numbers, each
  with its own reliability. One ambiguous dimension among four clear ones is
  still useful.
- **Accept the uncertainty.** For triage (not final judgment), a score of 0.65
  means "worth a closer look." Set `review_above: 0.5` and treat Jev as a
  filter, not a verdict.

## Small items: high false-positive rate

Files under 200 lines and short text blocks produce inflated scores. Measured:

| File | Lines | Content | Splittability score | Ground truth |
|---|---|---|---|---|
| `constants.ts` | 162 | Pure data, 8 exports | 0.73 ("uncertain") | Not splittable |
| `env.ts` | 189 | Config registry, `Object.defineProperty` loop | 0.89 ("yes") | Coupled invariant, not splittable |

2 of 4 small files tested were false positives. Jev does not have enough
signal to distinguish structure from noise in short inputs.

**Rule: on items under 200 lines, either skip Jev or require `act_above: 0.90`.**

## Cross-artifact reasoning: not supported

Jev evaluates each item independently. It cannot reason about:

- How two modules interact at an interface
- Whether a change in file A breaks an invariant in file B
- Temporal ordering across commits in a PR
- Compositional constraints that span sections of the same file

Tested: `env.ts` scored 1.27 bug-risk (low) because each section looks clean
in isolation. The real invariant — `Object.defineProperty` creating a coupling
between the secret flag and the initialization loop — spans two sections and
is invisible to per-section scoring. A subagent reading the whole file caught
it immediately.

**Rule: if the judgment requires "how does A interact with B," use a subagent.**

## `confidence` is distribution shape, not correctness

Jev's `confidence` field measures how peaked the probability distribution is,
not whether the answer is right. A `confidence: 0.95` on a wrong answer means
Jev is very sure about the wrong thing.

Confirmed independently by bernoulli.app's analysis of 1M+ Jev API calls:
confidence correlates with distribution entropy, not with ground-truth
accuracy.

Use `confidence` to decide whether to act (`>= 0.8`) or flag for review
(`0.5-0.8`). Do not use it to skip verification.

## Threshold guide

| Situation | `yes_at_or_above` | `act_above` | Why |
|---|---|---|---|
| High cost of false positive (auto-merge gate, skip review) | 0.85 | 0.90 | One miss is expensive |
| High cost of false negative (security screen, rule check) | 0.50 | 0.70 | Flag too many rather than miss one |
| Triage for further investigation (not final) | 0.50 | 0.60 | Jev as filter, subagent as judge |
| Default (balanced) | 0.70 | 0.80 | The shipped defaults, which work for most checks |

## When to skip Jev entirely

- The answer is deterministic: a grep, a lookup, an arithmetic check.
- You are going to read the artifact anyway — Jev adds a round trip for a
  judgment you will form yourself.
- The item is under 200 lines and accuracy matters.
- The judgment requires reasoning across multiple artifacts.
- Reproducibility is required — run-to-run variance exists.
