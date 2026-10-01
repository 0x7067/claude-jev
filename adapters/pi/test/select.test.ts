import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answers, DecisionBackend } from "../../afk/src/shared/jev-client.ts";
import {
  ASK_CHECKS,
  cutMarked,
  ELISION,
  fitKept,
  KEEP_THRESHOLD,
  MAX_BLOCKS,
  PIN_TAIL,
  RESCUE_BLOCKS,
  selectBlocks,
  truncateBlock,
  verdicts,
  judgeable,
  keepQuestions,
  type Block,
  type Kept,
} from "../../../src/compact/strategy.ts";

const block = (role: string, text: string, needs?: number): Block =>
  needs === undefined ? { role, text } : { role, text, needs };

function blocks(n: number, make: (i: number) => Block = (i) => block("user", `block ${i}`)): Block[] {
  const out: Block[] = [];

  for (let i = 0; i < n; i++) out.push(make(i));

  return out;
}

interface ScoreRow {
  constraint?: number;
  decision?: number;
  error?: number;
  open?: number;
  rerunnable?: number;
}

function scoreOf(row: ScoreRow | undefined, name: string): number {
  if (row === undefined) return 0;

  if (name === "constraint") return row.constraint ?? 0;

  if (name === "decision") return row.decision ?? 0;

  if (name === "error") return row.error ?? 0;

  if (name === "open") return row.open ?? 0;

  if (name === "rerunnable") return row.rerunnable ?? 0;

  return 0;
}

function answerWith(scores: readonly ScoreRow[]): DecisionBackend {
  return {
    name: "test",
    async ask(_state, questions) {
      const answers: Answers = {};

      for (const key of Object.keys(questions)) {
        const parts = key.split("_");
        const name = parts[0] ?? "";
        const index = Number(parts[1]);

        answers[key] = { noul: scoreOf(scores[index], name) };
      }

      return answers;
    },
  };
}

test("judgeable drops harness writes and one-word acks", () => {
  assert.equal(judgeable("user", ""), null);
  assert.equal(judgeable("user", "<system-reminder>be careful</system-reminder>"), null);
  assert.equal(judgeable("user", "<command-name>/compact</command-name>"), null);
  assert.equal(judgeable("user", "<task-notification>agent finished</task-notification>"), null);
  assert.equal(judgeable("user", "ok"), null);
  assert.equal(judgeable("user", "OK."), null);
  assert.equal(judgeable("user", "thanks"), null);
  assert.equal(judgeable("assistant", "ok"), "ok");
  assert.equal(judgeable("user", "ok, but keep the tests green"), "ok, but keep the tests green");
});

test("cutMarked leaves a short block alone", () => {
  assert.equal(cutMarked("short", 100), "short");
  assert.equal(cutMarked("exactly ten", 11), "exactly ten");
});

test("cutMarked prefers a paragraph break and reports what it cut", () => {
  const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
  const cut = cutMarked(text, 400);

  assert.equal(cut, `${"a".repeat(300)}\n${ELISION(text.length - 300)}`);
  assert.ok(ELISION(302).includes("re-read the file or re-run the command"));
});

test("cutMarked cuts mid-paragraph when there is no break to prefer", () => {
  const text = "x".repeat(1000);
  const cut = cutMarked(text, 100);

  assert.equal(cut.split("\n")[0], "x".repeat(100));
  assert.ok(cut.includes("900 chars elided"));
});

test("truncateBlock keeps the end of a long block", () => {
  const text = `${"h".repeat(500)}\n\n${"t".repeat(500)}`;
  const cut = truncateBlock(text);

  assert.ok(cut.startsWith("h".repeat(400)));
  assert.ok(cut.endsWith("t".repeat(150)));
  assert.ok(cut.includes("chars elided"));
  assert.equal(truncateBlock("y".repeat(400 + 150 + 200)), "y".repeat(400 + 150 + 200));
});

