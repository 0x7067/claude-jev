const PYTHON_TIMEOUT_MS = 30000;
const PLUGIN = "claude-jev";
const PANE_ID = "claude-jev";
const KEY_FIELD = "typesafeApiKey";
const PENDING_KEY = "pendingSave";
const MAX_KEY_LENGTH = 1024;
const TOGGLES = [
  ["promptRouter", "Prompt routing hints"],
  ["subagentRouter", "Subagent model routing"],
  ["rules", "Rule checks"],
  ["compaction", "Compaction"],
];
const KEY_LABELS = { env: "from the environment", saved: "saved", missing: "missing" };
const PROVIDER_LABELS = { typesafe: "TypeSafe", openrouter: "OpenRouter" };
const PROVIDER_CHOICES = [
  ["auto", "Auto (from the key)"],
  ["typesafe", "TypeSafe"],
  ["openrouter", "OpenRouter"],
];
const OFF_TERMINAL = "Open /claude-jev in the terminal, or change the claude-jev rows in /config.";

let loaded = {};
let view = "menu";
let menuRow = "menu:key";
let keyDraft;
let info;
let statusLine;
let statsReport;

const rowKey = (field) => `${PLUGIN}.${field}`;

function savedKey() {
  const value = loaded[KEY_FIELD];
  return typeof value === "string" ? value.trim() : "";
}

function pinnedProvider(rows) {
  const row = rows?.find((candidate) => candidate.key === rowKey("provider"));
  const value = row ? row.value : loaded.provider;
  return PROVIDER_CHOICES.some(([name]) => name === value) ? value : "auto";
}

function pythonEnv() {
  const key = savedKey();
  return {
    CLAUDE_PLUGIN_OPTION_PROVIDER: pinnedProvider(),
    ...(key ? { CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY: key } : {}),
  };
}

function runPython($, args, stdin) {
  return $.process.run(["python3", `${$.plugin.root}/scripts/${args[0]}`, ...args.slice(1)], {
    env: pythonEnv(),
    timeoutMs: PYTHON_TIMEOUT_MS,
    ...(stdin === undefined ? {} : { stdin }),
  });
}

async function refreshInfo($) {
  try {
    const run = await runPython($, ["jev.py", "status"]);
    info = run.exitCode === 0 ? JSON.parse(run.stdout) : { error: run.stderr.trim() };
  } catch (err) {
    info = { error: String(err) };
  }
}

function keyLabel() {
  if (!info) return "checking…";
  if (info.error) return "unknown";
  const provider = PROVIDER_LABELS[info.provider];
  return provider ? `${KEY_LABELS[info.key]} · ${provider}` : KEY_LABELS[info.key];
}

async function loadStats($) {
  try {
    const run = await runPython($, ["stats.py"]);
    statsReport = run.exitCode === 0 ? run.stdout.trimEnd() : `stats.py failed: ${run.stderr.trim().slice(0, 300)}`;
  } catch (err) {
    statsReport = `stats.py failed: ${String(err)}`;
  }
}

function describeStatus() {
  if (!info) return "Status unavailable.";
  if (info.error) return `jev.py status failed: ${info.error.slice(0, 200)}`;
  const call = info.last_call;
  const last = !call
    ? "no calls logged yet"
    : `Last call ${call.ok ? "ok" : "failed"} in ${call.ms} ms at ${call.ts}${
        call.ok ? "" : `: ${String(call.error ?? "").slice(0, 160)}`
      }`;
  return `claude-jev ${info.version}. Key ${keyLabel()}. ${last}.`;
}

function parseKey(text) {
  const value = text.trim();
  if (!value) throw new Error("Paste a TypeSafe or OpenRouter key, or press Esc to go back.");
  if (value.length > MAX_KEY_LENGTH) throw new Error("That value is too long to be an API key.");
  if ([...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    throw new Error("The key cannot contain control characters.");
  }
  return value;
}

function isOn(rows, field) {
  const row = rows.find((candidate) => candidate.key === rowKey(field));
  return (row ? row.value : loaded[field]) !== false;
}

async function save($, field, value, message) {
  await $.store.set(PENDING_KEY, { row: menuRow, message });
  const result = await $.config.set({ key: rowKey(field), value });
  if (result.deny !== undefined) {
    await $.store.delete(PENDING_KEY);
    $.ui.toast(`Not saved: ${result.deny}`, { timeoutMs: 8000 });
    return false;
  }
  loaded = { ...loaded, [field]: value };
  info = undefined;
  return true;
}

function openPane($) {
  return $.ui.open({
    id: PANE_ID,
    title: "claude-jev (saved for all sessions)",
    focus: true,
    closeOnEscape: true,
    rows: 12,
  });
}

async function paneOpen($) {
  try {
    return (await $.ui.panes()).some((pane) => pane.id === PANE_ID);
  } catch {
    return false;
  }
}

async function placeRing($, key, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if ((await $.ui.focus({ requestId: PANE_ID, key })).deny === undefined) return;
    } catch {
      return;
    }
    await $.clock.sleep(50);
  }
}

