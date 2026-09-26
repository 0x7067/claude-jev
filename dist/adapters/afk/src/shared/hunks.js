export const EXCLUDED_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.claude|vendor|target)(\/|$)|\.lock$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/;
export function isOutside(rel) {
    return rel.startsWith("../") || rel === "..";
}
const ADDED_HEAD_CHARS = 200;
export function addedBody(hunk) {
    const marker = "ADDED:\n";
    if (hunk.includes(marker))
        return hunk.split(marker)[1] ?? "";
    if (hunk.startsWith("NEW FILE")) {
        return hunk.includes("\n") ? hunk.split("\n").slice(1).join("\n") : "";
    }
    if (/^\s*(diff --git|---|@@|index )/.test(hunk)) {
        return hunk
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.slice(1))
            .join("\n");
    }
    return hunk;
}
export function addedHead(hunk) {
    return addedBody(hunk).trim().slice(0, ADDED_HEAD_CHARS);
}
//# sourceMappingURL=hunks.js.map