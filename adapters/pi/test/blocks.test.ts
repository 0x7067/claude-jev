import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answers, DecisionBackend } from "../../afk/src/shared/jev-client.ts";
import { selectBlocks } from "../../../src/compact/strategy.ts";
import { BLOCK_BUDGET, blockFrom, blocksFrom, type AgentMessage, type LlmMessage } from "../blocks.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function agentUser(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistant(content: Extract<LlmMessage, { role: "assistant" }>["content"]): LlmMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

function agentAssistant(content: Extract<LlmMessage, { role: "assistant" }>["content"]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

function toolResult(text: string, toolCallId = "c1"): LlmMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function agentToolResult(text: string, toolCallId = "c1", toolName = "bash"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

test("blockFrom carries pi's text through with its role", () => {
  assert.deepEqual(blockFrom(user("keep the fixtures generated")), {
    role: "user",
    text: "keep the fixtures generated",
  });
});

test("blockFrom writes the tool markers the checks are keyed on", () => {
  const block = blockFrom(
    assistant([
      { type: "thinking", thinking: "let me look at the file first" },
      { type: "text", text: "reading it now" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
    ])
  );

  assert.ok(block !== undefined);
  assert.deepEqual(block, {
    role: "assistant",
    text: 'reading it now\n[tool_use read] {"path":"src/a.ts"}',
    refs: ["src/a.ts"],
  });
  assert.equal(block.text.includes("let me look"), false);
});

test("blockFrom gives a tool result the role tool, not user", () => {
  assert.deepEqual(blockFrom(toolResult("export const a = 1")), {
    role: "tool",
    text: "[tool_result bash] export const a = 1",
  });
});

test("blockFrom keeps a command the user ran out of the user role", () => {
  assert.equal(blockFrom(user("run the tests"))?.role, "user");

  const out = blocksFrom([
    {
      role: "bashExecution",
      command: "npm test",
      output: "2 failing",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, "bash");
  assert.ok(out[0]?.text.startsWith("Ran `npm test`"));
});

test("blocksFrom keeps a summary pi wrote out of the user role too", () => {
  const out = blocksFrom([
    { role: "branchSummary", summary: "## Goal\nShip it", fromId: null, timestamp: 0 },
    agentUser("and now push it"),
  ]);

  const roles: string[] = [];

  for (const block of out) roles.push(block.role);
  assert.deepEqual(roles, ["summary", "user"]);
  const folded = blocksFrom([agentUser("and now push it")], "## Goal\nShip it");

  assert.equal(folded[0]?.role, "summary");
});

test("blocksFrom links a tool result to its call by id, not by adjacency", () => {
  const out = blocksFrom([
    agentAssistant([
      { type: "text", text: "let me look at the file first" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
    ]),
    agentToolResult("export const a = 1"),
  ]);

  assert.equal(out.length, 2);
  assert.ok(out[0]?.text.startsWith("let me look"));
  assert.equal(out[1]?.needs, 0);
  assert.equal(out[0]?.needs, undefined);
});

test("blocksFrom leaves an unpaired result unlinked", () => {
  const out = blocksFrom([agentToolResult("orphan output")]);

  assert.equal(out[0]?.needs, undefined);
});

test("blockFrom truncates tool arguments and results where the port says to", () => {
  const call = blockFrom(
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "x".repeat(900) } }])
  );

  assert.equal(call?.text.length, "[tool_use bash] ".length + 400);
  const result = blockFrom(toolResult("y".repeat(2000)));

  assert.equal(result?.text, `[tool_result bash] ${"y".repeat(800)}`);
});

test("blockFrom drops what carries nothing worth a question", () => {
  assert.equal(blockFrom(user("ok")), undefined);
  assert.equal(blockFrom(user("")), undefined);
  assert.equal(blockFrom(user("<system-reminder>be careful</system-reminder>")), undefined);
  assert.equal(blockFrom(assistant([{ type: "thinking", thinking: "hmm" }])), undefined);
  assert.equal(blockFrom({ role: "system", content: "prompt", timestamp: 0 }), undefined);
});

test("blocksFrom flattens a span into blocks in order", () => {
  const out = blocksFrom([
    agentUser("add a replay harness"),
    agentAssistant([
      { type: "text", text: "on it" },
      { type: "toolCall", id: "c1", name: "read", arguments: {} },
    ]),
    agentToolResult("contents"),
  ]);

  const roles: string[] = [];

  for (const block of out) roles.push(block.role);
  assert.deepEqual(roles, ["user", "assistant", "tool"]);
  assert.equal(out[2]?.text, "[tool_result bash] contents");
});

test("blocksFrom splits a previous summary back into competing blocks", () => {
  const out = blocksFrom([agentUser("and now push it")], "## Goal\nShip the port\n\n## Next Steps\n1. push");
  const roles: string[] = [];

  for (const block of out) roles.push(block.role);
  assert.deepEqual(roles, ["summary", "summary", "user"]);
  assert.equal(out[2]?.text, "and now push it");
});

test("blocksFrom keeps the previous summary inside the block budget", () => {
  const priorLines: string[] = [];

  for (let i = 0; i < 40; i++) priorLines.push(`---[jev:${i}:user]---\nrequirement ${i}`);
  const prior = priorLines.join("\n\n");
  const messages: AgentMessage[] = [];

  for (let i = 0; i < BLOCK_BUDGET + 100; i++) messages.push(agentUser(`message ${i}`));
  const out = blocksFrom(messages, prior);

  assert.equal(out.length, BLOCK_BUDGET);
  assert.equal(out[0]?.text, "requirement 0");
  assert.equal(out[out.length - 1]?.text, `message ${BLOCK_BUDGET + 99}`);
});

test("a multi-tool turn holds the read result and not its sibling", async () => {
  const built = blocksFrom([
    agentAssistant([
      { type: "text", text: "looking and running" },
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "b1", name: "bash", arguments: { cmd: "ls" } },
    ]),
    agentToolResult("file body", "r1", "read"),
    agentToolResult("listing", "b1", "bash"),
    agentUser("pin 0"),
    agentUser("pin 1"),
    agentUser("pin 2"),
    agentUser("pin 3"),
  ]);

  assert.ok(built[0]?.text.includes("[tool_use read]"));
  assert.ok(built[0]?.text.includes("[tool_use bash]"));
  assert.equal(built[1]?.needs, built[2]?.needs);
  assert.ok(built[1]?.text.startsWith("[tool_result read]"));
  assert.ok(built[2]?.text.startsWith("[tool_result bash]"));

  const backend: DecisionBackend = {
    name: "low",
    async ask(_state, questions) {
      const answers: Answers = {};

      for (const key of Object.keys(questions)) answers[key] = { noul: 0.1 };

      return answers;
    },
  };

  const [out] = await selectBlocks(built, null, null, backend);

  assert.equal(
    out.some((k) => k.text.startsWith("[tool_result read]")),
    true
  );
  assert.equal(
    out.some((k) => k.text.startsWith("[tool_result bash]")),
    false
  );
});
