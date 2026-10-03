import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isString } from "../src/shared/json.ts";
import { enabled } from "../src/shared/config.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let server: Server;

let baseUrl = "";

let scratch = "";

let hits = 0;

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

    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`hook exit ${code}`));
    });
    child.stdin.end(input);
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jev-afk-router-opt-in-"));
  server = createServer((_req, res) => {
    hits++;
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

function envWith(option: Record<string, string>): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(scratch, "home-"));

  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(scratch, "cfg-")),
    JEV_BASE_URL: baseUrl,
    TYPESAFE_API_KEY: "test-key",
    ...option,
  };
}

const routers = [
  {
    name: "prompt-router",
    option: "CLAUDE_PLUGIN_OPTION_PROMPTROUTER",
    event: { session_id: "router-opt-in", prompt: "fix the typo in the README heading" },
  },
  {
    name: "subagent-router",
    option: "CLAUDE_PLUGIN_OPTION_SUBAGENTROUTER",
    event: {
      session_id: "router-opt-in",
      tool_name: "agent",
      tool_input: { prompt: "Rename foo to bar in src/a.ts and run the tests." },
    },
  },
];

for (const r of routers) {
  const script = join(repoRoot, `adapters/afk/src/${r.name}.ts`);

  test(`${r.name} does not ask Jev when its option is unset`, { timeout: 15000 }, async () => {
    const before = hits;
    const out = await runHook(script, JSON.stringify(r.event), envWith({}));

    assert.equal(hits, before);
    assert.equal(out, "");
  });

  test(`${r.name} does not ask Jev when its option is false`, { timeout: 15000 }, async () => {
    const before = hits;
    const out = await runHook(script, JSON.stringify(r.event), envWith({ [r.option]: "false" }));

    assert.equal(hits, before);
    assert.equal(out, "");
  });

  test(`${r.name} asks Jev when its option is true`, { timeout: 15000 }, async () => {
    const before = hits;

    await runHook(script, JSON.stringify(r.event), envWith({ [r.option]: "true" }));
    assert.ok(hits > before);
  });
}

test("enabled keeps the Claude Code default on when the option is unset", () => {
  delete process.env["CLAUDE_PLUGIN_OPTION_JEVOPTINPROBE"];
  assert.equal(enabled("jevOptInProbe"), true);
  assert.equal(enabled("jevOptInProbe", false), false);
  process.env["CLAUDE_PLUGIN_OPTION_JEVOPTINPROBE"] = "true";
  assert.equal(enabled("jevOptInProbe", false), true);
  process.env["CLAUDE_PLUGIN_OPTION_JEVOPTINPROBE"] = "0";
  assert.equal(enabled("jevOptInProbe"), false);
  delete process.env["CLAUDE_PLUGIN_OPTION_JEVOPTINPROBE"];
});
