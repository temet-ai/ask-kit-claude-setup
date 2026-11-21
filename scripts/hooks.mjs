export const meta = {
  purpose:
    "Which hooks are configured for a folder: event, matcher, handler type, command or URL host, timeout, the settings file or plugin each comes from, and whether the script it runs exists and may run. With an event and a tool name (and optionally the Bash command or a file path) it instead lists the hooks that would fire, in order, and why the others would not: a matcher that does not match, an `if` that does not apply, an `if` on an event that never evaluates it.",
  params: {
    folder: "optional (default: the caller's folder); settings are read for that repository",
    event: "optional, case-sensitive event name (PreToolUse, SessionStart, Stop...); narrows the list, or, with tool, selects what would fire",
    tool: "optional: the tool name (Bash, Edit, mcp__server__tool) or the matcher target of the event (a SessionStart source, a Notification type, an agent type); turns on the would-fire answer",
    command: "optional: the Bash command, to test each hook's `if` (Bash(git *))",
    file: "optional: the file path, to test an `if` such as Edit(*.ts)",
    fires: "true to give the would-fire answer for event without a tool (events with no matcher, such as Stop or UserPromptSubmit)",
  },
  returns: "list: {folder, layers, total, notes, hooks:['<n>. <Event> [<matcher>] <type> <command|url> (timeout Ns) <- <source>; <script state>']}; would-fire: {event, tool, fires:['<order>. <result> ...'], notFiring:[...], notes}",
  example: 'await scripts.run("hooks", { event: "PreToolUse", tool: "Bash", command: "git commit -m x" })',
};

const state = (t) => {
  if (!t) return "";
  if (t.inline) return "inline code";
  if (t.script) return t.unresolved ? `script ${t.script} (path has an unresolved variable)` : !t.exists ? `SCRIPT MISSING ${t.script}` : t.runsDirectly && !t.executable ? `NOT EXECUTABLE ${t.script}` : `script ${t.script} ok`;
  if (t.program) return t.onPath ? "program on PATH" : `PROGRAM NOT ON PATH ${t.program}`;
  return t.interpreter ? `${t.interpreter}` : "";
};
const src = (s) => (s.kind === "settings" ? `${s.scope} ${s.file}` : s.kind === "plugin" ? `plugin ${s.plugin}` : s.kind === "mod" ? `mod ${s.name}` : s.kind);
const what = (h) => h.command ?? h.url ?? h.mcp ?? (h.prompt ? `prompt: ${h.prompt}` : h.modules ? `modules ${h.modules.join(", ")}` : "");

export default async function hooks({ setup }, { folder, event, tool, command, file, fires } = {}) {
  if (event && (tool || command || file || fires)) {
    const r = await setup.wouldFire({ folder, event, tool, command, file });
    const line = (h) => `${h.result}: ${h.event} [${h.matcher ?? ""}] ${h.type} ${what(h)}${h.timeout ? ` (timeout ${h.timeout}s)` : ""} <- ${src(h.source)}; ${state(h.target)}; why: ${h.why}`;
    return { event: r.event, tool: r.tool, input: r.input, wouldFire: r.fires.length, fires: r.fires.map((h) => `${h.order}. ${line(h)}`), notFiring: r.notFiring, notFiringList: r.notFiringList.map(line), notes: r.notes };
  }
  const r = await setup.hooks({ folder, event, tool });
  const byEvent = {};
  for (const h of r.hooks) byEvent[h.event] = (byEvent[h.event] ?? 0) + 1;
  return {
    folder: r.folder,
    layers: r.layers.map((l) => `${l.scope} ${l.path}${l.exists ? (l.valid ? "" : ` INVALID: ${l.error}`) : " (absent)"}`),
    total: r.total,
    shown: r.shown,
    byEvent,
    notes: r.notes,
    hooks: r.hooks.map((h) => `${h.n}. ${h.event} [${h.matcher ?? ""}] ${h.type} ${what(h)}${h.if ? ` if ${h.if}` : ""}${h.timeout ? ` (timeout ${h.timeout}s)` : ""} <- ${src(h.source)}${h.malformed ? `; MALFORMED: ${h.malformed}` : ""}${state(h.target) ? `; ${state(h.target)}` : ""}`),
  };
}
