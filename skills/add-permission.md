Add or remove a permission rule in the narrowest scope that does the job

1. See what exists: `scripts.run("permissions")`. To know whether a call is already covered, run
   it with `tool` and `command`, `path` or `url`.
2. Pick the list. `allow` runs without asking, `ask` always prompts, `deny` blocks. Deny is
   checked first, then ask, then allow; a narrower allow cannot override a broader deny or ask.
3. Write the rule: `Tool` or `Tool(specifier)`.
   - Bash: `Bash(git status *)`. Put the `*` after the subcommand: `Bash(git log *)` allows
     `git log` and its options; `Bash(git *)` allows every git subcommand; `Bash(git * main)` is
     warned about because the `*` stands in for the subcommand. `:*` at the end means the same as
     ` *`. Compound commands need every part allowed. Wrappers like `timeout` and `nohup` are
     stripped before matching. A rule on `curl` does not stop `/usr/bin/curl`.
   - Files: `Read(./.env)`, `Edit(src/**)`. `Read` rules also cover Glob and Grep; `Edit` rules
     cover Write. Anchors: `//abs/path`, `~/path`, `/path` relative to the settings file's
     project root, `./path` or `path` relative to the folder.
   - Network: `WebFetch(domain:example.com)`.
   - MCP: `mcp__server__tool`, or `mcp__server` for every tool of the server. A rule on an MCP
     tool with parentheses is skipped by Claude Code; `addPermission` refuses it.
4. Pick the scope. `local` (the default): this repository, not committed. `project`: the team's
   shared file, only when asked. `user`: every repository on this machine.
5. `await setup.addPermission({ list, rule, scope })`. The result has `warnings` when the rule is
   very broad or an existing deny or ask outranks it. `removePermission({ rule, list, scope })`
   removes an exact rule.
6. Confirm with `scripts.run("permissions", { tool, command })`: the decision should now name the
   rule you added, with its file.
7. Rules in ~/.claude.json (`allowedTools` per project) are listed by `permissions` but not
   edited here; the person removes those from /permissions.
