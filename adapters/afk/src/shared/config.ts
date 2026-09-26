import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isString, parseJsonObject } from "./json.js";

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function pluginOption(field: string): string {
  return (process.env[`CLAUDE_PLUGIN_OPTION_${field.toUpperCase()}`] ?? "").trim();
}

export function enabled(field: string): boolean {
  const value = pluginOption(field).toLowerCase();

  return value !== "false" && value !== "0";
}

let cachedVersion: string | undefined;

export function pluginVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = "unknown";
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = path.join(dir, ".claude-plugin", "plugin.json");

    if (fs.existsSync(candidate)) cachedVersion = readVersion(candidate);
    const parent = path.dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  return cachedVersion;
}

function readVersion(manifestPath: string): string {
  try {
    const manifest = parseJsonObject(fs.readFileSync(manifestPath, "utf8"));

    return manifest !== null && isString(manifest["version"]) ? manifest["version"] : "unknown";
  } catch {
    return "unknown";
  }
}
