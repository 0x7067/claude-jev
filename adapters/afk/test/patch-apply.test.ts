import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isJsonArray, isJsonObject, isString, parseJsonObject, type Json } from "../src/shared/json.ts";
import { editTargets } from "../src/shared/edit-targets.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const script = join(repoRoot, "adapters/afk/src/rules.ts");

const DELAY_MS = 150;

let server: Server;

let baseUrl = "";

let scratch = "";

let inFlight = 0;

let maxInFlight = 0;

const ruleStates: string[] = [];

function readRows(path: string): Json[] {
  let text = "";

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const rows: Json[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = parseJsonObject(line);

    if (row !== null) rows.push(row);
  }

  return rows;
}

function listen(ready: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    ready.once("error", reject);
    ready.listen(0, "127.0.0.1", () => resolve());
  });
}

function answersFor(body: Json): Json {
  const questions = isJsonObject(body["questions"]) ? body["questions"] : {};
  const keys = Object.keys(questions);
  const state = isString(body["state"]) ? body["state"] : "";
  const answers: Json = {};

  if (keys.includes("q0")) {
    for (const key of keys) {
      if (key.startsWith("q")) answers[key] = { noul: 0.95 };
      else if (key.startsWith("t")) answers[key] = { noul: 0.05 };
      else if (key.startsWith("p")) answers[key] = { choice: "forbid", confidence: 0.95 };
      else answers[key] = { choice: "other", confidence: 0.95 };
    }

    return answers;
  }

  ruleStates.push(state);

  for (const key of keys) {
    answers[key] = { noul: state.includes("console.log") ? 0.97 : 0.02 };
  }

  return answers;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  let raw = "";

  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    raw += chunk;
  });
  req.on("end", () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      const body = parseJsonObject(raw) ?? {};

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: answersFor(body) }));
    }, DELAY_MS);
  });
}

