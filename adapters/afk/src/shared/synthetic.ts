const SYNTHETIC =
  /^(Another Claude session sent a message:|Workspace boundary \(important\):|Base directory for this skill:|Continue from where you left off\.|Review this change for security vulnerabilities\.|You previously flagged these candidate vulnerabilities:|Fabric actor message from|\[Usage limit approaching|\[Image:|\[Request interrupted|This session is being continued from|Your task is to create a detailed summary|Please continue the conversation from where|Permission granted for:|\[Your previous response had no visible output|reply with exactly:|Reply with exactly:)/i;

export function isSynthetic(text: string): boolean {
  const head = text.slice(0, 200);
  return (
    SYNTHETIC.test(text) ||
    head.includes("<teammate-message") ||
    head.includes("<agent-message")
  );
}
