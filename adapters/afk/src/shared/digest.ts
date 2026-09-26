import type { Rule } from "./rule-parser.js";

const MAX_RULES_IN_DIGEST = 40;

const MAX_DIGEST_CHARS = 3000;

export function formatDigest(rules: Rule[]): string {
  const requireRules = rules.filter((r) => r.polarity === "require");
  const forbidRules = rules.filter((r) => r.polarity === "forbid");

  const lines: string[] = ["[jev rules] Active project rules:"];

  if (forbidRules.length > 0) {
    lines.push("");
    lines.push("FORBID:");

    for (const r of forbidRules.slice(0, MAX_RULES_IN_DIGEST)) {
      const scope = r.scope.length > 0 ? ` (${r.scope.join(", ")})` : "";
      lines.push(`  - ${r.text}${scope}`);
    }
  }

  if (requireRules.length > 0) {
    lines.push("");
    lines.push("REQUIRE:");

    for (const r of requireRules.slice(0, MAX_RULES_IN_DIGEST - forbidRules.length)) {
      const scope = r.scope.length > 0 ? ` (${r.scope.join(", ")})` : "";
      lines.push(`  - ${r.text}${scope}`);
    }
  }

  if (rules.length === 0) return "";

  lines.push("");
  lines.push(
    `${rules.length} rule(s) loaded. Edits violating these rules at >=0.80 confidence will be blocked.`
  );

  let digest = lines.join("\n");

  if (digest.length > MAX_DIGEST_CHARS) {
    digest = digest.slice(0, MAX_DIGEST_CHARS - 20) + "\n  ... (truncated)";
  }

  return digest;
}
