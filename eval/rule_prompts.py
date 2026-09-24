#!/usr/bin/env python3
"""Compare rule wording on reviewed cases; never runs inside a hook.

Uses the provider key resolved by jev; API failures stop the experiment.
Requires a reviewed case file. Results preserve inputs and answers locally.
"""

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import jev
import rules

EVIDENCE = ('Judge only the supplied evidence. Identify the changed construct '
            'and the exact requirement or prohibition it matches. Preserve the '
            'rule scope and exceptions. Do not invent approval history, callers, '
            'or contents of files not shown. An expectation supplied as a literal '
            'test input is independent when the assertion checks the result of '
            'executing production behavior; sharing the input value does not '
            'alone make an assertion tautological. ')


def questions(case):
    rule = dict(text=case['rule'], polarity=case['polarity'], when='edit')
    original = rules.rule_question(rule)
    concrete = dict(original, instructions=EVIDENCE + original['instructions'])
    return {
        'current': original,
        'concrete': concrete,
        'applicable': {'type': 'noul', 'instructions':
            f"Does the changed code fall within this rule's scope, including its exceptions: {case['rule']}?"},
        'evidence': {'type': 'noul', 'instructions':
            f"Does the supplied material contain the evidence needed to decide compliance with this rule, including any approval history or external definitions it requires: {case['rule']}?"},
        'violation': {'type': 'noul', 'instructions': EVIDENCE +
            f"Does the supplied evidence demonstrate that the changed code breaks this rule: {case['rule']}?"},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cases', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--repeats', type=int, default=2, choices=range(1, 4))
    args = p.parse_args()
    cases = [json.loads(s) for s in pathlib.Path(args.cases).read_text().splitlines() if s.strip()]
    if not 1 <= len(cases) <= 12:
        p.error('use between 1 and 12 reviewed cases')
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    jev.CALL_LOG = str(output.with_suffix('.calls.jsonl'))
    with output.open('x') as f:
        for repeat in range(args.repeats):
            for case in cases:
                qs = questions(case)
                answers = jev.ask(case['state'], qs)
                scores = {k: rules.verdict(v) for k, v in answers.items()}
                record = dict(case=case, repeat=repeat, questions=qs,
                              answers=answers, version=jev.version())
                f.write(json.dumps(record) + '\n')
                f.flush()
                print(case['id'], case['label'], scores, flush=True)


if __name__ == '__main__':
    main()
