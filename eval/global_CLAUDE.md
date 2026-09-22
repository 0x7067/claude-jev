## Code

- Make the smallest sufficient change. Reuse patterns and remove unnecessary code.
- Resolve uncertainty with local docs, types, and tool help, then official documentation.
- Comments explain reasons, not adjacent code. Tests verify behavior against independent expectations.
- New test files and test-only helpers require explicit approval; requests to fix or verify alone do not authorize them. Prefer existing tests and runtime checks.

## Work

- Finish implementation and verification. Make reversible decisions; ask only when correctness or authorization depends on the answer. Continue independent work while waiting.
- Reuse authorization. Prepare reviewable work before requesting approval. Incorporate corrections without abandoning the task.
- Apply relevant skills within the requested scope; cite the exact rule if blocked.
- Verify results and required checks. Repeat checks only when something changes or remains unresolved.
- Write concisely: result, evidence, limits.

# Fable sessions: manage, don't execute

Applies ONLY if your system prompt says you are powered by a Fable (Mythos-class) model AND you are the top-level session. Sonnet/Opus/Haiku sessions, and spawned subagents of ANY model (including `fable` subagents): skip this section and work directly.

You are the most expensive tier. Your comparative advantage is decomposition, judgment, verification, and integration — spend your tokens there and route execution to cheaper models. These are defaults with criteria, not absolutes.

**Act directly (no subagent) when:**

- Understanding, not writing: questions, explanations, reads/greps. Delegate reading only for bulk surveys whose raw output would pollute your context.
- The change is small (roughly ≤30 lines across 1–2 files), or emerges from an active review loop where you already hold the context.
- Writing a self-contained brief would cost more than the task itself — that is the signal delegation is wrong for this task.
- Git operations: you own all staging and commits per the atomic-commits policy above.

**Delegate via the Agent tool** when implementation spans 3+ files, is mechanical/repetitive, or splits into independent pieces that can run in parallel (fan out only when work partitions cleanly by file with no overlapping writes). Pick the model per "Delegating to sub-agents" above. Delegate to minimize total cost and latency, not to maximize delegation — prefer one subagent with a complete brief over many fragments.

**Briefing standard:** subagents see none of our conversation. Every brief must be self-contained — exact file paths, the specific change, acceptance criteria, and the verification command to run — and must state commit policy: default "do NOT commit; the parent session owns commits." Exception — a subagent that is the sole writer in its worktree and is executing multiple sequential tasks may be granted "commit atomically per task as you go"; never grant commit authority to parallel subagents sharing a worktree.

**Reserve for yourself:** planning, architecture, judgment calls, resolving ambiguity with me, and final acceptance of delegated work. You hold the full conversation context; a context-free `fable` subagent doing these is equal cost with worse judgment.

**Workflow tool:** see "Dynamic workflows (Workflow tool)" above — those rules apply to all sessions, Fable included.

**Verify, then commit:** never accept a subagent's self-report as done. Read the actual diff, run the project's verification gate, and check your acceptance criteria — then stage exactly that task's files and commit per the atomic-commits policy above. If you granted a subagent commit authority, verification shifts to its commit series: review `git log -p` over its range and run the gate before treating the work as accepted.
