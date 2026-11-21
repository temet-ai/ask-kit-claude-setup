# ask-kit-claude-setup

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer how Claude Code is configured on this machine and in the current repository: hooks,
permission rules, MCP servers, plugins, mods and settings, with the file each comes from. It also
adds, changes and removes them when asked. A cheap model reads the settings files outside your
agent's context and answers with the file, the key and the scope.

Questions from its bench, of the kinds agents answer by hand with `cat`, `jq` and `rg`:

- Which hook runs before every Bash tool call, which settings file configures it, and what script does it run?
- In this repository, which permission rule lets `git push origin main` run without a prompt, and which file holds it?
- Are any settings files in this project invalid?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and Node.js 22.13 or newer.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-claude-setup
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-claude-setup        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-claude-setup --yes  # installs and enables it
```

Restart your agents so `ask` lists `claude-setup`. The kit answers about the repository your agent
works in; a question that names another folder is answered there.

## What it carries

| | |
|---|---|
| Scripts | `hooks` (every hook with its source and script state; with an event and a tool, the hooks that would fire and why the others would not), `permissions` (rules by list and file; with a tool call, the rule that decides it), `mcp` (servers by scope, command on PATH, env key names, approval), `plugins` (marketplaces, installed and enabled plugins and what each contributes, mods and whether they load), `settings` (the merged settings and the layer that set each key), `check` (invalid JSON, missing or non-executable hook scripts, bad matchers, rule forms Claude Code skips, MCP commands not on PATH, plugins enabled but not installed) |
| Skills | `add-hook`, `debug-hook`, `add-permission`, `add-mcp-server`, `from-now-on`: playbooks the investigator loads when the job calls for one |
| Roles | `inspector` for questions about what is configured or why something fired; `configurer` for requests to change it |

Each script also runs with no model: `ask-kit run claude-setup hooks event=PreToolUse tool=Bash`,
or `ask(do: "claude-setup.hooks")` from an agent.

## What it reads

User settings `~/.claude/settings.json`, the repository's `.claude/settings.json` and
`.claude/settings.local.json`, managed settings under `/etc/claude-code`, `.mcp.json`,
`~/.claude/plugins/*.json`, the installed plugins' manifests and `~/.claude/mods`. From
`~/.claude.json` it reads only `mcpServers` and, for the current repository, its `mcpServers`,
`allowedTools` and the enabled and disabled server lists; the account data and history in that
file are not read out. `~/.claude/.credentials.json` is never opened.

What the investigator reads goes to a cloud model, so `setup.mjs` masks it first. The names of env
variables and headers are returned and their values are not. URL credentials and query strings,
tokens in commands and keys with names such as `token` or `secret` are replaced by `<set>`.

## What it can change

When the request asks for a change, it adds and removes hooks and permission rules, sets and
unsets settings keys (including `env`), adds and removes servers in `.mcp.json`, and turns
installed plugins on or off. It writes `settings.json`, `settings.local.json` and `.mcp.json`
files only. Each change keeps a copy of the old file in ask-kit's state folder, is written
atomically, and is read back to check that it is valid JSON; a file that is not valid JSON is
refused and left as it is. Secret values written by a change are not repeated in the answer.

`~/.claude.json` is rewritten by running Claude Code sessions, so the kit never writes it. For
user-scope and local-scope MCP servers, plugin installs and marketplaces it returns the `claude`
command to run (`claude mcp add ...`) and says the person has to run it.

With a request to change something, `testHook` also runs one hook command with a sample event on
stdin, with no shell, to show its exit code and output. A question never changes anything:
every changing call is refused unless the caller asked for a change (`act`).

## How well it works

`bench/questions.json` holds five questions and two script runs, put to the project folders that
`bench/make-fixture.sh` builds (run it first), each with patterns its answer must hold. It has not been run on a model yet; `ask-kit kit test claude-setup` runs it. The
scripts and the changing calls were run without a model on this machine's real files and on a
throwaway home folder.
