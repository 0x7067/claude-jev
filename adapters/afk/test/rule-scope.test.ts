import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isJsonObject, isString, parseJsonObject, type Json } from "../src/shared/json.ts";
import { globMatch, loadRules, rulePolarity } from "../src/shared/rule-parser.ts";
import { isOutside } from "../src/shared/hunks.ts";
import { editTargets } from "../src/shared/edit-targets.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const script = join(repoRoot, "adapters/afk/src/rules.ts");

const DESCRIPTIVE = [
  "Every overlay appends — there is no full-replace escape hatch yet.",
  "Three properties are load-bearing and each has a test: the **active session is excluded by identity** (its witness label, never by timestamp); anything whose newest content is inside a 1-hour grace window is never evicted.",
  "All AFK state under `~/.afk/` (never `~/.claude/`), resolved exclusively through `src/paths.ts`:",
];

const PROHIBITIONS = [
  "**Three mandatory indirections — each has exactly one read/write point, and CI enforces it.** Env vars: never `process.env`; use the typed `env` object.",
  "Never skip on win32; make the test portable.",
  "Do not hand-edit `content/registry/*.json`; update them with `pnpm sync:registry`.",
  "Subagents must not force-push, touch unrelated files, or combine issues.",
  "**No code comments.** Line, block, and JSDoc comments are banned in `scripts/`.",
  "`.agents/skills/` is canonical for shared agent skills; symlink them into tool `skills/` dirs, never copy.",
];

let server: Server;

let baseUrl = "";

let scratch = "";

const judged: string[] = [];

function answersFor(body: Json): Json {
  const questions = isJsonObject(body["questions"]) ? body["questions"] : {};
  const keys = Object.keys(questions);
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

  judged.push(isString(body["state"]) ? body["state"] : "");

  for (const key of keys) answers[key] = { noul: 0.97 };

  return answers;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  let raw = "";

  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    raw += chunk;
  });
  req.on("end", () => {
    const body = parseJsonObject(raw) ?? {};

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: answersFor(body) }));
  });
}

function listen(ready: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    ready.once("error", reject);
    ready.listen(0, "127.0.0.1", () => resolve());
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
  scratch = mkdtempSync(join(tmpdir(), "jev-afk-scope-"));
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

function hookEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: mkdtempSync(join(scratch, "home-")),
    TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(scratch, "cfg-")),
    JEV_BASE_URL: baseUrl,
    TYPESAFE_API_KEY: "test-key",
  };
}

test("a scope with includes and excludes needs one include and no exclude", () => {
  const scope = ["src/**", "!**/*.test.ts", "!**/bench/**"];

  assert.equal(globMatch("src/cli/run.ts", scope), true);
  assert.equal(globMatch("src/cli/run.test.ts", scope), false);
  assert.equal(globMatch("src/bench/load.ts", scope), false);
  assert.equal(globMatch("scripts/run.ts", scope), false);
});

test("an exclusion-only scope means everything except the excluded paths", () => {
  const scope = ["!**/*.test.ts", "! test/**"];

  assert.equal(globMatch("src/cli/run.ts", scope), true);
  assert.equal(globMatch("run.ts", scope), true);
  assert.equal(globMatch("src/cli/run.test.ts", scope), false);
  assert.equal(globMatch("test/helpers.ts", scope), false);
});

test("include-only scopes keep their old meaning", () => {
  assert.equal(globMatch("src/a.ts", ["src/**"]), true);
  assert.equal(globMatch("lib/a.ts", ["src/**"]), false);
  assert.equal(globMatch("lib/a.ts", ["", "  "]), true);
  assert.equal(globMatch("lib/a.ts", ["!"]), true);
});

test("paths outside the project root are outside, including absolute ones", () => {
  assert.equal(isOutside("../../../../../tmp/overflow-reconstruct.mts"), true);
  assert.equal(isOutside(".."), true);
  assert.equal(isOutside("/tmp/scratch.py"), true);
  assert.equal(isOutside("src/a.ts"), false);
  assert.equal(isOutside("..foo/a.ts"), false);
});

