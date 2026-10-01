import { homedir } from "node:os";
import { join } from "node:path";
import { CALL_LOG, COMPACT_LOG } from "./log.ts";

export function configDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent");
}

export function dotEnvPath(): string {
  return join(configDir(), ".env");
}

export function callLogPath(): string {
  return join(configDir(), CALL_LOG);
}

export function compactLogPath(): string {
  return join(configDir(), COMPACT_LOG);
}

export function sessionsDir(): string {
  return join(configDir(), "sessions");
}
