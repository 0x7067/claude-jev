export interface Rule {
    id: string;
    text: string;
    file: string;
    line: number;
    scope: string[];
    when: "edit" | "turn";
    fileHash: string;
    polarity: string;
    subject: string;
    context: string;
}
export interface LoadRulesOptions {
    cachePath?: string;
    timeoutMs?: number;
}
export declare function loadRules(cwd: string, opts?: LoadRulesOptions): Promise<Rule[]>;
export declare function globMatch(filePath: string, globs: string[]): boolean;
export declare const TESTISH_RE: RegExp;
export declare function isSubjectRelevant(hunk: string, subject: string, rel: string): boolean;
