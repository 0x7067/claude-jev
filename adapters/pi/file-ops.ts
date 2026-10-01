import type { FileOperations } from "@earendil-works/pi-coding-agent";

interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

export function computeFileLists(fileOps: FileOperations): FileLists {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();

  return { readFiles, modifiedFiles };
}

export function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
  const sections: string[] = [];

  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);

  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }

  if (sections.length === 0) return "";

  return `\n\n${sections.join("\n\n")}`;
}
