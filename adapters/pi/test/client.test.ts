import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isString, parseJsonObject } from "../../afk/src/shared/json.ts";
import { missingKeyMessage, PROVIDERS, providerFor, resolve, status } from "../client.ts";

const VARS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_PROVIDER", "JEV_MODEL"];

const saved = new Map(VARS.map((name) => [name, process.env[name]]));

interface TestFiles {
  dotEnv: string;
  callLog: string;
}

let dir = "";

let files: TestFiles;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-jev-"));
  files = { dotEnv: join(dir, ".env"), callLog: join(dir, "jev-calls.jsonl") };

  for (const name of VARS) delete process.env[name];
});

after(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  rmSync(dir, { recursive: true, force: true });
});

function setEnv(vars: { [key: string]: string | undefined }): void {
  for (const name of VARS) delete process.env[name];

  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[name] = value;
  }
}

function setDotEnv(text: string): void {
  writeFileSync(files.dotEnv, text);
}

test("providerFor lets the key prefix pick, so an sk-or- key anywhere calls OpenRouter", () => {
  assert.equal(providerFor("sk-or-abc").name, "openrouter");
  assert.equal(providerFor("ts_abc").name, "typesafe");
  assert.equal(providerFor("").name, "typesafe");
  assert.equal(PROVIDERS.length, 2);
});

test("resolve reads only the process environment when given no dotenv path", () => {
  setEnv({});
  setDotEnv("TYPESAFE_API_KEY=ts_in_file\n");
  assert.equal(resolve().source, "missing");
  assert.equal(resolve({ dotEnv: files.dotEnv }).key, "ts_in_file");
});

test("resolve reports a missing key instead of raising", () => {
  setEnv({});
  rmSync(files.dotEnv, { force: true });
  assert.deepEqual(resolve(files), { source: "missing", key: "", provider: undefined });
  assert.equal(missingKeyMessage(undefined), "set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
});

test("resolve reads the launch environment", () => {
  setEnv({ TYPESAFE_API_KEY: "ts_key" });
  assert.equal(resolve(files).source, "env");
  assert.equal(resolve(files).key, "ts_key");
  assert.equal(resolve(files).provider?.name, "typesafe");
});

test("resolve falls back to the dotenv path the caller supplies", () => {
  setEnv({});
  setDotEnv("OPENROUTER_API_KEY=sk-or-from-file\n");
  const found = resolve(files);

  assert.equal(found.source, "dotenv");
  assert.equal(found.key, "sk-or-from-file");
  assert.equal(found.provider?.name, "openrouter");
});

test("resolve reads quoted and exported assignments", () => {
  setEnv({});
  setDotEnv('# a comment\nexport TYPESAFE_API_KEY="ts quoted"\n');
  assert.equal(resolve(files).key, "ts quoted");
});

test("resolve prefers the launch environment over the file", () => {
  setEnv({ TYPESAFE_API_KEY: "ts_from_env" });
  setDotEnv("TYPESAFE_API_KEY=ts_from_file\n");
  assert.equal(resolve(files).source, "env");
  assert.equal(resolve(files).key, "ts_from_env");
});

test("auto reads TYPESAFE_API_KEY first, whichever place it came from", () => {
  setEnv({});
  setDotEnv("OPENROUTER_API_KEY=sk-or-saved\nTYPESAFE_API_KEY=ts-saved\n");
  assert.equal(resolve(files).key, "ts-saved");
  setEnv({ TYPESAFE_API_KEY: "ts-env", OPENROUTER_API_KEY: "sk-or-env" });
  assert.equal(resolve(files).key, "ts-env");
});

test("a pinned provider reads only its own variable", () => {
  setEnv({ JEV_PROVIDER: "openrouter", TYPESAFE_API_KEY: "ts_key" });
  setDotEnv("");
  assert.equal(resolve(files).source, "missing");
  assert.equal(missingKeyMessage(resolve(files).provider), "set OPENROUTER_API_KEY");
  setEnv({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-pinned" });
  assert.equal(resolve(files).provider?.url, "https://openrouter.ai/api/v1/systemone");
});

test("a pin outranks the key prefix", () => {
  setEnv({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "sk-or-misfiled" });
  assert.equal(resolve(files).provider?.name, "typesafe");
});

test("status reports the key source but never the key", () => {
  setEnv({ TYPESAFE_API_KEY: "ts_secret_value" });
  setDotEnv("");
  const info = status(files);
  const manifest = parseJsonObject(readFileSync(join(import.meta.dirname, "..", "..", "..", "plugin.json"), "utf8"));
  const manifestVersion = manifest !== null && isString(manifest["version"]) ? manifest["version"] : "";

  assert.equal(info.key, "env");
  assert.equal(info.provider, "typesafe");
  assert.equal(info.pinned, "auto");
  assert.equal(info.version, manifestVersion);
  assert.equal(JSON.stringify(info).includes("ts_secret_value"), false);
});

test("status reports no last call when the caller logs nowhere", () => {
  setEnv({ TYPESAFE_API_KEY: "ts_key" });
  assert.equal(status().lastCall, undefined);
  assert.equal(status(files).lastCall, undefined);
});