test("verdicts keeps on the strongest of the four keep checks", () => {
  const answers: Answers = {
    constraint_0: { noul: 0.1 },
    decision_0: { noul: 0.9 },
    error_0: { noul: 0 },
    open_0: { noul: 0.2 },
    rerunnable_0: { noul: 0 },
  };

  const { keep, full, checks } = verdicts(answers, 0);

  assert.equal(keep, 0.9);
  assert.equal(full, 0.1);
  assert.equal(Object.keys(checks).length, ASK_CHECKS.length);
});

test("verdicts lets a rerunnable score silence an error", () => {
  const rerunnable: Answers = { error_1: { noul: 0.9 }, rerunnable_1: { noul: KEEP_THRESHOLD } };

  assert.equal(verdicts(rerunnable, 1).full, 0);
  const notRerunnable: Answers = { error_1: { noul: 0.9 }, rerunnable_1: { noul: KEEP_THRESHOLD - 0.01 } };

  assert.equal(verdicts(notRerunnable, 1).full, 0.9);
});

test("verdicts answers null when nothing was scored", () => {
  const { keep, full, checks } = verdicts({}, 7);

  assert.equal(keep, null);
  assert.equal(full, null);
  assert.deepEqual(checks, {});
});

test("keepQuestions indexes every check by block position", () => {
  const questions = keepQuestions(3);

  assert.equal(Object.keys(questions).length, 3 * ASK_CHECKS.length);
  assert.deepEqual(questions["constraint_2"], {
    type: "noul",
    instructions:
      "Does block [2] state a requirement, restriction, or preference from the user about how the work must be done: something not to touch, a tool or approach to use, a deadline, a scope limit?",
  });
  assert.deepEqual(Object.keys(keepQuestions(5, ["constraint"])), [
    "constraint_0",
    "constraint_1",
    "constraint_2",
    "constraint_3",
    "constraint_4",
  ]);
});

function kept(i: number, chars: number, extra: Partial<Kept> = {}): Kept {
  return {
    i,
    text: "z".repeat(chars),
    kind: "full",
    keep: 1,
    full: 1,
    ...extra,
  };
}

test("fitKept does nothing under the cap", () => {
  const input = [kept(0, 100), kept(1, 100)];

  assert.deepEqual(fitKept(input, blocks(2), 1000), input);
});

test("fitKept downgrades the least confident whole keep before dropping anything", () => {
  const source = blocks(2, () => block("user", `${"w".repeat(500)}\n\n${"v".repeat(500)}`));
  const input = [kept(0, 800, { full: 0.9 }), kept(1, 800, { full: 0.2 })];
  const out = fitKept(input, source, 1500);

  assert.equal(out.length, 2);
  assert.equal(out[0]?.kind, "full");
  assert.equal(out[1]?.kind, "truncated");
  assert.equal(out[1]?.escalated, true);
  assert.equal(out[1]?.text, truncateBlock(source[1]!.text));
});

test("fitKept drops the weakest keep first and the oldest on a tie", () => {
  const input = [kept(0, 500, { keep: 0.6 }), kept(1, 500, { keep: 0.6 }), kept(2, 500, { keep: 0.9 })];
  const out = fitKept(input, blocks(3, () => block("user", "q".repeat(900))), 600);

  assert.deepEqual(
    out.map((k) => k.i),
    [2]
  );
});

test("fitKept never touches the pinned tail", () => {
  const input = [kept(0, 500, { keep: 0.9 }), kept(1, 900, { pinned: true, keep: 0, full: 0 })];
  const out = fitKept(input, blocks(2, () => block("user", "q".repeat(900))), 600);

  assert.deepEqual(
    out.map((k) => k.i),
    [1]
  );
});

test("selectBlocks pins the newest tail and judges the rest", async () => {
  const [out, stats] = await selectBlocks(
    blocks(10),
    null,
    null,
    answerWith([{ constraint: 0.9 }, { decision: 0.8 }])
  );

  const pinned = out.filter((k) => k.pinned);

  assert.equal(stats.judged, 10 - PIN_TAIL);
  assert.equal(stats.pinned, PIN_TAIL);
  assert.deepEqual(
    pinned.map((k) => k.i),
    [6, 7, 8, 9]
  );
  assert.ok(out.some((k) => k.i === 0 && k.kind === "full"));
  assert.ok(out.some((k) => k.i === 1 && k.kind === "truncated"));
  assert.ok(!out.some((k) => k.i === 2));
});

