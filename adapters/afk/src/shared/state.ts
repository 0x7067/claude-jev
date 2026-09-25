import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SessionState {
  blocks: Record<string, number>;
  stopBlocks: number;
}

export function statePath(sessionId: string): string {
  const safe = sessionId.replace(/[^\w-]/g, "_");
  return path.join(os.tmpdir(), `jev-afk-${safe}.json`);
}

export function loadState(sessionId: string): SessionState {
  try {
    const raw = fs.readFileSync(statePath(sessionId), "utf8");
    const data = JSON.parse(raw) as Partial<SessionState>;
    return {
      blocks: data.blocks ?? {},
      stopBlocks: data.stopBlocks ?? 0,
    };
  } catch {
    return { blocks: {}, stopBlocks: 0 };
  }
}

export function saveState(sessionId: string, state: SessionState): void {
  try {
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
  }
}
