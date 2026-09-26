import type { Questions } from "./jev-client.js";
export declare function intentBundle(): Questions;
export declare function subagentBundle(askTier: boolean, tiers?: Record<string, string>): Questions;
export declare const BRIEF_PARTS: Map<string, string>;
export declare const INSTRUCTION_Q: string;
export declare const TURN_Q: string;
export declare const TURN_CRITERIA: {
    true: string;
    false: string;
};
export declare const POLARITY_Q = "Does item [{i}] forbid something, or require something?";
export declare const POLARITY_CRITERIA: {
    forbid: string;
    require: string;
};
export declare const SUBJECT_Q = "What kind of thing in a code diff does item [{i}] govern?";
export declare const SUBJECT_CRITERIA: {
    imports_deps: string;
    comments: string;
    naming: string;
    types: string;
    tests: string;
    errors: string;
    literals_constants: string;
    files_structure: string;
    commands_process: string;
    other: string;
};
export declare function ruleQuestions(count: number): Questions;
export declare const INSTRUCTION_MIN = 0.5;
export declare const TURN_MIN = 0.5;
export declare const CHOICE_MIN = 0.5;
export declare const DEFAULT_SUBJECT = "other";
export declare const DEFAULT_POLARITY = "forbid";
export declare const ITEMS_PER_REQUEST = 15;