function runHook(input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      env,
      signal: AbortSignal.timeout(14000),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`hook exit ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jev-afk-patch-"));
  server = createServer(handle);
  await listen(server);
  const address = server.address();

  if (address === null || isString(address)) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Project {
  cwd: string;
  config: string;
  env: NodeJS.ProcessEnv;
}

function project(): Project {
  const cwd = mkdtempSync(join(scratch, "proj-"));
  const config = mkdtempSync(join(scratch, "cfg-"));
  const home = mkdtempSync(join(scratch, "home-"));

  writeFileSync(
    join(cwd, "CLAUDE.md"),
    "# Rules\n\n- Never call console.log in production source files.\n"
  );

  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: config,
    JEV_BASE_URL: baseUrl,
    TYPESAFE_API_KEY: "test-key",
  };

  return { cwd, config, env };
}

function editsLog(sessionId: string): Json[] {
  return readRows(join(scratch, `jev-afk-${sessionId}-edits.jsonl`));
}

function patchEvent(sessionId: string, cwd: string, changes: Json[], dryRun = false): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "patch_apply",
    tool_input: { changes, dry_run: dryRun },
    transcript_path: null,
  });
}

function resetServer(): void {
  ruleStates.length = 0;
  maxInFlight = 0;
}

test("the rules.ts matcher fires for patch_apply under AFK's regex path", () => {
  const hooks = parseJsonObject(readFileSync(join(repoRoot, "adapters/afk/hooks/hooks.json"), "utf8"));
  const pre = isJsonObject(hooks?.["hooks"]) ? hooks["hooks"]["PreToolUse"] : undefined;

  assert.equal(isJsonArray(pre), true);

  if (!isJsonArray(pre)) return;

  const group = pre.find(
    (g) => isJsonObject(g) && JSON.stringify(g["hooks"]).includes("src/rules.ts")
  );

  const matcher = isJsonObject(group) ? group["matcher"] : undefined;

  assert.equal(isString(matcher), true);

  if (!isString(matcher)) return;
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(matcher);

  assert.notEqual(m, null);
  const re = new RegExp(m?.[1] ?? "", (m?.[2] ?? "").replace(/[gy]/g, ""));

  for (const name of ["edit_file", "write_file", "patch_apply"]) assert.equal(re.test(name), true, name);

  for (const name of ["MultiEdit", "Edit", "agent", "bash", "patch_apply_x"]) {
    assert.equal(re.test(name), false, name);
  }
});

test("editTargets reads one target per patch_apply file and keeps edit_file unchanged", () => {
  const cwd = "/repo";

  const patch = editTargets(
    "patch_apply",
    {
      changes: [
        { path: "src/a.ts", edits: [{ old: "x = 1", new: "x = 2" }, { old: "y", new: "z" }] },
        { path: "/repo/src/b.ts", content: "export const b = 1;\n" },
        { path: "src/empty.ts", edits: [] },
        { path: "src/a.ts", content: "tail" },
      ],
    },
    cwd
  );

  assert.equal(patch.patch, true);
  assert.deepEqual(
    patch.targets.map((t) => [t.filePath, t.rel]),
    [
      ["/repo/src/a.ts", "src/a.ts"],
      ["/repo/src/b.ts", "src/b.ts"],
    ]
  );
  assert.equal(
    patch.targets[0]?.hunk,
    "REMOVED:\nx = 1\nADDED:\nx = 2\n\nREMOVED:\ny\nADDED:\nz\n\ntail"
  );
  assert.equal(patch.targets[1]?.hunk, "export const b = 1;");

  const dry = editTargets("patch_apply", { changes: [{ path: "a.ts", content: "x" }], dry_run: true }, cwd);

  assert.deepEqual(dry, { patch: true, targets: [] });

  const edit = editTargets(
    "edit_file",
    { file_path: "/repo/src/c.ts", old_string: "a", new_string: "b" },
    cwd
  );

  assert.deepEqual(edit, {
    patch: false,
    targets: [{ filePath: "/repo/src/c.ts", rel: "src/c.ts", hunk: "REMOVED:\na\nADDED:\nb" }],
  });

  const write = editTargets("write_file", { file_path: "/repo/d.ts", content: "hello\n" }, cwd);

  assert.equal(write.targets[0]?.hunk, "hello");
});

test("a clean patch judges every file in parallel and records each for the Stop sweep", { timeout: 15000 }, async () => {
  const { cwd, config, env } = project();
  const sessionId = "patch-clean";

  resetServer();

  const out = await runHook(
    patchEvent(sessionId, cwd, [
      { path: "src/a.ts", edits: [{ old: "const a = 1;", new: "const a = 2;" }] },
      { path: "src/b.ts", content: "export const b = 3;\n" },
      { path: "src/c.ts", content: "export const c = 4;\n" },
    ]),
    env
  );

  assert.equal(out, "");
  assert.equal(ruleStates.length, 3);
  assert.equal(maxInFlight > 1, true, `max in flight ${maxInFlight}`);
  assert.deepEqual(
    ruleStates.map((s) => s.split("\n")[0]).sort(),
    ["File: src/a.ts", "File: src/b.ts", "File: src/c.ts"]
  );

  const recorded = editsLog(sessionId);

  assert.deepEqual(
    recorded.map((r) => r["rel"]),
    ["src/a.ts", "src/b.ts", "src/c.ts"]
  );
  assert.equal(recorded[0]?.["hunk"], "REMOVED:\nconst a = 1;\nADDED:\nconst a = 2;");

  const rows = readRows(join(config, "jev-router-log.jsonl"));

  assert.equal(rows.length, 3);
  assert.equal(rows.every((r) => r["kind"] === "rules" && r["phase"] === "edit"), true);
  assert.deepEqual(
    rows.map((r) => r["file"]).sort(),
    [join(cwd, "src/a.ts"), join(cwd, "src/b.ts"), join(cwd, "src/c.ts")]
  );
});

test("one violating file blocks the whole patch and nothing is recorded", { timeout: 15000 }, async () => {
  const { cwd, config, env } = project();
  const sessionId = "patch-block";

  resetServer();

  const out = await runHook(
    patchEvent(sessionId, cwd, [
      { path: "src/clean.ts", content: "export const ok = 1;\n" },
      { path: "src/bad.ts", edits: [{ old: "run();", new: "console.log('x');\nrun();" }] },
    ]),
    env
  );

  const decision = parseJsonObject(out.trim());

  assert.equal(decision?.["decision"], "block");
  const reason = decision?.["reason"];

  assert.equal(isString(reason), true);

  if (!isString(reason)) return;
  assert.match(reason, /none of its files were written/);
  assert.match(reason, /In src\/bad\.ts:/);
  assert.doesNotMatch(reason, /src\/clean\.ts/);
  assert.equal(existsSync(join(scratch, `jev-afk-${sessionId}-edits.jsonl`)), false);

  const rows = readRows(join(config, "jev-router-log.jsonl"));
  const bad = rows.find((r) => r["file"] === join(cwd, "src/bad.ts"));
  const clean = rows.find((r) => r["file"] === join(cwd, "src/clean.ts"));

  assert.equal(rows.length, 2);
  assert.equal(isJsonArray(bad?.["blocked"]) && bad["blocked"].length === 1, true);
  assert.deepEqual(clean?.["blocked"], []);

  const state = parseJsonObject(readFileSync(join(scratch, `jev-afk-${sessionId}.json`), "utf8"));
  const blocks = isJsonObject(state?.["blocks"]) ? Object.keys(state["blocks"]) : [];

  assert.equal(blocks.length, 1);
  assert.match(blocks[0] ?? "", /\|src\/bad\.ts$/);
});

test("a dry_run patch is neither judged nor recorded", { timeout: 15000 }, async () => {
  const { cwd, config, env } = project();
  const sessionId = "patch-dry";

  resetServer();

  const out = await runHook(
    patchEvent(sessionId, cwd, [{ path: "src/bad.ts", content: "console.log('x');\n" }], true),
    env
  );

  assert.equal(out, "");
  assert.equal(ruleStates.length, 0);
  assert.equal(existsSync(join(scratch, `jev-afk-${sessionId}-edits.jsonl`)), false);
  assert.equal(existsSync(join(config, "jev-router-log.jsonl")), false);
});

test("a single edit_file still blocks with its own message", { timeout: 15000 }, async () => {
  const { cwd, env } = project();
  const sessionId = "edit-block";

  resetServer();

  const out = await runHook(
    JSON.stringify({
      session_id: sessionId,
      cwd,
      tool_name: "edit_file",
      tool_input: { file_path: join(cwd, "src/a.ts"), old_string: "run();", new_string: "console.log(1);" },
    }),
    env
  );

  const decision = parseJsonObject(out.trim());

  assert.equal(decision?.["decision"], "block");
  assert.match(String(decision?.["reason"]), /so it was not applied/);
  assert.match(String(decision?.["reason"]), /Rewrite the edit to src\/a\.ts/);
});

test("malformed patch_apply input fails open", { timeout: 15000 }, async () => {
  const { cwd, env } = project();

  resetServer();

  for (const input of [
    "not json",
    JSON.stringify({ session_id: "bad", cwd, tool_name: "patch_apply", tool_input: { changes: "nope" } }),
    JSON.stringify({ session_id: "bad", cwd, tool_name: "patch_apply", tool_input: { changes: [null, 3, { path: 7 }] } }),
  ]) {
    assert.equal(await runHook(input, env), "");
  }

  assert.equal(ruleStates.length, 0);
});
