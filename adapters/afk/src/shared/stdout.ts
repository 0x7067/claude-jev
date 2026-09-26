export interface UserPromptSubmitOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext?: string;
  };
  systemMessage?: string;
}

export interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  systemMessage?: string;
}

export interface PostToolUseOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

export interface StopOutput {
  hookSpecificOutput?: {
    hookEventName: "Stop";
    additionalContext?: string;
  };
  systemMessage?: string;
  decision?: "block";
  reason?: string;
}

export interface SessionStartOutput {
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

export type HookOutput =
  | UserPromptSubmitOutput
  | PreToolUseOutput
  | PostToolUseOutput
  | StopOutput
  | SessionStartOutput;

export function writeOutput(out: HookOutput): void {
  process.stdout.write(JSON.stringify(out) + "\n");
}
