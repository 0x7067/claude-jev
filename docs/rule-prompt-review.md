# Rule prompt review

The first bounded screen uses one reconstructed live intervention and nine
constructed contrasts. Private inputs live in `eval/authored/prompt_review.jsonl`;
they are intentionally not committed and are not available in a fresh clone.

## Reviewed live evidence

A blocked schema-parser test used literal recipe names as inputs and compared
the parser's returned name with the supplied name. That is an independent
expectation: rejecting the name or returning another name fails the test.
The later edit classified as “repaired” therefore does not establish that the
hook helped. The review label is compliant against the current instruction.
The original surrounding file and request have not been reconstructed, so this
is a focused prompt screen, not an exact replay of the historical judgment.

A separate block concerned approval for a new test helper. Without the approval
history its correctness is unresolved. Synthetic contrasts supply unknown,
explicitly granted, and explicitly denied approval. No missed real violation
has been established by this review; the positive controls are constructed.

## Comparison

`eval/rule_prompts.py` asks five questions in one request per case:

- The current shipped question.
- The same question with explicit evidence boundaries and a concrete distinction
  between testing production behavior and comparing a value with itself.
- Whether the rule applies to the changed code.
- Whether the supplied evidence is sufficient to decide compliance.
- Whether that evidence demonstrates a violation.

Two repeats across ten cases require twenty API calls. All questions share the
same state. This allows a small comparison but does not rule out interactions
between questions in the batch. Scores and complete questions are saved next to
the case and its review label. Calls are logged beside the output rather than
into the live session statistics. Existing output files are never overwritten.

```bash
python3 eval/rule_prompts.py \
  --cases eval/authored/prompt_review.jsonl \
  --output eval/observed/prompt_review_results_v2.jsonl
```

For analysis, count blocks at the existing `rules.ACT` threshold separately on
compliant and violating cases. Inspect applicability and evidence scores on the
unknown case; do not relabel it compliant. Compare both repeats and preserve
misses, false positives, and variation. No threshold changes are part of this
experiment. A favorable small screen warrants the existing rule eval before
changing live behavior, not a claim of improved session accuracy.

The user explicitly approved the twenty-call external comparison. The first
approved request reached TypeSafe but returned HTTP 402 with `billing_error`:
the organization associated with the environment key had no available credits.
The runner stopped after that request; zero comparison records were produced.
The failure is recorded in `eval/observed/prompt_review_approved.calls.jsonl`.
No model comparison results are available yet, and the shipped prompts remain
unchanged. After credits are available, rerun with a new output filename.
