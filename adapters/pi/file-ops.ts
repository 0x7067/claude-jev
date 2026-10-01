import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FileOperations } from "@earendil-works/pi-coding-agent";

interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

interface FileListModule {
  computeFileLists(fileOps: FileOperations): FileLists;
  formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
}

let loaded: FileListModule | undefined;

async function peerFileLists(): Promise<FileListModule> {
  if (loaded !== undefined) return loaded;

  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const utils = pathToFileURL(join(dirname(fileURLToPath(entry)), "core", "compaction", "utils.js")).href;

  // The package entry does not re-export these names. compaction/index does, and this file is that module.
  const imported: FileListModule = await import(utils);

  loaded = imported;

  return imported;
}

export async function computeFileLists(fileOps: FileOperations): Promise<FileLists> {
  const api = await peerFileLists();

  return api.computeFileLists(fileOps);
}

export async function formatFileOperations(readFiles: string[], modifiedFiles: string[]): Promise<string> {
  const api = await peerFileLists();

  return api.formatFileOperations(readFiles, modifiedFiles);
}