function showMenu(row) {
  view = "menu";
  if (row !== undefined) menuRow = row;
  keyDraft = undefined;
}

async function resumeAfterSave($) {
  const pending = await $.store.get(PENDING_KEY);
  if (pending === undefined) return;
  await $.store.delete(PENDING_KEY);
  if (typeof pending.message === "string") $.ui.toast(pending.message, { timeoutMs: 6000 });
  if (typeof pending.row === "string" && (await paneOpen($))) {
    showMenu(pending.row);
    await openPane($).catch(() => undefined);
    await placeRing($, pending.row);
  }
}

function drawPane($, e, rows) {
  const { Box, Text, Input, Button } = $.ui.resolve(e);
  const column = (children) => Box({ flexDirection: "column", children });
  const heading = (crumb) =>
    Box({
      flexDirection: "row",
      marginBottom: 1,
      children: [
        Text({ bold: true, children: "claude-jev" }),
        Text({ dimColor: true, children: crumb ? ` › ${crumb}` : "  saved for all sessions" }),
      ],
    });
  const hint = (leave) => Text({ dimColor: true, children: `↑↓ move · Enter select · Esc ${leave}` });
  const redraw = async (focus) => {
    await $.ui.invalidate("ui.render");
    if (focus) await placeRing($, focus);
  };
  const run = (action, focus) => {
    void action()
      .catch((err) => $.ui.toast(err instanceof Error ? err.message : String(err), { timeoutMs: 8000 }))
      .finally(() => redraw(focus));
  };
  const list = (entries, focus) => {
    const width = Math.max(...entries.map((entry) => entry.label.length));
    return column(
      entries.map((entry) =>
        Button({
          key: entry.key,
          label: entry.label.padEnd(width),
          plain: true,
          ...(entry.dim ? { dimColor: true } : {}),
          ...(entry.key === focus ? { autoFocus: true } : {}),
          onPress: entry.onPress,
        }),
      ),
    );
  };
  const back = () => {
    showMenu();
    void redraw(menuRow);
  };

  if (view === "provider") {
    const current = pinnedProvider(rows);
    return column([
      heading("Provider"),
      Text({
        dimColor: true,
        wrap: "wrap",
        children:
          "Auto reads TYPESAFE_API_KEY, then OPENROUTER_API_KEY, and lets the key pick. A pinned provider reads only its own variable, or the saved key.",
      }),
      list(
        [
          ...PROVIDER_CHOICES.map(([name, label]) => ({
            key: `provider:${name}`,
            label: `${name === current ? "●" : " "} ${label}`,
            onPress: () => {
              showMenu();
              if (name === current) void redraw(menuRow);
              else run(() => save($, "provider", name, `Provider: ${label} (all sessions).`), menuRow);
            },
          })),
          { key: "provider:back", label: "  Back", dim: true, onPress: back },
        ],
        `provider:${current}`,
      ),
      hint("back"),
    ]);
  }

  if (view === "stats") {
    return column([
      heading("Stats"),
      Text({ dimColor: true, children: "PgUp/PgDn scroll · Esc back" }),
      list([{ key: "stats:back", label: "Back", dim: true, onPress: back }], "stats:back"),
      ...(statsReport ?? "Reading the logs…").split("\n").map((line) => Text({ wrap: "wrap", children: line || " " })),
    ]);
  }

  if (view === "key") {
    const saved = savedKey() !== "";
    return column([
      heading("API key"),
      Text({
        dimColor: true,
        wrap: "wrap",
        children:
          "TypeSafe or OpenRouter key; an sk-or- key calls OpenRouter. TYPESAFE_API_KEY or OPENROUTER_API_KEY in the launch environment wins over a saved key.",
      }),
      Input({
        key: "key:input",
        label: "Key",
        value: keyDraft?.text ?? "",
        placeholder: saved ? "paste a key to replace the saved one" : "paste a key to save it",
        submitLabel: "save",
        autoFocus: true,
        onSubmit: (text) =>
          run(async () => {
            try {
              if (await save($, KEY_FIELD, parseKey(text), "API key saved (all sessions).")) showMenu();
              else keyDraft = { text };
            } catch (err) {
              keyDraft = { text, error: err instanceof Error ? err.message : String(err) };
            }
          }),
      }),
      ...(keyDraft?.error ? [Text({ color: "error", children: keyDraft.error })] : []),
      list(
        [
          ...(saved
            ? [
                {
                  key: "key:clear",
                  label: "Clear saved key",
                  onPress: () =>
                    run(async () => {
                      if (await save($, KEY_FIELD, "", "Saved API key cleared (all sessions).")) showMenu();
                    }),
                },
              ]
            : []),
          { key: "key:back", label: "Back", dim: true, onPress: back },
        ],
        "",
      ),
      hint("back"),
    ]);
  }

  const setting = (label, value) => `${label.padEnd(24)}${value}`;
  return column([
    heading(),
    list(
      [
        {
          key: "menu:key",
          label: setting("API key", keyLabel()),
          onPress: () => {
            view = "key";
            menuRow = "menu:key";
            void redraw("key:input");
          },
        },
        {
          key: "menu:provider",
          label: setting("Provider", Object.fromEntries(PROVIDER_CHOICES)[pinnedProvider(rows)]),
          onPress: () => {
            view = "provider";
            menuRow = "menu:provider";
            void redraw(`provider:${pinnedProvider(rows)}`);
          },
        },
        ...TOGGLES.map(([field, label]) => {
          const on = isOn(rows, field);
          return {
            key: `menu:${field}`,
            label: setting(label, on ? "On" : "Off"),
            onPress: () => {
              menuRow = `menu:${field}`;
              run(() => save($, field, !on, `${label} ${on ? "off" : "on"} (all sessions).`), menuRow);
            },
          };
        }),
        {
          key: "menu:stats",
          label: "Stats",
          onPress: () => {
            view = "stats";
            menuRow = "menu:stats";
            statsReport = undefined;
            run(() => loadStats($), "stats:back");
          },
        },
        {
          key: "menu:status",
          label: "Status",
          onPress: () => {
            menuRow = "menu:status";
            if (info) {
              statusLine = describeStatus();
              void redraw(menuRow);
            }
            run(async () => {
              await refreshInfo($);
              statusLine = describeStatus();
            }, menuRow);
          },
        },
        { key: "menu:close", label: "Close", onPress: () => void $.ui.close({ id: PANE_ID }) },
      ],
      menuRow,
    ),
    ...(statusLine ? [Text({ dimColor: true, wrap: "wrap", children: statusLine })] : []),
    hint("close"),
  ]);
}

