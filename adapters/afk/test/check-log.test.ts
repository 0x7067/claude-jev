import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { logCheck, loggedRuleKeys, logRulesLoadFailure, probsByRule } from "../src/shared/check-log.ts";
import { isJsonArray, isJsonObject, isString, parseJsonObject } from "../src/shared/json.ts";
import { RuleClassificationError, type Rule } from "../src/shared/rule-parser.ts";

function rule(id: string, text: string): Rule {
  return {
    id,
    text,
    file: "CLAUDE.md",
    line: 1,
    scope: [],
    when: "edit",
    fileHash: "abc",
    polarity: "forbid",
    subject: "other",
    context: "",
  };
}

test("probsByRule keeps both scores when two rules share an id", () => {
  const first = rule("dup", "first");
  const second = rule("dup", "second");

  const probs = probsByRule(
    [first, second],
    (r) => r.text,
    (key) => (key === "first" ? 0.2 : 0.9)
  );

  assert.equal(probs.size, 2);
  assert.equal(probs.get("dup"), 0.2);
  assert.equal(probs.get("dup-2"), 0.9);
});

test("probsByRule does not overwrite an id a duplicate suffix would collide with", () => {
  const first = rule("same", "first");
  const named = rule("same-2", "named");
  const second = rule("same", "second");

  const probs = probsByRule(
    [first, named, second],
    (r) => r.text,
    (key) => (key === "first" ? 0.1 : key === "named" ? 0.2 : 0.3)
  );

  assert.equal(probs.size, 3);
  assert.equal(probs.get("same"), 0.1);
  assert.equal(probs.get("same-2"), 0.2);
  assert.equal(probs.get("same-3"), 0.3);
});

test("logCheck stores each duplicate under the same key as its probability", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-check-log-"));
  const prev = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = dir;

  try {
    const first = rule("dup", "first");
    const second = rule("dup", "second");
    const rules = [first, second];
    const ids = loggedRuleKeys(rules);
    const probs = probsByRule(rules, (r) => r.text, (key) => (key === "first" ? 0.2 : 0.9));
    const secondKey = ids.get(second) ?? second.id;

    logCheck(
      { phase: "edit", sessionId: "s", cwd: dir, file: "a.ts" },
      {
        nRules: 2,
        nScopedOut: 0,
        nIrrelevant: 0,
        probs,
        hits: [
          { rule: first, logKey: ids.get(first) ?? first.id, prob: 0.2, band: "flag" },
          { rule: second, logKey: secondKey, prob: 0.9, band: "act" },
        ],
        blocked: [secondKey],
        ms: 4,
      }
    );
    const row = parseJsonObject(readFileSync(join(dir, "jev-router-log.jsonl"), "utf8"));
    const logged = row?.["probs"];
    const violations = row?.["violations"];

    assert.equal(isJsonObject(logged), true);

    if (!isJsonObject(logged)) return;
    assert.equal(logged["dup"], 0.2);
    assert.equal(logged["dup-2"], 0.9);
    assert.equal(isJsonArray(violations), true);

    if (!isJsonArray(violations)) return;
    const names: string[] = [];

    for (const v of violations) {
      names.push(isJsonObject(v) && isString(v["rule"]) ? v["rule"] : "");
    }

    assert.deepEqual(names, ["dup", "dup-2"]);
    assert.deepEqual(row?.["blocked"], ["dup-2"]);
  } finally {
    if (prev === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logRulesLoadFailure records classification failures as rules-error", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-load-fail-"));
  const prev = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = dir;
  const ctx = { phase: "edit" as const, sessionId: "s", cwd: dir, file: "a.ts" };

  try {
    logRulesLoadFailure(ctx, new RuleClassificationError("HTTP 500: nope"), 15);
    logRulesLoadFailure(ctx, new Error("EACCES"), 0);
    const rows: ReturnType<typeof parseJsonObject>[] = [];

    for (const line of readFileSync(join(dir, "jev-router-log.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      rows.push(parseJsonObject(line));
    }

    assert.equal(rows[0]?.["kind"], "rules-error");
    assert.equal(rows[0]?.["error"], "HTTP 500: nope");
    assert.equal(rows[0]?.["ms"], 15);
    assert.equal(rows[1]?.["kind"], "rules-skip");
    assert.equal(rows[1]?.["reason"], "rules-unreadable");
  } finally {
    if (prev === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