test("selectBlocks keeps an unscored block whole rather than guessing", async () => {
  const failing: DecisionBackend = {
    name: "fail",
    async ask() {
      throw new Error("down");
    },
  };

  await assert.rejects(() => selectBlocks(blocks(10), null, null, failing), /every chunk failed/);

  const partial: DecisionBackend = {
    name: "partial",
    async ask(_state, questions) {
      const answers: Answers = {};

      for (const key of Object.keys(questions)) {
        if (key.endsWith("_0")) answers[key] = { noul: 0 };
      }

      return answers;
    },
  };

  const [out] = await selectBlocks(blocks(10), null, null, partial);

  assert.ok(out.some((k) => k.i === 1 && k.kind === "full"));
});

test("selectBlocks pulls a dropped tool call back in behind its kept result", async () => {
  const input = [
    block("assistant", '[tool_use read] {"path":"src/a.ts"}'),
    block("tool", "[tool_result] export const a = 1"),
    block("assistant", "chatter only"),
    block("user", "now make b"),
    ...blocks(4, (i) => block("user", `pinned tail ${i}`)),
  ];

  const [out] = await selectBlocks(input, null, null, answerWith([{}, { error: 0.9 }, {}, { open: 0.9 }]));
  const indices = out.map((k) => k.i);

  assert.ok(indices.includes(0));
  assert.ok(indices.includes(1));
  assert.ok(indices.indexOf(0) < indices.indexOf(1));
  assert.ok(!indices.includes(2));
  assert.equal(out.find((k) => k.i === 3)?.kind, "truncated");
});

test("selectBlocks holds a Pi read whose call starts with other text", async () => {
  const input: Block[] = [
    block("assistant", 'let me look first\n[tool_use read] {"path":"src/a.ts"}'),
    block("tool", "[tool_result] export const a = 1", 0),
    block("assistant", "chatter only"),
    block("user", "now make b"),
    ...blocks(PIN_TAIL, (i) => block("user", `pinned tail ${i}`)),
  ];

  const [held] = await selectBlocks(input, null, null, answerWith([{}, { constraint: 0.1 }]));

  assert.ok(held.some((k) => k.i === 1));

  const claude = [
    block("assistant", '[tool_use Read] {"file_path":"src/a.ts"}'),
    block("tool", "[tool_result] export const a = 1"),
    block("assistant", "chatter only"),
    block("user", "now make b"),
    ...blocks(PIN_TAIL, (i) => block("user", `pinned tail ${i}`)),
  ];

  const [also] = await selectBlocks(claude, null, null, answerWith([{}, { constraint: 0.1 }]));

  assert.ok(also.some((k) => k.i === 1));

  const other: Block[] = [
    block("assistant", 'let me run it\n[tool_use bash] {"cmd":"ls"}'),
    block("tool", "[tool_result] file list", 0),
    block("assistant", "chatter only"),
    block("user", "now make b"),
    ...blocks(PIN_TAIL, (i) => block("user", `pinned tail ${i}`)),
  ];

  const [dropped] = await selectBlocks(other, null, null, answerWith([{}, { constraint: 0.1 }]));

  assert.equal(
    dropped.some((k) => k.i === 1),
    false
  );
});

test("selectBlocks pulls in the block a kept result names, by link", async () => {
  const input: Block[] = [
    block("assistant", 'let me look first\n[tool_use read] {"path":"src/a.ts"}'),
    block("tool", "[tool_result] export const a = 1", 0),
    block("assistant", "chatter only"),
    block("user", "now make b"),
    ...blocks(4, (i) => block("user", `pinned tail ${i}`)),
  ];

  const [out] = await selectBlocks(input, null, null, answerWith([{}, { error: 0.9 }, {}, { open: 0.9 }]));
  const indices = out.map((k) => k.i);

  assert.ok(indices.includes(0));
  assert.ok(indices.indexOf(0) < indices.indexOf(1));
  assert.ok(!indices.includes(2));
});

