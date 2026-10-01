import type { ExtensionAPI, FileOperations } from "@earendil-works/pi-coding-agent";
import type { DecisionBackend } from "../afk/src/shared/jev-client.ts";
import { DIRECTIVE_CHARS, selectBlocks, type Kept, type Stats } from "../../src/compact/strategy.ts";
import { blocksFrom } from "./blocks.ts";
import { ask, resolve, status } from "./client.ts";
import { mergeReadFiles, pointerPaths, renderDigest, SELECT_CHARS, withoutModified, type IndexedBlock } from "./digest.ts";
import { computeFileLists, formatFileOperations } from "./file-ops.ts";
import { appendLine, lastRecord } from "./log.ts";
import { callLogPath, compactLogPath, dotEnvPath } from "./paths.ts";

const FILES = { dotEnv: dotEnvPath(), callLog: callLogPath() };

const COMPACT_LOG_PATH = compactLogPath();

function directiveOf(instructions: string | undefined): string | null {
  const trimmed = (instructions ?? "").trim().slice(0, DIRECTIVE_CHARS);

  return trimmed === "" ? null : trimmed;
}

export interface CompactionSummary {
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
  pointerChars: number;
}

export function compactionSummary(
  blocks: readonly IndexedBlock[],
  kept: readonly Kept[],
  cwd: string,
  fileOps: FileOperations
): CompactionSummary {
  const lists = computeFileLists(fileOps);
  const pointers = withoutModified(pointerPaths(blocks, kept, cwd), lists.modifiedFiles, cwd);
  const reads = mergeReadFiles(lists.readFiles, pointers, cwd);
  const summary = renderDigest(blocks, kept) + formatFileOperations(reads, lists.modifiedFiles);

  return {
    summary,
    readFiles: lists.readFiles,
    modifiedFiles: lists.modifiedFiles,
    pointerChars: pointers.join("\n").length,
  };
}

function describeDigest(reason: string, stats: Stats): string {
  const percent = `${Math.round(stats.reduction * 100)}%`;

  return (
    `jev-compact: ${reason} compaction replaced by ${stats.kept} blocks ` +
    `(${stats.truncated} truncated, ${percent} smaller, ${stats.ms} ms)`
  );
}

function errorText(error: Error | string): string {
  const text = error instanceof Error ? error.message : error;

  return text.slice(0, 300);
}

export default function jev(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (resolve(FILES).source === "missing") return;
    const { preparation, customInstructions, reason, signal } = event;
    let blocks: ReturnType<typeof blocksFrom>;
    let kept: Kept[];
    let stats: Stats;
    let cwd: string;
    let summary: CompactionSummary;

    try {
      blocks = blocksFrom(
        [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
        preparation.previousSummary
      );

      if (blocks.length === 0) return;

      const backend: DecisionBackend = {
        name: "pi",
        ask(state, questions, timeoutMs) {
          return ask(state, questions, {
            dotEnv: FILES.dotEnv,
            callLog: FILES.callLog,
            timeoutMs,
            signal,
            caller: "compaction",
          });
        },
      };

      cwd = ctx.sessionManager.getCwd();

      [kept, stats] = await selectBlocks(blocks, cwd, directiveOf(customInstructions), backend, SELECT_CHARS);
      summary = compactionSummary(blocks, kept, cwd, preparation.fileOps);
    } catch (error) {
      const text = error instanceof Error ? error : String(error);

      ctx.ui.notify(`jev-compact: ${errorText(text)}; pi's own summary runs`, "warning");

      return;
    }

    appendLine(
      COMPACT_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: ctx.sessionManager.getSessionId(),
        source: "session_before_compact",
        trigger: reason,
        blocks_in: blocks.length,
        pointer_chars: summary.pointerChars,
        judged: stats.judged,
        rescued: stats.rescued,
        pinned: stats.pinned,
        kept: stats.kept,
        truncated: stats.truncated,
        escalated: stats.escalated,
        chars_before: stats.chars_before,
        chars_after: stats.chars_after,
        est_tokens_after: stats.est_tokens_after,
        reduction: stats.reduction,
        ms: stats.ms,
      })
    );
    ctx.ui.notify(describeDigest(reason, stats), "info");

    return {
      compaction: {
        summary: summary.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        estimatedTokensAfter: Math.ceil(summary.summary.length / 4),
        details: {
          readFiles: summary.readFiles,
          modifiedFiles: summary.modifiedFiles,
          jev: {
            judged: stats.judged,
            rescued: stats.rescued,
            pinned: stats.pinned,
            kept: stats.kept,
            truncated: stats.truncated,
            escalated: stats.escalated,
            chars_before: stats.chars_before,
            chars_after: stats.chars_after,
            est_tokens_after: stats.est_tokens_after,
            reduction: stats.reduction,
            ms: stats.ms,
          },
        },
      },
    };
  });

  pi.registerCommand("jev", {
    description: "Show the Jev key source, provider, version, and the last compaction",
    handler: async (_args, ctx) => {
      const info = status(FILES);
      const call = info.lastCall;

      const lastCall =
        call === undefined
          ? "no Jev call logged yet"
          : `last call ${call.ok === true ? "ok" : "failed"} in ${String(call.ms ?? "")} ms at ${String(call.ts ?? "")}` +
            `${call.ok === true ? "" : `: ${String(call.error ?? "").slice(0, 160)}`}`;

      const compacted = lastRecord(COMPACT_LOG_PATH);

      const lastCompaction =
        compacted === undefined
          ? "no compaction logged yet"
          : `last compaction ${String(compacted.trigger ?? "")} kept ${String(compacted.kept ?? "")} of ${String(compacted.blocks_in ?? "")} blocks at ${String(compacted.ts ?? "")}`;

      ctx.ui.notify(
        [
          `claude-jev ${info.version} · key ${info.key}${info.provider ? ` · ${info.provider}` : ""} · provider ${info.pinned}`,
          lastCall,
          lastCompaction,
        ].join("\n"),
        info.key === "missing" ? "warning" : "info"
      );
    },
  });
}
