#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStdinJson } from "./shared/stdin.js";
import { writeOutput } from "./shared/stdout.js";
import { jevAsk } from "./shared/jev-client.js";
import { asNoul } from "./shared/jev-client.js";
import { loadRules, globMatch, isSubjectRelevant, } from "./shared/rule-parser.js";
import { slugify } from "./shared/utils.js";
import { loadState, saveState } from "./shared/state.js";
const ACT = 0.80;
const FLAG = 0.50;
const MAX_BLOCKS = 2;
const MAX_STATE_CHARS = 8000;
function editsFilePath(sessionId) {
    const safe = sessionId.replace(/[^\w-]/g, "_");
    return path.join(os.tmpdir(), `jev-afk-${safe}-edits.jsonl`);
}
function appendEdit(sessionId, rel, hunk) {
    try {
        const line = JSON.stringify({ rel, hunk: hunk.slice(0, 2000) }) + "\n";
        fs.appendFileSync(editsFilePath(sessionId), line);
    }
    catch {
    }
}
function editHunks(inp = {}) {
    if (Array.isArray(inp.edits)) {
        const parts = [];
        for (const e of inp.edits) {
            let hunk = "";
            if (e.old_string)
                hunk += `REMOVED:\n${e.old_string}\n`;
            if (e.new_string)
                hunk += `ADDED:\n${e.new_string}`;
            if (hunk)
                parts.push(hunk);
        }
        return parts.join("\n\n");
    }
    if (inp.old_string != null || inp.new_string != null) {
        let hunk = "";
        if (inp.old_string)
            hunk += `REMOVED:\n${inp.old_string}\n`;
        if (inp.new_string)
            hunk += `ADDED:\n${inp.new_string}`;
        return hunk;
    }
    return inp.content ?? "";
}
function ruleQuestion(rule) {
    if (rule.polarity === "require") {
        return {
            type: "noul",
            instructions: `Does this edit add or change code that this rule clearly covers, ` +
                `and do it WITHOUT what the rule requires: "${rule.text}"? ` +
                `Answer yes only when both hold and the requirement is plainly ` +
                `missing from the new code and the surrounding lines shown. ` +
                `If the rule does not apply to what changed, or the requirement ` +
                `is met even imperfectly, answer no.`,
            criteria: {
                true: "A case the rule clearly governs was added, and the required element is absent.",
                false: "The rule does not govern what changed, the requirement is present, " +
                    "or it is a matter of degree or taste.",
            },
        };
    }
    return {
        type: "noul",
        instructions: `Does the ADDED or CHANGED code in this edit do what this rule forbids: ` +
            `"${rule.text}"? Judge only what the edit itself introduces, not pre-existing code.`,
        criteria: {
            true: "The new code visibly does the forbidden thing.",
            false: "The edit does not do it, or only removes or leaves untouched code that did.",
        },
    };
}
function verdict(answer) {
    const p = asNoul(answer)?.noul;
    return p === undefined ? 0 : Math.min(1, Math.max(0, p));
}
async function main() {
    const event = await readStdinJson();
    const inp = event.tool_input ?? {};
    const cwd = event.cwd ?? process.cwd();
    const sessionId = event.session_id ?? "unknown";
    const filePath = inp.file_path ?? "";
    const rel = path.relative(cwd, filePath) || path.basename(filePath);
    const hunk = editHunks(inp).trim();
    if (!hunk)
        return;
    appendEdit(sessionId, rel, hunk);
    let rules;
    try {
        rules = await loadRules(cwd);
    }
    catch {
        return;
    }
    if (rules.length === 0)
        return;
    const inScope = rules.filter((r) => r.when === "edit" &&
        (r.scope.length === 0 || globMatch(rel, r.scope)));
    if (inScope.length === 0)
        return;
    const relevant = inScope.filter((r) => isSubjectRelevant(hunk, r.subject, rel));
    if (relevant.length === 0)
        return;
    const questions = {};
    const qkeyMap = new Map();
    const seen = new Set();
    for (const r of relevant) {
        let key = slugify(r.text);
        let n = 2;
        while (seen.has(key)) {
            key = `${slugify(r.text)}-${n++}`;
        }
        seen.add(key);
        qkeyMap.set(r, key);
        questions[key] = ruleQuestion(r);
    }
    const stateText = [
        `File: ${rel}`,
        `The edit:\n${hunk.slice(0, MAX_STATE_CHARS)}`,
    ].join("\n\n");
    let answers;
    try {
        answers = await jevAsk(stateText, questions);
    }
    catch {
        return;
    }
    const hits = [];
    for (const r of relevant) {
        const key = qkeyMap.get(r) ?? slugify(r.text);
        const prob = verdict(answers[key]);
        if (prob >= FLAG) {
            hits.push({ rule: r, prob, band: prob >= ACT ? "act" : "flag" });
        }
    }
    if (hits.length === 0)
        return;
    const state = loadState(sessionId);
    const acting = [];
    for (const h of hits) {
        const blockKey = `${h.rule.id}|${rel}`;
        if (h.band === "act" && (state.blocks[blockKey] ?? 0) < MAX_BLOCKS) {
            state.blocks[blockKey] = (state.blocks[blockKey] ?? 0) + 1;
            acting.push(h);
        }
    }
    saveState(sessionId, state);
    const flagged = hits.filter((h) => !acting.includes(h));
    if (acting.length > 0) {
        const lines = [
            "This edit appears to break a rule from this repository's instructions.",
        ];
        for (const h of acting) {
            let text = h.rule.text.replace(/\s+/g, " ");
            if (text.length > 220)
                text = text.slice(0, 217) + "...";
            const where = h.rule.line
                ? `${h.rule.file} line ${h.rule.line}`
                : h.rule.file;
            lines.push(`- [${h.rule.polarity}/${h.rule.subject}] Rule "${h.rule.id}" from ${where}: "${text}" (${h.prob.toFixed(2)})`);
        }
        lines.push(`Repair ${rel} now, then continue with the task.`);
        writeOutput({
            decision: "block",
            reason: lines.join("\n"),
        });
        return;
    }
    // FLAG-band hits: surface as advisory context (non-blocking)
    if (flagged.length > 0) {
        const lines = [`[jev rules] Uncertain rule match in ${rel}:`];
        for (const h of flagged) {
            let text = h.rule.text.replace(/\s+/g, " ");
            if (text.length > 200)
                text = text.slice(0, 197) + "...";
            lines.push(`  - ${h.rule.id} (${h.prob.toFixed(2)}): "${text}"`);
        }
        lines.push("Check these before marking the task Done.");
        const out = {
            hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: lines.join("\n"),
            },
        };
        writeOutput(out);
    }
}
try {
    await main();
}
catch {
}
//# sourceMappingURL=rules.js.map