export const meta = {
  purpose:
    "Problems in the Claude Code configuration for a folder: a settings file or .mcp.json that is not valid JSON, a hook whose script is missing or not executable, a matcher that is not a valid regex, an `if` on an event that never evaluates it, a permission rule in a form Claude Code skips, an MCP command not on PATH, a project server awaiting approval, a plugin enabled but not installed, a mod that is a dangling link or is not loaded, duplicate hooks. Each with severity, file and key.",
  params: { folder: "optional (default: the caller's folder)", max: "problems listed, default 80" },
  returns: "{counts:{error,warn,info}, problems:['<severity> <file> <key>: <problem>'], checked}",
  example: 'await scripts.run("check")',
};

export default async function check({ setup }, { folder, max } = {}) {
  const r = await setup.check({ folder, max });
  return { folder: r.folder, counts: r.counts, problems: r.problems.map((p) => `${p.severity} ${p.where} ${p.key}: ${p.problem}`), cut: r.cut, checked: r.checked };
}
