// Hooks module for Claude Code's experimental function hooks.
//
// Loaded only when the host has function hooks on (rollout flag, or
// CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1) and the workspace is trusted. Older
// Claude Code versions ignore the `modules` entry in hooks.json that names
// this file: the four command hooks still run there, but compaction does
// not, because this module is the only compaction path.
//
// One hook: `session.compact`. The engine hands over the conversation as
// rows ({ role, text, toolUses, toolResults, handle }); this module pipes
// them to `scripts/compactor.py rows`, where Jev judges them, and returns
// the rows Jev kept as the whole post-compaction context. Returning
// without calling next(e) means the built-in summarizer never runs.
//
// Fail open: any error, a non-zero exit, unparseable output, or a
// `fallback` answer from the Python side calls next(e), and Claude Code's
// own compaction runs exactly as if this module were not loaded. No
// judgment happens in JavaScript; this file is a bridge, not a second
// implementation. Even the debug-log line comes preformatted from Python.

const PYTHON_TIMEOUT_MS = 30000; // Jev judges ~150 blocks in about a second;
                                 // the built-in summary takes 30-60 s, so a
                                 // stall this long is still cheaper than it

export function register(on) {
  on("session.compact", async ($, e, next) => {
    const fallThrough = async (why) => {
      await $.ui.log(`jev-compact: ${why}; built-in summary runs`);
      return next(e);
    };
    let run;
    try {
      const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()]);
      run = await $.process.run(
        ["python3", `${$.plugin.root}/scripts/compactor.py`, "rows"],
        {
          stdin: JSON.stringify({
            trigger: e.trigger,
            instructions: e.instructions ?? null,
            cwd,
            session_id: sessionId,
            messages: e.messages,
          }),
          timeoutMs: PYTHON_TIMEOUT_MS,
        },
      );
    } catch (err) {
      return fallThrough(`bridge failed: ${String(err)}`);
    }
    if (run.exitCode !== 0) {
      return fallThrough(`compactor.py exit ${run.exitCode}: ${run.stderr.slice(0, 300)}`);
    }
    let out;
    try {
      out = JSON.parse(run.stdout);
    } catch (err) {
      return fallThrough(`unreadable compactor.py output: ${String(err)}`);
    }
    if (!out || !Array.isArray(out.messages)) {
      return fallThrough(out?.fallback ?? "no rows returned");
    }
    await $.ui.log(`jev-compact: ${out.summary ?? `${out.messages.length} rows returned`}`);
    return { messages: out.messages };
  });
}
