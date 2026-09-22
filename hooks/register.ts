const PYTHON_TIMEOUT_MS = 30000;

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
