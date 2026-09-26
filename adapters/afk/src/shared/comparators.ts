import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addedBody, EXCLUDED_RE } from "./hunks.js";
import { TESTISH_RE } from "./rule-parser.js";
import { configDir } from "./config.js";

const VERSION = "0.45.3";

const RELEASE = (plat: string) =>
  `https://github.com/ast-grep/ast-grep/releases/download/${VERSION}/app-${plat}.zip`;

const SHA256: Record<string, string> = {
  "aarch64-apple-darwin":
    "6d2279dea5bea2ad79c66ea93f5fe54ba926e398a8a26de76c56db68fe59eac6",
  "x86_64-apple-darwin":
    "b2ffd26f42810340326a9e8a084bdc3647a8795c1a3f21fc06bd7bef3c7c5b2c",
  "aarch64-unknown-linux-gnu":
    "b39cfbc58da4b869a88b8a4bc57bd5deb0d24541e704cf7c257da7b53ec81c8f",
  "x86_64-unknown-linux-gnu":
    "f8ac830881339d1edee6b2652f54798c0f4da5a827f2db38a08ee31117783ce8",
};

const BIN_DIR = path.join(configDir(), `jev-bin/ast-grep-${VERSION}`);

const BIN = path.join(BIN_DIR, "ast-grep");

const RUN_TIMEOUT_MS = 1500;

const QUERY_BUDGET_MS = 3000;

const MAX_QUERIES = 6;

const MAX_HITS = 6;

const MAX_CHARS = 1200;

const MAX_LITERALS = 4;

const LANGS: Record<string, string> = {
  ".py": "python",
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
};

let noDownload = false;

interface Hit {
  path: string;
  line: number;
  col: number;
  text: string;
}

function triple(): string | null {
  const arch = os.arch() === "arm64" ? "aarch64" : os.arch() === "x64" ? "x86_64" : null;

  if (arch === null || os.platform() === "win32") return null;

  if (os.platform() === "darwin") return `${arch}-apple-darwin`;

  if (os.platform() === "linux") return `${arch}-unknown-linux-gnu`;

  return null;
}

function pathWhich(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    const candidate = path.join(dir, name);

    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
    }
  }

  return null;
}

export function which(): [string | null, string] {
  const found = pathWhich("ast-grep");

  if (found) return [found, "path"];

  try {
    fs.accessSync(BIN, fs.constants.X_OK);

    return [BIN, "cached"];
  } catch {
    return [null, "none"];
  }
}

export function spawnFetch(): void {
  if (noDownload || triple() === null) return;

  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "fetch"], {
      stdio: "ignore",
      detached: true,
    });

    child.unref();
  } catch {
  }
}

function unzipMember(buf: Buffer, member: string): Buffer | null {
  let eocd = -1;

  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    if (name === member) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);

      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

export async function fetchBinary(): Promise<boolean> {
  const plat = triple();

  if (plat === null || noDownload) return false;

  try {
    fs.accessSync(BIN, fs.constants.X_OK);

    return true;
  } catch {
  }

  try {
    const res = await fetch(RELEASE(plat), { signal: AbortSignal.timeout(120000) });

    if (!res.ok) return false;
    const payload = Buffer.from(await res.arrayBuffer());
    const { createHash } = await import("node:crypto");

    if (createHash("sha256").update(payload).digest("hex") !== SHA256[plat]) {
      noDownload = true;

      try {
        fs.rmSync(BIN, { force: true });
      } catch {
      }

      return false;
    }

    const data = unzipMember(payload, "ast-grep");

    if (!data) return false;
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmp = BIN + ".part";
    fs.writeFileSync(tmp, data, { mode: 0o755 });
    fs.renameSync(tmp, BIN);

    return true;
  } catch {
    return false;
  }
}

function langFor(rel: string): string | null {
  return LANGS[path.extname(rel).toLowerCase()] ?? null;
}

