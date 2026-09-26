#!/usr/bin/env node
import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { jevAsk } from "./shared/jev-client.js";
import { subagentBundle, BRIEF_PARTS } from "./shared/questions.js";
import { asNoul, asChoice } from "./shared/jev-client.js";
const MIN_CONFIDENCE = 0.75;
const BRIEF_MISSING = 0.25;
async function main() {
    const event = await readStdinJson();
    const inp = event.tool_input ?? {};
    if (inp.model)
        return;
    const briefText = (inp.prompt ?? "").slice(0, 8000);
    if (!briefText.trim())
        return;
    const state = [
        `Agent type: ${inp.agent_type ?? "general"}`,
        `Task: ${briefText}`,
    ].join("\n\n");
    const answers = await jevAsk(state, subagentBundle(true));
    const tierA = asChoice(answers["model_tier"]);
    const tierChoice = tierA?.choice;
    const tierConf = tierA?.confidence ?? 0;
    const briefWrites = asNoul(answers["brief_writes"])?.noul ?? 0;
    const out = {
        hookSpecificOutput: { hookEventName: "PreToolUse" },
    };
    if (tierChoice && tierConf >= MIN_CONFIDENCE) {
        out.hookSpecificOutput.additionalContext =
            `[jev] recommended model tier: ${tierChoice} for this delegation`;
    }
    if (briefWrites >= MIN_CONFIDENCE) {
        const missing = [];
        for (const key of BRIEF_PARTS.keys()) {
            const noul = asNoul(answers[key])?.noul ?? 1;
            if (noul <= BRIEF_MISSING)
                missing.push(key);
        }
        if (missing.length > 0) {
            const listed = missing.map((k) => BRIEF_PARTS.get(k)).join("; ");
            const qualityNote = `[jev] brief quality: missing ${listed}. ` +
                `The subagent cannot see this conversation — add the missing parts to the prompt.`;
            const existing = out.hookSpecificOutput.additionalContext;
            out.hookSpecificOutput.additionalContext = existing
                ? `${existing}\n${qualityNote}`
                : qualityNote;
        }
    }
    const hasContent = out.hookSpecificOutput?.additionalContext;
    if (hasContent) {
        writeOutput(out);
    }
}
try {
    await main();
}
catch {
}
//# sourceMappingURL=subagent-router.js.map