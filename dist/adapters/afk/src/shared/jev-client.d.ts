export type NoulQuestion = {
    type: "noul";
    instructions: string;
    criteria?: {
        true: string;
        false: string;
    };
};
export type ChoiceQuestion = {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
};
export type ScoreQuestion = {
    type: "score";
    instructions: string;
    criteria: string[];
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type NoulAnswer = {
    noul: number;
};
export type ChoiceAnswer = {
    choice: string;
    confidence: number;
};
export type ScoreAnswer = {
    score: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;
export declare function asChoice(answer: Answers[string] | undefined): ChoiceAnswer | undefined;
export declare function asNoul(answer: Answers[string] | undefined): NoulAnswer | undefined;
export declare function asScore(answer: Answers[string] | undefined): ScoreAnswer | undefined;
export interface DecisionBackend {
    readonly name: string;
    ask(state: string, questions: Questions, timeoutMs: number): Promise<Answers>;
}
export declare function resolveDecisionBackend(spec: string): DecisionBackend;
export declare const DEFAULT_BACKEND: DecisionBackend;
export declare function jevAsk(state: string, questions: Questions, timeoutMs?: number): Promise<Answers>;
