export function slugify(text) {
    return (text
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.slice(0, 5)
        .join("-") || "rule");
}
//# sourceMappingURL=utils.js.map