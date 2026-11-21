export const meta = {
  purpose:
    "Which MCP servers are configured for a folder, by scope: user and local (~/.claude.json), project (.mcp.json) with whether it is approved, rejected or pending, plugin-provided and managed. For each: transport, command and whether the program exists on PATH, URL host (credentials and query removed), the names of its env variables and headers (never values), and the prefix its tools carry in permission rules and hook matchers. Notes servers defined in several scopes.",
  params: { folder: "optional (default: the caller's folder)", name: "optional: only servers with this name (or containing it)" },
  returns: "{folder, total, servers:['<scope> <name>: <transport> <command args | url> program on PATH | NOT FOUND; env keys [...]; status; tools mcp__x__'], sameNameInSeveralScopes, notes}",
  example: 'await scripts.run("mcp", { name: "my-server" })',
};

export default async function mcp({ setup }, { folder, name } = {}) {
  const r = await setup.mcp({ folder });
  const list = name ? r.servers.filter((s) => s.name.includes(name)) : r.servers;
  const line = (s) =>
    `${s.scope} ${s.name}: ${s.transport ?? "?"} ${s.command ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? "")}` +
    `${s.command ? (s.programFound === false ? "; PROGRAM NOT FOUND" : s.onPath ? `; program ${s.onPath}` : "") : ""}` +
    `${s.envKeys ? `; env keys [${s.envKeys.join(", ")}] (values hidden)` : ""}${s.headerKeys ? `; header keys [${s.headerKeys.join(", ")}] (values hidden)` : ""}` +
    `${s.status ? `; ${s.status}` : ""}${s.disabled ? "; DISABLED for this project" : ""}${s.plugin ? `; from plugin ${s.plugin}` : ""}; source ${s.file}; tools ${s.toolPrefix}`;
  return { folder: r.folder, project: r.project, claudeJson: r.claudeJson, total: r.total, shown: list.length, servers: list.map(line), sameNameInSeveralScopes: r.sameNameInSeveralScopes, notes: r.notes };
}
