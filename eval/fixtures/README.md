# Fixture repos

Host files for the stress corpus. The judge reads them as the repo an edit
lands in, so they have to be real files of real length — the false-block rate
depends on how much surrounding code the judge mistakes for the agent's work.

`AGENTS.md` in each fixture is **generated** by `eval/rules_stress.py` from
`eval/rules_corpus.jsonl` and is not committed. Run the generator before the
eval, and edit the corpus rather than the generated file.

## ts/

Vendored from [hono](https://github.com/honojs/hono) at `main`, MIT licensed.
Upstream license text is kept at `ts/LICENSE.upstream`. Files are unmodified;
they are chosen to span the three size buckets the report cuts on (< 3000,
3000-8000, > 8000 characters).

## py/

Vendored from [requests](https://github.com/psf/requests) at `main`, Apache-2.0
licensed. Upstream license text is at `py/LICENSE.upstream`. Files are
unmodified. This repo's own scripts would have worked as hosts except that none
of them is under 3000 characters, so the small bucket had no member.

## yaml/

Kubernetes manifests written for this repo. No upstream, no license question.
They follow the conventions the yaml rules describe, so a benign twin inserted
into them is genuinely benign.

## Size buckets

`rules_stress.py` tags each case by host file size. Keep at least one file per
language in each bucket or that cut in the report goes dead.
