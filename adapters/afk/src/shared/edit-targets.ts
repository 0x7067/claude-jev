import path from "node:path";
import { isJsonObject, isString } from "./json.ts";

export interface EditPair {
  old_string?: string;
  new_string?: string;
}

export interface PatchChange {
  path?: string;
  edits?: Array<{ old?: string; new?: string }>;
  content?: string;
}

export interface EditToolInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: EditPair[];
  changes?: PatchChange[];
  dry_run?: boolean;
}

export interface EditTarget {
  filePath: string;
  rel: string;
  hunk: string;
}

export interface EditTargets {
  patch: boolean;
  targets: EditTarget[];
}

function pairHunk(removed: string | undefined, added: string | undefined): string {
  let hunk = "";

  if (removed) hunk += `REMOVED:\n${removed}\n`;

  if (added) hunk += `ADDED:\n${added}`;

  return hunk;
}

export function editHunks(inp: EditToolInput = {}): string {
  if (Array.isArray(inp.edits)) {
    const parts: string[] = [];

    for (const e of inp.edits) {
      const hunk = pairHunk(e.old_string, e.new_string);

      if (hunk) parts.push(hunk);
    }

    return parts.join("\n\n");
  }

  if (inp.old_string != null || inp.new_string != null) {
    return pairHunk(inp.old_string, inp.new_string);
  }

  return inp.content ?? "";
}

function changeHunk(change: PatchChange): string {
  if (Array.isArray(change.edits)) {
    const parts: string[] = [];

    for (const e of change.edits) {
      if (!isJsonObject(e)) continue;

      const hunk = pairHunk(e.old, e.new);

      if (hunk) parts.push(hunk);
    }

    return parts.join("\n\n");
  }

  return isString(change.content) ? change.content : "";
}

function relativeTo(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || path.basename(filePath);
}

function patchTargets(changes: PatchChange[], cwd: string): EditTarget[] {
  const byPath = new Map<string, EditTarget>();

  for (const change of changes) {
    if (!isJsonObject(change) || !isString(change.path) || !change.path.trim()) continue;

    const hunk = changeHunk(change).trim();

    if (!hunk) continue;

    const filePath = path.resolve(cwd, change.path);
    const prior = byPath.get(filePath);

    if (prior) {
      prior.hunk = `${prior.hunk}\n\n${hunk}`;
      continue;
    }

    byPath.set(filePath, { filePath, rel: relativeTo(cwd, filePath), hunk });
  }

  return [...byPath.values()];
}

export const PATCH_TOOL = "patch_apply";

export function editTargets(
  toolName: string | undefined,
  inp: EditToolInput,
  cwd: string
): EditTargets {
  const patch = toolName === PATCH_TOOL || (toolName === undefined && Array.isArray(inp.changes));

  if (patch) {
    if (inp.dry_run === true || !Array.isArray(inp.changes)) return { patch, targets: [] };

    return { patch, targets: patchTargets(inp.changes, cwd) };
  }

  const filePath = inp.file_path ?? "";
  const hunk = editHunks(inp).trim();

  if (!hunk) return { patch: false, targets: [] };

  return { patch: false, targets: [{ filePath, rel: relativeTo(cwd, filePath), hunk }] };
}
