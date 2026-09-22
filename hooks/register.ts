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
// implementation.

const PYTHON_TIMEOUT_MS = 30000; // Jev judges ~150 blocks in about a second;
                                 // the built-in summary takes 30-60 s, so a
                                 // stall this long is still cheaper than it

export function register(on) {
  on("session.compact", async ($, e, next) => {
    let run;
    try {
      const cwd = await $.session.cwd();
      const sessionId = await $.session.id();
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
      await $.ui.log(`jev-compact: bridge failed, built-in summary runs: ${String(err)}`);
      return next(e);
    }
    if (run.exitCode !== 0) {
      await $.ui.log(`jev-compact: compactor.py exit ${run.exitCode}, built-in summary runs: ${run.stderr.slice(0, 300)}`);
      return next(e);
    }
    let out;
    try {
      out = JSON.parse(run.stdout);
    } catch (err) {
      await $.ui.log(`jev-compact: unreadable compactor.py output, built-in summary runs: ${String(err)}`);
      return next(e);
    }
    if (!out || !Array.isArray(out.messages)) {
      await $.ui.log(`jev-compact: ${out && out.fallback ? out.fallback : "no rows returned"}; built-in summary runs`);
      return next(e);
    }
    const s = out.stats || {};
    await $.ui.log(`jev-compact: ${e.trigger} compaction replaced by ${out.messages.length} rows (kept ${s.kept}, ${s.truncated} truncated, ${Math.round((s.reduction || 0) * 100)}% smaller, ${s.ms} ms)`);
    return { messages: out.messages };
  });
}
