import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isString, parseJsonObject, type Json } from "../src/shared/json.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let server: Server;

let baseUrl = "";

let scratch = "";

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

function runHook(script: string, input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      env,
      signal: AbortSignal.timeout(12000),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`hook exit ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jev-afk-classify-"));
  server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("nope");
  });
  await listen(server);
  const address = server.address();

  if (address === null || isString(address)) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function project(): Promise<{ cwd: string; config: string; home: string }> {
  const cwd = mkdtempSync(join(scratch, "proj-"));
  const config = mkdtempSync(join(scratch, "cfg-"));
  const home = mkdtempSync(join(scratch, "home-"));

  writeFileSync(
    join(cwd, "CLAUDE.md"),
    "# Rules\n\n- Never call console.log in production source files.\n"
  );

  return { cwd, config, home };
}

function envFor(home: string, config: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: config,
    JEV_BASE_URL: baseUrl,
    TYPESAFE_API_KEY: "test-key",
  };
}

test("a classification failure after Jev was called is rules-error", { timeout: 15000 }, async () => {
  const { cwd, config, home } = await project();
  const script = join(repoRoot, "adapters/afk/src/rules.ts");

  const event = {
    session_id: "classify-edit",
    cwd,
    tool_name: "edit_file",
    tool_input: {
      file_path: join(cwd, "src/a.ts"),
      old_string: "const x = 1;\n",
      new_string: "const x = 2;\n",
    },
  };

  await runHook(script, JSON.stringify(event), envFor(home, config));
  const rows = readRows(join(config, "jev-router-log.jsonl"));
  const calls = readRows(join(config, "jev-calls.jsonl"));

  assert.equal(calls.some((call) => call["ok"] === false), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["kind"], "rules-error");
  const error = rows[0]?.["error"];

  assert.equal(isString(error), true);

  if (!isString(error)) return;
  assert.match(error, /HTTP 500/);
});

test("stop sweep classification failure is rules-error", { timeout: 15000 }, async () => {
  const { cwd, config, home } = await project();
  const sessionId = "classify-turn";

  writeFileSync(
    join(scratch, `jev-afk-${sessionId}-edits.jsonl`),
    JSON.stringify({ rel: "src/a.ts", hunk: "ADDED:\nconst x = 1;\n" }) + "\n"
  );
  const script = join(repoRoot, "adapters/afk/src/stop-sweep.ts");
  const event = { session_id: sessionId, cwd };

  await runHook(script, JSON.stringify(event), envFor(home, config));
  const rows = readRows(join(config, "jev-router-log.jsonl"));
  const calls = readRows(join(config, "jev-calls.jsonl"));

  assert.equal(calls.some((call) => call["ok"] === false), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["kind"], "rules-error");
  assert.equal(rows[0]?.["phase"], "turn");
});
