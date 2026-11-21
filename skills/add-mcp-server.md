Add an MCP server in the right scope

1. See what exists: `scripts.run("mcp", { name })`. The same server in two scopes with different
   definitions is a problem the `check` script reports.
2. Pick the scope. `project`: a `.mcp.json` at the repository root, committed, shared with the
   team; each person approves it once in an interactive session. `local`: this repository only,
   private, kept in ~/.claude.json. `user`: every repository, kept in ~/.claude.json.
3. Project scope: `await setup.addMcp({ scope: "project", name, command, args, env })` for a
   program, or `{ name, url, type: "http" | "sse", headers }` for a remote server. It writes
   `.mcp.json` with a backup and checks the JSON. env and header values are written but never
   shown back. Do not commit a real token: use `${VAR}` in the value (`"${API_TOKEN}"`) so the
   file holds a reference.
4. Local and user scope: `addMcp` writes nothing and returns `{ needsCli: true, command }`.
   Give the person that command, with `<VALUE>` placeholders for secrets, and say they must run it
   because ~/.claude.json is rewritten by running sessions. The same goes for removal
   (`removeMcp`) and for `claude mcp add-json`.
5. After adding: the program must exist (`scripts.run("mcp", { name })` shows `PROGRAM NOT FOUND`
   otherwise); a project server stays `pending approval` until a person approves it, or until
   `enabledMcpjsonServers` lists it or `enableAllProjectMcpServers` is true in settings.
6. Tool names carry a prefix, shown as `tools mcp__<server>__`; use it in permission rules and
   hook matchers. A plugin's server is `mcp__plugin_<plugin>_<server>__`.
7. The answer: the file, the scope, the transport, env key names, and what the person must do next.
