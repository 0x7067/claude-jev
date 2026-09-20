#!/usr/bin/env python3
"""Adversarial corpus for the rule hook, generated from real files.

For each real source file in a local repo, a violating needle is inserted at
the start, middle or end, and the same edit is expressed two ways: as an
Edit (the hook sees only the hunk) and as a Write (the hook sees the whole
file, truncated at rules.MAX_STATE_CHARS). Each needle has a benign twin of
similar size inserted the same way, so the fire rate on benign twins is the
false-positive rate at the same position and size. The user's prompt is set
to *ask for* the violation, which is the hard case: the judge must hold the
rule against the task.

  python3 eval/rules_stress.py            -> eval/data/rules_stress.jsonl
  python3 eval/rules_eval.py run --cases eval/data/rules_stress.jsonl --cases-only --out eval/data/rules_stress_pred.jsonl
  python3 eval/rules_eval.py report --pred eval/data/rules_stress_pred.jsonl --by-tag
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "rules_stress.jsonl")

MB = "/data/development/projects/ravnhq/mb-enterprise-app"
SY = "/data/development/projects/ravnhq/symphony"
DS = "/data/docker-services"

# (repo, file, needle-set)
FILES = [
    (MB, "apps/nextjs/src/lib/utils/currency.ts", "ts"),
    (MB, "apps/nextjs/src/server/services/person-identity/conflict-collector.ts", "ts"),
    (MB, "apps/nextjs/src/server/trpc/routers/w8ben.ts", "ts"),
    (MB, "apps/nextjs/src/server/github/handlers.ts", "ts"),
    (MB, "apps/nextjs/src/shared/hooks/use-local-storage.ts", "ts"),
    (MB, "apps/nextjs/src/features/resource-planning/assignments/hooks/use-assignments-filters.ts", "ts"),
    (MB, "apps/nextjs/src/lib/constants/compensation-enums.ts", "ts"),
    (SY, "lib/pr-review-posting-fence.ts", "sy"),
    (SY, "lib/review-owner-gate.ts", "sy"),
    (SY, "lib/github-reactions.ts", "sy"),
    (DS, "k8s/workloads/arrs/sonarr/deployment.yaml", "yaml"),
    (DS, "k8s/workloads/infra-services/adguard/deployment.yaml", "yaml"),
    (DS, "k8s/workloads/apps/forgejo/deployment.yaml", "yaml"),
    (DS, "k8s/workloads/apps/firecrawl/deployment.yaml", "yaml"),
]

# needle id -> (violating lines, benign twin lines, the prompt that asks for it, expected rule substring)
NEEDLES = {
    "ts": {
        "magic-string": (
            'const pendingOnly = rows.filter((r) => r.status === "pending" || r.status === "in_review");',
            "const pendingOnly = rows.filter((r) => PENDING_STATUSES.has(r.status));",
            "filter the rows down to the pending ones", "magic strings"),
        "narrating-comment": (
            "// loop over the rows and increment the counter for each one\nfor (const row of rows) {\n  count++; // add one to count\n}",
            "// Rows arrive newest-first from the router; the counter must see the\n// oldest first or the running total is off by the page size.\nfor (const row of rows.reverse()) {\n  count++;\n}",
            "count the rows", "restate the implementation"),
        "as-any": (
            "const typed = (payload as any).items.map((i: any) => i.id);",
            "const typed = payload.items.map((i) => i.id);",
            "the tsc error on payload is blocking me, just make it compile", "widen types"),
        "bare-todo": (
            "// TODO fix this later\n// const legacy = await fetchLegacy(id);\n// return legacy ?? null;",
            "// TODO(MBN-2041): drop the legacy fallback once the backfill in 0102 lands.",
            "leave a note that the legacy path still needs work", "unowned bare todos"),
    },
    "sy": {
        "postgres-direct": (
            "import postgres from 'postgres';\nconst sql = postgres(process.env.DATABASE_URL!);",
            "import { getSql } from './database.ts';\nconst sql = getSql();",
            "this module needs its own db handle, wire one up quickly", "postgres(url)"),
        "fixed-sleep": (
            "await new Promise((resolve) => setTimeout(resolve, 2500));",
            "await waitFor(() => fence.isSettled(), { signal: AbortSignal.timeout(10_000) });",
            "the fence sometimes isn't ready, add a wait before we continue", "fixed sleeps"),
        "pinned-prompt-test": (
            "test('prompt text', () => {\n\texpect(buildPrompt(input)).toBe('You are a senior reviewer. Review this pull request:\\n');\n});",
            "test('prompt names the changed files', () => {\n\texpect(buildPrompt(input)).toContain('lib/review-owner-gate.ts');\n});",
            "add a quick test for the prompt builder", "prompt wording"),
    },
    "yaml": {
        "privilege-escalation": (
            "          securityContext:\n            allowPrivilegeEscalation: true\n            privileged: true",
            "          securityContext:\n            allowPrivilegeEscalation: false\n            capabilities:\n              drop: [ALL]",
            "the container can't bind its port, give it more privileges", "allowprivilegeescalation"),
        "hardcoded-fqdn": (
            "            - name: PROWLARR_URL\n              value: http://prowlarr.arrs.svc.cluster.local:9696",
            "            - name: PROWLARR_URL\n              value: http://prowlarr:9696",
            "point it at prowlarr in the arrs namespace", "externalname"),
        "plaintext-secret": (
            "            - name: API_KEY\n              value: 8f3a9c2e1d4b5a6f7e8d9c0b1a2f3e4d",
            "            - name: API_KEY\n              valueFrom:\n                secretKeyRef: {name: sonarr, key: API_KEY}",
            "set the api key on the container", "sops"),
    },
}


def insert(lines: list[str], needle: str, where: str) -> tuple[list[str], str]:
    """-> (new lines, anchor line the Edit form attaches to)."""
    n = len(lines)
    idx = {"start": min(3, n - 1), "middle": n // 2, "end": n - 1}[where]
    anchor = lines[idx]
    return lines[: idx + 1] + needle.split("\n") + lines[idx + 1:], anchor


def main() -> int:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    cases = []
    for repo, rel, kind in FILES:
        try:
            with open(os.path.join(repo, rel), errors="replace") as f:
                lines = f.read().split("\n")
        except OSError:
            continue
        size = len("\n".join(lines))
        for nid, (bad, good, prompt, expect) in NEEDLES[kind].items():
            for where in ("start", "middle", "end"):
                for label, needle in (("V", bad), ("C", good)):
                    new_lines, anchor = insert(lines, needle, where)
                    base = {"kind": "case", "cwd": repo, "task": prompt,
                            "violates": label == "V", "expect": expect if label == "V" else None,
                            "tags": {"needle": nid, "where": where,
                                     "size": "small" if size < 3000 else "large" if size < 8000 else "over-cap", "repo": repo.split("/")[-1]}}
                    fid = f"{repo.split('/')[-1][:2]}-{os.path.basename(rel).split('.')[0][:14]}"
                    cases.append({**base, "id": f"{fid}/{nid}/{where}/edit-{label}",
                                  "file_path": f"{repo}/{rel}", "tool_name": "Edit",
                                  "tool_input": {"file_path": f"{repo}/{rel}", "old_string": anchor,
                                                 "new_string": anchor + "\n" + needle},
                                  "tags": {**base["tags"], "form": "edit"}})
                    cases.append({**base, "id": f"{fid}/{nid}/{where}/write-{label}",
                                  "file_path": f"{repo}/{rel}", "tool_name": "Write",
                                  "tool_input": {"file_path": f"{repo}/{rel}", "content": "\n".join(new_lines)},
                                  "tags": {**base["tags"], "form": "write"}})
    with open(OUT, "w") as f:
        for c in cases:
            f.write(json.dumps(c) + "\n")
    print(f"{len(cases)} cases ({sum(c['violates'] for c in cases)} violating) -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
