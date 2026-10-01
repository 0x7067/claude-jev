import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { judgeable, MAX_BLOCKS, RESCUE_BLOCKS, type Block } from "../../src/compact/strategy.ts";
import { splitSummary } from "./digest.ts";
import { locations, type ScanValue } from "./refs.ts";

export type AgentMessage = Parameters<typeof convertToLlm>[0][number];

export type LlmMessage = ReturnType<typeof convertToLlm>[number];

export const BLOCK_BUDGET = MAX_BLOCKS + RESCUE_BLOCKS;

const TOOL_INPUT_CHARS = 400;

const TOOL_RESULT_CHARS = 800;

export interface PiBlock extends Block {
  refs?: string[];
}

interface Pending {
  block: PiBlock;
  provides: string[];
  answers?: string;
}

type Textish = { readonly type: string; readonly text?: string };

function isStringContent(content: string | readonly Textish[]): content is string {
  return typeof content === "string";
}

function contentText(content: string | readonly Textish[]): string {
  if (isStringContent(content)) return content;
  const parts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text !== undefined) parts.push(block.text);
  }

  return parts.join("\n");
}

function fileRefs(args: ScanValue): string[] {
  const refs: string[] = [];

  for (const location of locations(args)) {
    if (location.kind === "file") refs.push(location.value);
  }

  return refs;
}

export function blockFrom(message: LlmMessage): PiBlock | undefined {
  switch (message.role) {
    case "user": {
      const text = judgeable("user", contentText(message.content).trim());

      if (text === null) return undefined;

      return { role: "user", text };
    }

    case "assistant": {
      const parts: string[] = [];
      const refs: string[] = [];

      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "toolCall") {
          const rendered = JSON.stringify(block.arguments);

          parts.push(`[tool_use ${block.name}] ${rendered.slice(0, TOOL_INPUT_CHARS)}`);
          refs.push(...fileRefs(block.arguments));
        }
      }

      const text = judgeable("assistant", parts.join("\n").trim());

      if (text === null) return undefined;

      return refs.length === 0 ? { role: "assistant", text } : { role: "assistant", text, refs };
    }

    case "toolResult": {
      const text = judgeable(
        "tool",
        `[tool_result] ${contentText(message.content).slice(0, TOOL_RESULT_CHARS)}`.trim()
      );

      if (text === null) return undefined;

      return { role: "tool", text };
    }

    case "system":
      return undefined;
    default: {
      const unreachable: never = message;

      return unreachable;
    }
  }
}

function hostRole(message: AgentMessage): string | undefined {
  if (message.role === "bashExecution") return "bash";

  if (message.role === "branchSummary" || message.role === "compactionSummary") return "summary";

  return undefined;
}

interface ToolLinks {
  provides: string[];
  answers?: string;
}

function toolLinks(message: LlmMessage): ToolLinks {
  if (message.role === "assistant") {
    const provides: string[] = [];

    for (const block of message.content) {
      if (block.type === "toolCall") provides.push(block.id);
    }

    return { provides };
  }

  if (message.role === "toolResult") return { provides: [], answers: message.toolCallId };

  return { provides: [] };
}

export function blocksFrom(messages: readonly AgentMessage[], previousSummary?: string): PiBlock[] {
  const prior = previousSummary === undefined ? [] : splitSummary(previousSummary);
  const entries: Pending[] = [];

  for (const block of prior) entries.push({ block, provides: [] });
  const fresh: Pending[] = [];

  for (const message of messages) {
    const role = hostRole(message);

    for (const llm of convertToLlm([message])) {
      const block = blockFrom(llm);

      if (block === undefined) continue;
      const labeled = role === undefined ? block : { ...block, role };
      const links = toolLinks(llm);

      fresh.push({ block: labeled, provides: links.provides, answers: links.answers });
    }
  }

  const room = Math.max(0, BLOCK_BUDGET - prior.length);
  const start = Math.max(0, fresh.length - room);

  for (let i = start; i < fresh.length; i++) {
    const entry = fresh[i];

    if (entry !== undefined) entries.push(entry);
  }

  const providedBy = new Map<string, number>();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (entry === undefined) continue;

    for (const id of entry.provides) providedBy.set(id, index);
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (entry === undefined) continue;
    const answers = entry.answers;

    if (answers === undefined) continue;
    const call = providedBy.get(answers);

    if (call !== undefined && call !== index) entry.block.needs = call;
  }

  const blocks: PiBlock[] = [];

  for (const entry of entries) blocks.push(entry.block);

  return blocks;
}