function run(
  pattern: string,
  lang: string,
  cwd: string,
  opts: { target?: string; stdin?: string } = {}
): Promise<Hit[]> {
  return new Promise((resolve) => {
    const [exe] = which();

    if (!exe || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      resolve([]);

      return;
    }

    const argv = ["run", "--pattern", pattern, "--lang", lang, "--json=compact"];

    if (opts.stdin !== undefined) argv.push("--stdin");
    else argv.push(opts.target ?? ".");
    let settled = false;

    const done = (hits: Hit[]) => {
      if (!settled) {
        settled = true;
        resolve(hits);
      }
    };

    const child = execFile(
      exe,
      argv,
      { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          done([]);

          return;
        }

        try {
          const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;

          if (!Array.isArray(raw)) {
            done([]);

            return;
          }

          const hits: Hit[] = [];

          for (const m of raw) {
            if (typeof m !== "object" || m === null) continue;
            const p = (m["file"] as string) ?? "";

            if (!p || EXCLUDED_RE.test(p)) continue;

            const start = (m["range"] as Record<string, unknown> | undefined)?.["start"] as
              | Record<string, unknown>
              | undefined;

            const line = start?.["line"];

            const text = String((m["lines"] ?? m["text"] ?? "") as string)
              .split(/\s+/)
              .join(" ");

            hits.push({
              path: p,
              line: typeof line === "number" ? line + 1 : 0,
              col: typeof start?.["column"] === "number" ? (start["column"] as number) : 0,
              text: text.slice(0, 200),
            });
          }

          done(hits);
        } catch {
          done([]);
        }
      }
    );

    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

class Budget {
  private started = performance.now();
  private n = 0;

  ok(): boolean {
    return this.n < MAX_QUERIES && performance.now() - this.started < QUERY_BUDGET_MS;
  }

  async run(
    pattern: string,
    lang: string,
    cwd: string,
    opts: { target?: string; stdin?: string } = {}
  ): Promise<Hit[]> {
    if (!this.ok()) return [];
    this.n++;

    return run(pattern, lang, cwd, opts);
  }
}

function block(label: string, hits: Hit[]): string {
  if (hits.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const h of hits) {
    const line = `${h.path}:${h.line}: ${h.text}`;

    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);

    if (lines.length >= MAX_HITS) break;
  }

  return (label + "\n" + lines.join("\n")).slice(0, MAX_CHARS);
}

const COMMENT_LINE = /^\s*(#|\/\/|\/\*|\*|<!--)/;

const NUMBER = /(?<![\w.])(-?\d[\d_]*(?:\.\d+)?)\b/g;

const STRING = /["']([^"'\n]{4,})["']/g;

const DECLARES = /(?:^|\s)(?:const|let|var)\s+\w+\s*=|^\s*[A-Z_][A-Z_0-9]*\s*=/;

const CALLED = /\b([a-z_]\w{2,})\s*\(/g;

const DEFINED =
  /^\s*(?:export\s+)?(?:async\s+)?(?:def|function)\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;

const NOT_A_CALL = new Set([
  "if", "for", "while", "return", "print", "expect", "it", "describe", "test",
  "require", "import", "def", "function", "catch", "switch", "super", "len",
  "str", "int", "range",
]);

async function literalHits(
  added: string,
  lang: string,
  cwd: string,
  b: Budget
): Promise<string> {
  const lits: string[] = [];

  for (const line of added.split("\n")) {
    if (DECLARES.test(line) || COMMENT_LINE.test(line)) continue;

    for (const m of line.matchAll(NUMBER)) {
      if (!["0", "1", "-1"].includes(m[1]!) && !lits.includes(m[1]!)) lits.push(m[1]!);
    }

    for (const m of line.matchAll(STRING)) {
      const quoted = `'${m[1]}'`;

      if (!lits.includes(quoted)) lits.push(quoted);
    }
  }

  const hits: Hit[] = [];

  for (const lit of lits.slice(0, MAX_LITERALS)) {
    if (lang === "python") {
      hits.push(...(await b.run(`$N = ${lit}`, lang, cwd)).filter((h) => h.col === 0));
    } else {
      hits.push(...(await b.run(`const $N = ${lit}`, lang, cwd)));
    }
  }

  return block(
    "Existing named constants with the same value as a literal this edit adds:",
    hits
  );
}

async function testHits(
  added: string,
  rel: string,
  lang: string,
  cwd: string,
  b: Budget
): Promise<string> {
  if (!TESTISH_RE.test(rel)) return "";

  const same: Hit[] = [];

  for (const pattern of ["expect($X).toBe($X)", "expect($X).toEqual($X)", "assert $X == $X"]) {
    same.push(...(await b.run(pattern, lang, cwd, { target: rel })));

    for (const h of await b.run(pattern, lang, cwd, { stdin: added })) {
      same.push({ ...h, path: rel });
    }
  }

  const names: string[] = [];

  for (const m of added.matchAll(CALLED)) {
    const n = m[1]!;

    if (!NOT_A_CALL.has(n) && !names.includes(n)) names.push(n);
  }

  const bodies: Hit[] = [];

  for (const name of names.slice(0, MAX_LITERALS)) {
    if (lang === "python") {
      bodies.push(...(await b.run(`def ${name}`, lang, cwd)));
    } else {
      bodies.push(...(await b.run(`function ${name}`, lang, cwd)));
      bodies.push(...(await b.run(`const ${name} = $ARROW`, lang, cwd)));
    }
  }

  return [
    block("Assertions in this file whose two sides are identical:", same),
    block("Bodies of the functions under test:", bodies),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ENCLOSING =
  /(?:^|\s)(?:def|function)\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/;

function enclosingName(filePath: string, added: string): string[] {
  const anchor = added.split("\n").find((line) => line.trim())?.trim() ?? "";

  if (!anchor) return [];
  let lines: string[];

  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }

  const at = lines.findIndex((line) => line.includes(anchor));

  if (at < 0) return [];
  let fallback: string[] = [];

  for (let i = at; i >= 0; i--) {
    const m = ENCLOSING.exec(lines[i] ?? "");

    if (!m) continue;

    if (m[1]) return [m[1]];

    if (fallback.length === 0 && m[2]) fallback = [m[2]];
  }

  return fallback;
}

const CATCHES = /\b(catch|except)\b/;

const THROWS = /\b(throw|raise|reject)\b/;

const RETURNS = /\breturn\b/;

const LOGS = /\b(console\.\w+|logger?\.\w+|print|log)\s*\(/;

async function errorHits(
  added: string,
  rel: string,
  lang: string,
  cwd: string,
  b: Budget
): Promise<string> {
  if (!CATCHES.test(added) && !/\berr(or)?\b/i.test(added)) return "";

  let what: string;

  if (THROWS.test(added)) what = "re-raises";
  else if (RETURNS.test(added)) what = "returns a value instead of re-raising";
  else what = "neither re-raises nor returns";

  const summary =
    `The error handling this edit adds ${what}` +
    (LOGS.test(added) ? " and logs." : " and does not log.");

  const names: string[] = [];

  for (const m of added.matchAll(DEFINED)) {
    const name = m[1] ?? m[2];

    if (name && !names.includes(name)) names.push(name);
  }

  if (names.length === 0) names.push(...enclosingName(path.join(cwd, rel), added));
  const hits: Hit[] = [];

  for (const name of names.slice(0, MAX_LITERALS)) {
    for (const h of await b.run(`${name}($$$)`, lang, cwd)) {
      if (path.normalize(h.path) !== path.normalize(rel)) hits.push(h);
    }
  }

  const listed = block(
    "Callers of the function whose error handling this edit changes:",
    hits
  );

  return listed ? `${summary}\n${listed}` : summary;
}

export async function comparator(
  subject: string,
  hunk: string,
  rel: string,
  cwd: string
): Promise<string> {
  try {
    const lang = langFor(rel);

    if (!lang || !cwd) return "";
    const [exe] = which();

    if (!exe) {
      spawnFetch();

      return "";
    }

    const added = addedBody(hunk);

    if (!added.trim()) return "";
    const b = new Budget();

    if (subject === "literals_constants") return await literalHits(added, lang, cwd, b);

    if (subject === "tests") return await testHits(added, rel, lang, cwd, b);

    if (subject === "errors") return await errorHits(added, rel, lang, cwd, b);

    return "";
  } catch {
    return "";
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cmd = process.argv[2] ?? "which";

  if (cmd === "fetch") {
    fetchBinary().then((ok) => process.exit(ok ? 0 : 1));
  } else {
    const [p, source] = which();
    console.log(`${p ?? "(none)"}  [${source}]  pinned ${VERSION} -> ${BIN}`);
  }
}