export function register(on, options) {
  loaded = options ?? {};

  on("session.start", async ($, e, next) => {
    if (e.isInteractive) {
      await $.command.register({
        name: PLUGIN,
        description: "Manage claude-jev: API key, provider, and which hooks run",
      });
      await resumeAfterSave($).catch(() => undefined);
    }
    return next(e);
  });

  on("command.run", { command: PLUGIN }, async ($, e, next) => {
    showMenu("menu:key");
    statusLine = undefined;
    await refreshInfo($);
    await openPane($);
    await placeRing($, menuRow);
    return {};
  });

  on("config.describe", { key: "claude-jev.typesafeApiKey" }, async (_$, e, next) => ({
    ...(await next(e)),
    isHidden: true,
  }));

  on("ui.close", { id: PANE_ID }, async ($, e, next) => {
    if (e.origin.kind !== "person" || view === "menu") return next(e);
    showMenu();
    await $.ui.invalidate("ui.render");
    await openPane($).catch(() => undefined);
    await placeRing($, menuRow);
    return { value: undefined };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    if (e.surface !== "terminal") return $.ui.resolve(e).Text({ children: OFF_TERMINAL });
    if (info === undefined) void refreshInfo($).then(() => $.ui.invalidate("ui.render"));
    return drawPane($, e, await $.config.list());
  });

  on("session.compact", async ($, e, next) => {
    if (loaded.compaction === false) return next(e);
    const fallThrough = async (why) => {
      await $.ui.log(`jev-compact: ${why}; built-in summary runs`);
      return next(e);
    };
    let run;
    try {
      const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()]);
      run = await runPython(
        $,
        ["compactor.py", "rows"],
        JSON.stringify({
          trigger: e.trigger,
          instructions: e.instructions ?? null,
          cwd,
          session_id: sessionId,
          messages: e.messages,
        }),
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
