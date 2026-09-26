export function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isJsonArray(value) {
    return Array.isArray(value);
}
export function isString(value) {
    return typeof value === "string";
}
export function isNumber(value) {
    return typeof value === "number";
}
export function parseJsonObject(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    return isJsonObject(value) ? value : null;
}
export function parseJsonArray(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    return isJsonArray(value) ? value : null;
}
//# sourceMappingURL=json.js.map