import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isNumber, isString, parseJsonObject, type Json } from "../src/shared/json.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let slowServer: Server;

let slowUrl = "";

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

function runHook(
  script: string,
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number; elapsed: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      env,
      signal: AbortSignal.timeout(20000),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, elapsed: Date.now() - started });
    });
    child.stdin.end(input);
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jev-afk-sweep-timeout-"));

  slowServer = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: {} }));
    }, 10000);
  });
  await listen(slowServer);
  const address = slowServer.address();

  if (address === null || isString(address)) throw new Error("no port");
  slowUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  slowServer.close();
  rmSync(scratch, { recursive: true, force: true });
});

test(
  "cold-cache classification timeout in loadRules is bounded by the shared sweep budget",
  { timeout: 15000 },
  async () => {
    const cwd = mkdtempSync(join(scratch, "proj-"));
    const config = mkdtempSync(join(scratch, "cfg-"));
    const home = mkdtempSync(join(scratch, "home-"));
    const sessionId = "sweep-timeout-cold";

    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Rules\n\n- Never call console.log in production source files.\n"
    );

    writeFileSync(
      join(scratch, `jev-afk-${sessionId}-edits.jsonl`),
      JSON.stringify({ rel: "src/a.ts", hunk: "ADDED:\nconsole.log('x');\n" }) + "\n"
    );

    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: scratch,
      CLAUDE_CONFIG_DIR: config,
      JEV_BASE_URL: slowUrl,
      TYPESAFE_API_KEY: "test-key",
    };

    const script = join(repoRoot, "adapters/afk/src/stop-sweep.ts");
    const event = { session_id: sessionId, cwd };
    const { code, elapsed } = await runHook(script, JSON.stringify(event), env);

    assert.equal(code, 0, "hook must exit 0 (fail open)");
    assert.ok(elapsed < 7000, `hook took ${elapsed}ms, expected under 7s (sweep budget 4.5s + node startup ~0.5s)`);

    const rows = readRows(join(config, "jev-router-log.jsonl"));

    assert.equal(rows.length, 1, "must log exactly one row");
    assert.equal(rows[0]?.["kind"], "rules-error", "timed-out classification must log rules-error");
    assert.equal(rows[0]?.["phase"], "turn");

    const ms = rows[0]?.["ms"];

    assert.equal(isNumber(ms), true, "ms must be recorded");

    if (isNumber(ms)) {
      assert.ok(ms < 6000, `logged ms=${ms} should be under 6s (sweep budget)`);
    }
  }
);
