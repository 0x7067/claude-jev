export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, 5)
      .join("-") || "rule"
  );
}