test("edit targets outside the project root resolve to a climbing path", () => {
  const cwd = mkdtempSync(join(scratch, "proj-"));
  const { targets } = editTargets("write_file", { file_path: "/tmp/overflow-reconstruct.mts", content: "x" }, cwd);

  assert.equal(targets.length, 1);
  assert.equal(isOutside(targets[0]!.rel), true);
});

test("descriptive sentences never become forbid rules", () => {
  for (const text of DESCRIPTIVE) assert.equal(rulePolarity("forbid", text), "require", text);
});

test("prohibitions stay forbid rules", () => {
  for (const text of PROHIBITIONS) assert.equal(rulePolarity("forbid", text), "forbid", text);
});

test("a require answer is never turned into forbid", () => {
  assert.equal(rulePolarity("require", "Never skip on win32; make the test portable."), "require");
});

test("loadRules applies the prohibition guard and exclusion scopes", async () => {
  const cwd = mkdtempSync(join(scratch, "proj-"));
  const lines = [...DESCRIPTIVE, ...PROHIBITIONS.slice(0, 2)].map((t) => `- ${t}`);

  lines.push("- Never read `process.env` directly in product code. (scope: !**/*.test.ts, !**/bench/**)");
  writeFileSync(join(cwd, "AFK.md"), "# Rules\n\n" + lines.join("\n") + "\n");

  const prior = process.env["JEV_BASE_URL"];
  const priorKey = process.env["TYPESAFE_API_KEY"];

  process.env["JEV_BASE_URL"] = baseUrl;
  process.env["TYPESAFE_API_KEY"] = "test-key";

  try {
    const rules = await loadRules(cwd, { afkRules: true, cachePath: join(scratch, `cache-${Date.now()}.json`) });
    const byText = new Map(rules.map((r) => [r.text, r]));

    for (const text of DESCRIPTIVE) assert.equal(byText.get(text)?.polarity, "require", text);

    for (const text of PROHIBITIONS.slice(0, 2)) assert.equal(byText.get(text)?.polarity, "forbid", text);

    const env = rules.find((r) => r.text.startsWith("Never read `process.env`"));

    assert.deepEqual(env?.scope, ["!**/*.test.ts", "!**/bench/**"]);
    assert.equal(globMatch("src/config.ts", env!.scope), true);
    assert.equal(globMatch("src/config.test.ts", env!.scope), false);
  } finally {
    if (prior === undefined) delete process.env["JEV_BASE_URL"];
    else process.env["JEV_BASE_URL"] = prior;

    if (priorKey === undefined) delete process.env["TYPESAFE_API_KEY"];
    else process.env["TYPESAFE_API_KEY"] = priorKey;
  }
});

test("the rule hook does not judge an edit outside the project root", async () => {
  const cwd = mkdtempSync(join(scratch, "proj-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "jev-afk-elsewhere-"));

  writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\n\n- Never call console.log in production source files.\n");
  judged.length = 0;

  try {
    const out = await runHook(
      JSON.stringify({
        session_id: "scope-outside",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "write_file",
        tool_input: { file_path: join(outsideDir, "scratch.mts"), content: "console.log(1);\n" },
      }),
      hookEnv()
    );

    assert.equal(out.trim(), "");
    assert.equal(judged.length, 0);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("the rule hook still blocks the same edit inside the project root", async () => {
  const cwd = mkdtempSync(join(scratch, "proj-"));

  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\n\n- Never call console.log in production source files.\n");
  judged.length = 0;

  const out = await runHook(
    JSON.stringify({
      session_id: "scope-inside",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "write_file",
      tool_input: { file_path: join(cwd, "src", "a.ts"), content: "console.log(1);\n" },
    }),
    hookEnv()
  );

  assert.match(out, /"decision":"block"/);
  assert.equal(judged.length, 1);
});
