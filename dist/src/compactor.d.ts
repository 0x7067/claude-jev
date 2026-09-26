#!/usr/bin/env node
import { type Answers, type DecisionBackend } from "../adapters/afk/src/shared/jev-client.js";
import { type Json, type JsonValue } from "../adapters/afk/src/shared/json.js";
export declare const KEEP_THRESHOLD = 0.5;
export declare const MAX_BLOCKS = 150;
export declare const PIN_TAIL = 4;
export declare const ROWS_HEADER: string;
export interface Block {
    role: string;
    text: string;
    row?: CompactRow;
}
interface TranscriptEntry {
    type?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    promptSource?: string;
    message?: Json;
}
export declare function blockText(content: JsonValue | undefined): string;
export declare function judgeable(role: string, text: string): string | null;
export declare function injected(d: TranscriptEntry, strictSource: boolean): boolean;
export declare function compactionMarker(d: TranscriptEntry, text: string): boolean;
export declare function transcriptEntry(data: Json): TranscriptEntry;
export declare function visibleText(d: TranscriptEntry, text?: string | null, strictSource?: boolean): string | null;
export declare function transcriptBlocks(transcriptPath: string): Block[];
export declare function sessionContext(blocks: Block[], cwd: string | null, directive: string | null): string;
export declare function compactState(blocks: Block[], lo: number, hi: number, context: string): string;
export declare const CHECKS: {
    constraint: string;
    decision: string;
    error: string;
    open: string;
    rerunnable: string;
};
export declare const KEEP_CHECKS: readonly ["constraint", "decision", "error", "open"];
export declare const ASK_CHECKS: readonly ["constraint", "decision", "error", "open", "rerunnable"];
type NoulQ = {
    type: "noul";
    instructions: string;
};
type Questions = Record<string, NoulQ>;
export declare function keepQuestions(n: number, names?: readonly (keyof typeof CHECKS)[]): Questions;
export interface Verdict {
    keep: number | null;
    full: number | null;
    checks: Record<string, number>;
}
export declare function verdicts(answers: Answers, i: number): Verdict;
export declare const ELISION: (n: number) => string;
export declare function cutMarked(text: string, chars: number): string;
export declare function truncateBlock(text: string): string;
export interface Kept {
    i: number;
    text: string;
    kind: string;
    keep: number;
    full: number;
    pinned?: boolean;
    rescued?: boolean;
    escalated?: boolean;
}
export declare function fitKept(kept: Kept[], blocks: Block[]): Kept[];
export declare function blockKind(text: string): string;
export interface Row {
    checks: Record<string, number>;
    i: number;
    role: string;
    kind: string;
    chars: number;
    keep: number | null;
    full: number | null;
    verdict: string;
    ref: string;
}
export declare function blockRows(blocks: Block[], kept: Kept[], answers: Answers): Row[];
export declare function judge(transcriptPath: string, cwd: string | null, decisionBackend?: DecisionBackend): Promise<[string[], Stats]>;
export declare function selectBlocks(blocks: Block[], cwd: string | null, directive?: string | null, decisionBackend?: DecisionBackend): Promise<[Kept[], Stats]>;
export interface Stats {
    judged: number;
    rescued: number;
    pinned: number;
    kept: number;
    truncated: number;
    escalated: number;
    chars_before: number;
    chars_after: number;
    est_tokens_after: number;
    reduction: number;
    ms: number;
    rows: Row[];
    trigger?: string;
    rows_in?: number;
    rows_out?: number;
    passed_through?: number;
}
export interface CompactRow {
    role?: JsonValue;
    text?: JsonValue;
    toolUses?: JsonValue;
    toolResults?: JsonValue;
    handle?: JsonValue;
}
export declare function rowText(row: CompactRow): string | null;
export declare function rows(): Promise<number>;
export {};
