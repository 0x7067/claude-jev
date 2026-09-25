import type { Questions, NoulQuestion, ChoiceQuestion } from "./jev-client.js";

export function intentBundle(): Questions {
  return {
    intent: {
      type: "choice",
      instructions: "What kind of request is this for an AI coding assistant?",
      criteria: {
        chat: "Conversation or general question — answer directly, no codebase work needed",
        lookup:
          "Needs a specific fact from the codebase — a targeted search suffices",
        fix: "Small bug fix or tweak — locate the code, make a focused edit, verify narrowly",
        feature:
          "New capability or multi-file change — plan briefly before editing",
        ops: "Run commands: builds, tests, git, CI, deployment — no code changes unless asked",
      },
    } satisfies ChoiceQuestion,
    scope: {
      type: "score",
      instructions: "How much work does fulfilling this request take?",
      criteria: [
        "Trivial: a single obvious step",
        "Small: a few localized steps",
        "Substantial: multi-file or multi-phase work",
      ],
    },
    needs_tools: {
      type: "noul",
      instructions:
        "To handle this message, must the assistant use tools " +
        "(read files, search, run commands, edit code) rather than " +
        "just replying from the conversation?",
    } satisfies NoulQuestion,
    model_tier: {
      type: "choice",
      instructions:
        "What is the cheapest Claude model tier that would handle this request well?",
      criteria: {
        haiku:
          "Mechanical or conversational — chat, quick lookups, renames, a single command",
        sonnet:
          "Ordinary coding work — focused edits, standard features, debugging with a clear signal",
        opus: "Hardest reasoning — ambiguous multi-file work, architecture, subtle bugs",
      },
    } satisfies ChoiceQuestion,
  };
}

const TIER_CRITERIA: Record<string, string> = {
  haiku:
    "Bounded, mechanical work with a clear stop condition and no " +
    "design choices: search, fetch, count, summarize, list callers, " +
    "run a named command and report its output, apply a rename or " +
    "one-line change that the brief spells out exactly. If the " +
    "brief says precisely what to do and where, this is enough",
  sonnet:
    "Ordinary implementation from a complete brief: focused edits " +
    "or a standard feature in named files, a bug with a clear " +
    "reproduction or error message, mechanical changes across " +
    "several files that follow an existing pattern. Needs local " +
    "judgment about code, not decisions about design",
  opus:
    "Work where the brief leaves real decisions open: an ambiguous " +
    "multi-file change, a bug with no clear signal, design inside a " +
    "module, a review that must find what is wrong rather than " +
    "confirm what is right, changes in tangled or unfamiliar code. " +
    "The default for hard work",
  fable:
    "Only when a cheaper tier would likely return a confident wrong " +
    "answer: adversarial review of an architecture or a " +
    "security-sensitive design, debugging across systems where the " +
    "cause is unknown and the evidence conflicts, or a task whose " +
    "acceptance criteria cannot be written down in advance. Rare " +
    "and the most expensive; not for implementation",
};

const BRIEF_CHECKS: Record<string, string> = {
  brief_writes:
    "Does this task ask the subagent to create, edit, or " +
    "delete files, as opposed to only reading, searching, " +
    "running commands, or reporting?",
  brief_paths:
    "Does the brief name the exact files or paths the subagent should work in?",
  brief_acceptance:
    "Does the brief state acceptance criteria — how the subagent can tell the work is done?",
  brief_verify:
    "Does the brief name a command or check the subagent must run to verify its work?",
  brief_commit:
    "Does the brief say whether the subagent may commit, or that it must not?",
};

export function subagentBundle(askTier: boolean): Questions {
  const q: Questions = {};
  for (const [k, v] of Object.entries(BRIEF_CHECKS)) {
    q[k] = { type: "noul", instructions: v } satisfies NoulQuestion;
  }
  if (askTier) {
    q["model_tier"] = {
      type: "choice",
      instructions:
        "A coding assistant is delegating this task to a subagent. " +
        "What is the cheapest Claude model tier the subagent needs to do it well?",
      criteria: TIER_CRITERIA,
    } satisfies ChoiceQuestion;
  }
  return q;
}

