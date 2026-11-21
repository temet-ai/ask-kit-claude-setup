// Every call takes an optional `folder` (default: the folder the caller works in); settings are read for the repository it is in.
// scope: "user" (~/.claude/settings.json) | "project" (<repo>/.claude/settings.json) | "local" (<repo>/.claude/settings.local.json) | "managed" (/etc/claude-code).
// Higher wins: managed, then local, project, user. Lists (permission rules) merge. Values come back masked: env, headers, tokens and URL credentials or queries are never returned, only names.
interface Source { kind: "settings" | "plugin" | "mod"; scope?: string; file?: string; plugin?: string; name?: string }
interface Hook { n?: number; event: string; matcher: string | null; type: string; command?: string; url?: string; mcp?: string; prompt?: string; if?: string; timeout?: number; source: Source; at?: string;
  target?: { interpreter?: string; script?: string; exists?: boolean; executable?: boolean; runsDirectly?: boolean; program?: string; onPath?: string | null; inline?: true }; malformed?: string }
interface Problem { severity: "error" | "warn" | "info"; where: string; key: string; problem: string }
interface Server { name: string; scope: "user" | "local" | "project" | "plugin" | "managed"; file: string; transport?: string; command?: string; args?: string[]; url?: string; onPath?: string | null; programFound?: boolean | null;
  envKeys?: string[]; headerKeys?: string[]; status?: string; disabled?: true; plugin?: string; toolPrefix: string }

