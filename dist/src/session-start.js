#!/usr/bin/env node
import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.js";
import { writeOutput } from "../adapters/afk/src/shared/stdout.js";
import { loadRules } from "../adapters/afk/src/shared/rule-parser.js";
import { formatDigest } from "../adapters/afk/src/shared/digest.js";
import { configDir } from "../adapters/afk/src/shared/config.js";
function cachePath() {
    return path.join(configDir(), "jev-ts-rules-cache.json");
}
async function main() {
    const event = await readStdinJson();
    const cwd = event.cwd || process.cwd();
    const allRules = await loadRules(cwd, { cachePath: cachePath() });
    if (allRules.length === 0)
        return;
    const digest = formatDigest(allRules);
    if (!digest)
        return;
    writeOutput({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: digest,
        },
    });
}
try {
    await main();
}
catch {
}
//# sourceMappingURL=session-start.js.map