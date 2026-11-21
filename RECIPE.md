# Recipe: claude-setup kit

## What it answers

How Claude Code is configured on a machine and for one repository, as it is now: which hooks
exist (event, matcher, handler, source file or plugin, whether the script exists and may run) and
which would fire for a tool call; which permission rules apply and which one decides a call; which
MCP servers are configured and whether their program exists; which plugins and marketplaces are
installed and enabled; the settings in force after the layers merge and which layer won; which
mods are installed and loaded. It changes hooks, permission rules, settings keys, `.mcp.json`
servers and enabled plugins when asked.

## What it needs

- Node.js 22.13 or newer. No other program, no keys, no build step.

## What it reads and runs

- Reads `~/.claude/settings.json`, `<repo>/.claude/settings.json`, `<repo>/.claude/settings.local.json`,
  `/etc/claude-code/managed-settings.json` and `managed-settings.d/*.json`, `<repo>/.mcp.json`,
  `/etc/claude-code/managed-mcp.json`, `~/.claude/plugins/installed_plugins.json` and
  `known_marketplaces.json`, each installed plugin's `.claude-plugin/plugin.json`, hooks file and
  `.mcp.json`, and the folders in `~/.claude/mods`.
- From `~/.claude.json` only `mcpServers` and, under `projects.<path>`, `mcpServers`,
  `allowedTools`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `disabledMcpServers` and
  `enabledMcpServers`. Never `~/.claude/.credentials.json`.
- Masks before anything is returned: env and header values, keys named like secrets, URL
  credentials and queries, tokens in command text.
- Runs a program only in `testHook` (a hook command with a sample event, no shell, 30 s at most),
  and only when the caller asked for a change.

## What it can change

`settings.json`, `settings.local.json` and `.mcp.json`, through `setup.addHook`, `removeHook`,
`set`, `unset`, `addPermission`, `removePermission`, `addMcp` (project scope), `removeMcp`
(project scope) and `setPlugin`. Never `~/.claude.json`: the module returns the `claude` command
for user and local MCP servers and plugin installs. Every write is backed up, atomic and
re-read to check the JSON.

## Brief to rebuild it

Write `ask-kit.toml` with one `module` source named `setup`, `acts` written as the changing
function names (`setup.addHook` and so on, one entry each), and the two roles `inspector` and
`configurer`. The module exports `make({settings, push, cwd, act})` returning a client with:
`layers`, `settings` (merge managed over local over project over user, lists merge, keep the layer
that set each key, mask values), `hooks` (settings layers, enabled plugins, loaded mods; normalise
each handler and resolve the script a command runs), `wouldFire` (the documented matcher rules:
`*` or empty matches all, only letters, digits, `_`, `-`, `,`, `|` and spaces is an exact name or
list, anything else an unanchored regex; events without a matcher always fire; `if` is one
permission rule and only evaluated on tool events), `permissions` and `decide` (deny, then ask,
then allow; compound Bash commands part by part; path anchors `//`, `~/`, `/`, `./`), `mcp`
(user and local from `~/.claude.json`, project from `.mcp.json` with approval status, plugin,
managed), `plugins`, `mods` (loaded through `CLAUDE_CODE_PLUGIN_DIRS`), `check`, and `cli` (text
of `claude` commands). The changing calls refuse without `act`, refuse files other than
`settings.json`, `settings.local.json` and `.mcp.json`, refuse invalid JSON, back up, write a temp
file and rename, re-read, and restore on failure. Six scripts (`hooks`, `permissions`, `mcp`,
`plugins`, `settings`, `check`) return compact lines. Five skills: `add-hook`, `debug-hook`,
`add-permission`, `add-mcp-server`, `from-now-on`. Describe the client exactly in `api.d.ts`.