declare const setup: {
  cwd: string;
  act: boolean; // true when this ask may change things
  events: string[]; // every hook event name (case-sensitive)

  // The settings files that apply, lowest precedence first: scope, path, exists, valid (false with an `error` for bad JSON), number of keys.
  layers(o?: { folder?: string }): { folder: string; project: string; layers: { scope: string; path: string; exists: boolean; valid?: boolean; error?: string; keys?: number }[] };

  // The merged settings: one row per key (env.NAME, permissions.allow, model...), value masked, `from` the layer that won (lists: the layers that contributed), `alsoSetIn` the lower layers it overrides.
  // o.key narrows to a key or prefix. Hooks appear as hooks.<Event> counts; read hooks() for them.
  settings(o?: { folder?: string; key?: string; max?: number }): { folder: string; layers: unknown[]; total: number; effective: { key: string; value: unknown; from: string; alsoSetIn?: string[] }[]; cut: number; notes: string[] };

  // Every hook for the folder: settings layers, enabled plugins, and loaded mods (listed as modules). o.event and o.tool narrow it. Each row has its source and, for a command, the script it runs and whether that exists and may run.
  hooks(o?: { folder?: string; event?: string; tool?: string }): { folder: string; total: number; shown: number; layers: unknown[]; notes: string[]; hooks: Hook[] };

  // The hooks that would run for an event, in settings order, with why the others do not. o.tool is the tool name, or the matcher target (SessionStart source, Notification type, agent type).
  // o.command is the Bash command and o.file a path, used to test a hook's `if`. Matchers follow the documented rules: plain names and | or , lists are exact, anything else is an unanchored regex; some events have no matcher.
  wouldFire(o: { event: string; tool?: string; command?: string; file?: string; folder?: string }): { event: string; tool: string | null; fires: (Hook & { order: number; result: "fires" | "maybe"; why: string })[]; notFiring: number; notFiringList: (Hook & { why: string })[]; notes: string[] };

  // Permission rules by list with their source file (user, project, local, ~/.claude.json allowedTools), the default mode and extra directories. With o.tool it returns decide(o).
  permissions(o?: { folder?: string; tool?: string; command?: string; path?: string; url?: string; max?: number }): { defaultMode: string; defaultModeFrom: string | null; counts: Record<string, number>; rules: Record<"deny" | "ask" | "allow", string[]>; notes: string[] };
  // The rule that decides one tool call: deny, then ask, then allow; a compound Bash command is checked part by part. decision "none" means no rule: the mode (and any hook or mod) decides.
  decide(o: { tool: string; command?: string; path?: string; url?: string; name?: string; folder?: string }): { tool: string; decision: "deny" | "ask" | "allow" | "none"; rule?: string; source?: string; mode: string; parts?: unknown[]; notes: string[] };

  // MCP servers by scope. Env and header values are never returned, only their names. project servers carry `status` (approved, rejected, pending approval).
  mcp(o?: { folder?: string }): { folder: string; total: number; servers: Server[]; sameNameInSeveralScopes: string[]; notes: string[] };

  // Marketplaces, plugins (version, install scopes, enabled and where, what each contributes) and mods.
  plugins(o?: { folder?: string }): { marketplaces: unknown[]; plugins: unknown[]; enabledNotInstalled: string[]; installedNotEnabled: string[]; mods: unknown; notes: string[] };
  // Mods under ~/.claude/mods: link target, version, modules, and whether CLAUDE_CODE_PLUGIN_DIRS loads each.
  mods(o?: { folder?: string }): { mods: { name: string; path: string; symlinkTo?: string; targetExists?: boolean; version?: string; modules?: { module: string; exists: boolean }[]; loaded: boolean }[]; loadedBy: string };

  // Problems: invalid JSON, hook script missing or not executable, bad matcher, `if` on an event that ignores it, rule forms Claude Code skips, MCP command not on PATH, plugin enabled but not installed, dangling mods, duplicates.
  check(o?: { folder?: string; max?: number }): { counts: { error: number; warn: number; info: number }; problems: Problem[]; cut: number; checked: Record<string, number> };

  // The `claude` command to run for what lives only in ~/.claude.json or needs the CLI. Text only; nothing runs.
  // kind: "mcp-add" ({name, command, args, env, url, type, headers, scope}; values become <VALUE>), "mcp-remove", "plugin-install", "plugin-uninstall", "marketplace-add" ({source}).
  cli(kind: string, o?: { name?: string; id?: string; scope?: string; command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string>; headers?: Record<string, string>; source?: string }): { command: string; note?: string };

  // Does a hook matcher select a target? Does a permission rule match a call ({tool, command|path|url|name})?
  matcherTest(event: string, matcher: string | undefined, target: string): { match: boolean | null; why?: string; invalid?: string };
  ruleMatches(rule: string, call: { tool: string; command?: string; path?: string; url?: string; name?: string }, kind?: "allow" | "ask" | "deny"): boolean | null;

  // ---- Changing calls: only when act is true. They write settings.json, settings.local.json and .mcp.json (never ~/.claude.json), keep a backup, write atomically and re-read the file to check the JSON.
  // Each returns {changed, file, backup, validJson, action, ...}; secret values are never echoed. Refused when the file is not valid JSON.

  // Add a hook handler. scope default "user". matcher only for events that have one; `if` (one permission rule) only on PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied.
  addHook(o: { event: string; type?: "command" | "http" | "prompt" | "agent" | "mcp_tool"; command?: string; url?: string; prompt?: string; server?: string; tool?: string; matcher?: string; timeout?: number; if?: string; async?: boolean; scope?: "user" | "project" | "local"; folder?: string }): Promise<unknown> | unknown;
  // Remove handlers by exact command or url, or a unique substring (contains); all: true when several match.
  removeHook(o: { event: string; command?: string; url?: string; contains?: string; matcher?: string; all?: boolean; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  // Set or remove a settings key (dotted path: model, env.NAME, statusLine). Values for env, headers and secret-looking keys are not echoed. Not for hooks, permission rules or mcpServers.
  set(o: { key: string; value: unknown; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  unset(o: { key: string; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  // Add or remove one permission rule. scope default "local" (this repository, not committed). Refuses forms Claude Code skips; warns when an existing deny or ask outranks an allow.
  addPermission(o: { list: "allow" | "ask" | "deny"; rule: string; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  removePermission(o: { rule: string; list?: "allow" | "ask" | "deny"; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  // Add or remove an MCP server in .mcp.json (scope "project", the default). For scope "user" or "local" it changes nothing and returns {needsCli: true, command}: the claude command to run.
  addMcp(o: { name: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: "http" | "sse"; headers?: Record<string, string>; scope?: "project" | "user" | "local"; folder?: string }): unknown;
  removeMcp(o: { name: string; scope?: "project" | "user" | "local"; folder?: string }): unknown;
  // Turn an installed plugin on or off (enabledPlugins). Installing is the claude command from cli("plugin-install").
  setPlugin(o: { id: string; enabled?: boolean; scope?: "user" | "project" | "local"; folder?: string }): unknown;
  // Run one hook command with a sample event on stdin (no shell: pipes and redirects are refused) and report exit code, output and how Claude Code reads it. Runs a program: needs act.
  testHook(o: { event: string; command: string; args?: string[]; tool?: string; input?: object; prompt?: string; timeout?: number; folder?: string }): Promise<{ exitCode: number; stdout: string; stderr: string; decision: string | null; reading: string; ms: number }>;
};
