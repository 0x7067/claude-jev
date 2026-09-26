export interface SessionState {
    blocks: Record<string, number>;
    stopBlocks: number;
}
export declare function statePath(sessionId: string): string;
export declare function loadState(sessionId: string): SessionState;
export declare function saveState(sessionId: string, state: SessionState): void;