export const BRIEF_PARTS: Record<string, string> = {
  brief_paths: "the exact files or paths to work in",
  brief_acceptance: "acceptance criteria",
  brief_verify: "the verification command to run",
  brief_commit: "the commit policy (default: do not commit)",
};

export const INSTRUCTION_Q =
  "Is item [{i}] a rule about the code or files a coding agent writes, " +
  "such that a reviewer looking at one diff could tell whether it was " +
  "followed? Facts, descriptions and pointers are not. Neither are " +
  "process rules about how to work — what to read first, which " +
  "commands or tools to run, how to communicate, when to delegate " +
  "— because no single diff can show compliance. The section " +
  "heading before each item says what the section is about; an " +
  "item under a heading about workflow, sessions, tools or " +
  "delegation is a process rule even when it mentions code size.";

export const TURN_Q =
  "Does judging item [{i}] need every change the agent made for the task, " +
  "not just one edit hunk — because it is about the change as a whole: " +
  "its total size, scope creep, edits outside what was asked, an " +
  "abstraction with a single caller, or the same code repeated across " +
  "files? Answer no for a rule a single hunk can break on its own.";

export const TURN_CRITERIA = {
  true:
    "A rule about the change as a whole: how much was changed, whether " +
    "it stayed within the task, whether new code has callers, whether " +
    "the same code now appears in several places.",
  false:
    "A rule one hunk can break by itself: a forbidden construct, call, " +
    "pattern, comment style, naming, error handling, or a required " +
    "element in the code being added.",
};

export const POLARITY_Q = "Does item [{i}] forbid something, or require something?";
export const POLARITY_CRITERIA = {
  forbid: "the rule says not to do or add something",
  require: "the rule says something must be present or done a certain way",
};

export const SUBJECT_Q = "What kind of thing in a code diff does item [{i}] govern?";
export const SUBJECT_CRITERIA = {
  imports_deps: "imports, requires, dependencies, third-party packages",
  comments: "comments, docstrings, explanatory text inside code",
  naming: "what things are called: identifiers, files, exports, casing",
  types: "type annotations, interfaces, type safety, schemas",
  tests: "tests, test files, assertions, fixtures",
  errors: "error handling, exceptions, failure paths, fallbacks",
  literals_constants:
    "literal values, magic numbers, hardcoded strings, constants",
  files_structure: "which files exist, where code lives, file layout",
  commands_process: "commands to run, workflow, process, how to work",
  other: "anything else, or the rule governs the change as a whole",
};

export function ruleQuestions(count: number): Questions {
  const q: Questions = {};
  for (let i = 0; i < count; i++) {
    q[`q${i}`] = {
      type: "noul",
      instructions: INSTRUCTION_Q.replace(/\{i\}/g, String(i)),
    } satisfies NoulQuestion;
    q[`t${i}`] = {
      type: "noul",
      instructions: TURN_Q.replace(/\{i\}/g, String(i)),
      criteria: TURN_CRITERIA,
    } satisfies NoulQuestion;
    q[`p${i}`] = {
      type: "choice",
      instructions: POLARITY_Q.replace(/\{i\}/g, String(i)),
      criteria: POLARITY_CRITERIA,
    } satisfies ChoiceQuestion;
    q[`s${i}`] = {
      type: "choice",
      instructions: SUBJECT_Q.replace(/\{i\}/g, String(i)),
      criteria: SUBJECT_CRITERIA,
    } satisfies ChoiceQuestion;
  }
  return q;
}

export const INSTRUCTION_MIN = 0.5;
export const TURN_MIN = 0.5;
export const CHOICE_MIN = 0.5;
export const DEFAULT_SUBJECT = "other";
export const DEFAULT_POLARITY = "forbid";
export const ITEMS_PER_REQUEST = 15;
