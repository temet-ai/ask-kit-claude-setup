export const meta = {
  purpose:
    "Checks the hooks block of each Claude Code settings file that applies (user, project, local, and managed when present), or of one settings file, and reports each problem with the file and the JSON path: invalid JSON, an unknown event name, a matcher on an event that takes none, a bare mcp__<server> matcher, a handler with no type or an unknown one, a timeout that is not a positive number or looks like milliseconds, an `if` on an event that never evaluates it, a command whose script or program is missing or not executable, an http, mcp_tool, prompt or agent handler without its field. Reads only.",
  params: {
    folder: "optional (default: the caller's folder); the repository whose project and local settings are checked",
    file: "optional: one settings-style .json file to check on its own, relative to the folder, or absolute",
    max: "problems listed, default 80",
  },
  returns: "{verdict, files:['<scope> <file>: <state> (<n> events, <n> handlers)'], counts:{error,warn,info}, problems:['<severity> <file> <json path>: <problem>'], cut}",
  example: 'await scripts.run("validate-hooks", { file: ".claude/settings.local.json" })',
};

export default async function validateHooks({ setup }, { folder, file, max } = {}) {
  const r = await setup.validateHooks({ folder, file, max });
  const n = (k, w) => `${r.counts[k]} ${w}${r.counts[k] === 1 ? "" : "s"}`;
  return {
    verdict: `${r.handlersChecked} handlers checked: ${n("error", "error")}, ${n("warn", "warning")}, ${r.counts.info} note${r.counts.info === 1 ? "" : "s"}`,
    folder: r.folder,
    files: r.files.map((f) => `${f.scope} ${f.file}: ${f.state}${f.events ? ` (${f.events} events, ${f.handlers} handlers)` : ""}`),
    counts: r.counts,
    problems: r.problems.map((p) => `${p.severity} ${p.file} ${p.path}: ${p.problem}`),
    cut: r.cut,
  };
}
