import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isJsonObject, isNumber, parseJsonObject } from "./json.js";
export function statePath(sessionId) {
    const safe = sessionId.replace(/[^\w-]/g, "_");
    return path.join(os.tmpdir(), `jev-afk-${safe}.json`);
}
export function loadState(sessionId) {
    let raw;
    try {
        raw = fs.readFileSync(statePath(sessionId), "utf8");
    }
    catch {
        return { blocks: {}, stopBlocks: 0 };
    }
    const data = parseJsonObject(raw);
    if (data === null)
        return { blocks: {}, stopBlocks: 0 };
    const blocks = {};
    if (isJsonObject(data["blocks"])) {
        for (const [key, value] of Object.entries(data["blocks"])) {
            if (isNumber(value))
                blocks[key] = value;
        }
    }
    return { blocks, stopBlocks: isNumber(data["stopBlocks"]) ? data["stopBlocks"] : 0 };
}
export function saveState(sessionId, state) {
    try {
        fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
    }
    catch {
    }
}
//# sourceMappingURL=state.js.map