test("selectBlocks cuts a block that only just misses the verbatim bar", async () => {
  const long = "reason ".repeat(200);

  const [out] = await selectBlocks(
    [block("assistant", long), ...blocks(PIN_TAIL)],
    null,
    null,
    answerWith([{ decision: 0.9, rerunnable: 0.9 }])
  );

  assert.equal(out[0]?.kind, "truncated");
  assert.equal(out[0]?.text, truncateBlock(long));
});

test("selectBlocks rescues an early constraint the window would otherwise drop", async () => {
  const total = MAX_BLOCKS + 20;
  const input = [block("user", "never touch the generated fixtures"), ...blocks(total - 1, (i) => block("assistant", `step ${i + 1}`))];

  const asked: string[] = [];

  const ask: DecisionBackend = {
    name: "rescue",
    async ask(_state, questions) {
      const answers: Answers = {};

      for (const key of Object.keys(questions)) {
        asked.push(key);
        answers[key] = { noul: key === "constraint_0" ? 0.95 : 0 };
      }

      return answers;
    },
  };

  const [out, stats] = await selectBlocks(input, null, null, ask);

  assert.ok(asked.includes("constraint_0"));
  assert.equal(stats.rescued, 1);
  assert.equal(out[0]?.i, 0);
  assert.equal(out[0]?.rescued, true);
});

test("selectBlocks only asks the constraint check inside the rescue window", async () => {
  const total = MAX_BLOCKS + RESCUE_BLOCKS + 20;
  const seen = new Map<number, Set<string>>();

  const ask: DecisionBackend = {
    name: "windows",
    async ask(_state, questions) {
      const answers: Answers = {};

      for (const key of Object.keys(questions)) {
        const parts = key.split("_");
        const name = parts[0] ?? "";
        const index = Number(parts[1]);
        const names = seen.get(index) ?? new Set<string>();

        names.add(name);
        seen.set(index, names);
        answers[key] = { noul: 0 };
      }

      return answers;
    },
  };

  await selectBlocks(blocks(total), null, null, ask);
  const windowStart = total - MAX_BLOCKS;
  const rescueLo = windowStart - RESCUE_BLOCKS;

  assert.equal(seen.get(rescueLo - 1), undefined);
  assert.deepEqual([...(seen.get(rescueLo) ?? [])], ["constraint"]);
  assert.deepEqual([...(seen.get(windowStart - 1) ?? [])], ["constraint"]);
  assert.equal(seen.get(windowStart)?.size, ASK_CHECKS.length);
  assert.equal(seen.get(total - PIN_TAIL - 1)?.size, ASK_CHECKS.length);
  assert.equal(seen.get(total - 1), undefined);
  assert.equal(seen.size, MAX_BLOCKS + RESCUE_BLOCKS - PIN_TAIL);
});

test("selectBlocks answers an empty selection for an empty transcript", async () => {
  const [out, stats] = await selectBlocks([], null, null, answerWith([]));

  assert.deepEqual(out, []);
  assert.equal(stats.judged, 0);
});

test("selectBlocks caps a kept block at 1500 characters", async () => {
  const long = "s".repeat(1500 * 3);

  const [out] = await selectBlocks(
    [block("user", long), ...blocks(PIN_TAIL)],
    null,
    null,
    answerWith([{ constraint: 0.9 }])
  );

  assert.equal(out[0]?.text, cutMarked(long, 1500));
  assert.ok(out[0]?.text.includes("chars elided"));
});

test("selectBlocks defaults to 16000 characters and honors a smaller budget", async () => {
  const input = blocks(12, () => block("user", "s".repeat(2000)));
  const scores: ScoreRow[] = [];

  for (let i = 0; i < 12; i++) scores.push({ constraint: 0.9 });
  const [wide] = await selectBlocks(input, null, null, answerWith(scores));
  const [tight] = await selectBlocks(input, null, null, answerWith(scores), 3000);
  let wideChars = 0;

  for (const item of wide) wideChars += item.text.length;
  assert.ok(wideChars <= 16000);
  assert.ok(wide.length > tight.length);
  assert.equal(tight.length, PIN_TAIL);
});
