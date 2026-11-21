// A client for how Claude Code is configured on this machine and for one folder: the settings layers
// (managed, user, project, local), hooks, permission rules, MCP servers, plugins, marketplaces and mods,
// with where each value came from. It reads, and, when the caller asked for a change (`act`), edits
// settings.json, settings.local.json and .mcp.json files.
//
// Three checks. A change needs `act`. Everything returned is masked, because answers go to a cloud
// model: env values, header values, tokens and URL credentials or queries never leave this file
// (key names do). And it writes settings files and .mcp.json only: never ~/.claude.json, which running
// sessions rewrite, and never a credentials file; for what lives only there it returns the `claude` command.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const notInThisAsk = (what) => {
  throw new Error(`not in this ask: ${what} changes things, and the caller did not ask for a change (act: true), so nothing was done. Answer what you can, and say that this needs \`ask\` with act: true. Do not look for another way to do it.`);
};
const fail = (why) => {
  throw new Error(why);
};

export const EVENTS = [
  "SessionStart", "Setup", "InstructionsLoaded", "UserPromptSubmit", "UserPromptExpansion", "MessageDisplay", "PreToolUse", "PermissionRequest", "PermissionDenied",
  "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure",
  "TeammateIdle", "ConfigChange", "CwdChanged", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "SessionEnd", "Elicitation",
  "ElicitationResult", "PreModelSwitch", "PostModelSwitch", "DirectoryAdded",
];
// Events whose matcher field is ignored: the hook always fires.
const NO_MATCHER = new Set(["UserPromptSubmit", "PostToolBatch", "Stop", "TeammateIdle", "TaskCreated", "TaskCompleted", "WorktreeCreate", "WorktreeRemove", "MessageDisplay", "CwdChanged"]);
// Events where a handler's `if` field is evaluated; on any other event a hook with `if` never runs.
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
const HANDLER_TYPES = new Set(["command", "http", "mcp_tool", "prompt", "agent"]);
const KNOWN_TOOLS = new Set(["Bash", "PowerShell", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "SlashCommand", "TodoWrite", "BashOutput", "KillShell", "ExitPlanMode", "EndConversation", "Monitor", "LSP"]);
const SCOPE_ORDER = ["user", "project", "local", "managed"]; // low to high

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const SECRET_KEY = /(token|secret|passw(or)?d|api[-_]?key|apikey|auth|credential|cookie|bearer|private[-_]?key|access[-_]?key|signature)/i;

// ---------- masking ----------

function maskUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.replace(/[A-Za-z0-9_-]{24,}/g, "<…>");
    return `${x.protocol}//${x.host}${p === "/" && !/\/$/.test(u.split("?")[0]) ? "" : p}${x.search ? "?<query>" : ""}`;
  } catch {
    return u;
  }
}
export function maskString(s) {
  return String(s ?? "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, (u) => maskUrl(u))
    .replace(/(authorization:\s*)(bearer|basic|token)\s+\S+/gi, "$1$2 <set>")
    .replace(/(--?(?:token|key|password|passwd|secret|api-key|apikey|auth)[= ])('[^']*'|"[^"]*"|\S+)/gi, "$1<set>")
    .replace(/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD)[A-Za-z0-9_]*=)('[^']*'|"[^"]*"|\S+)/g, "$1<set>")
    .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA|glpat-|npm_|pk_live_|sk_live_)[A-Za-z0-9_\-]{8,}/g, "<set>")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "<set>");
}
/** A value with every secret-looking part replaced. env and headers keep their names only. */
export function maskValue(key, v) {
  const k = String(key ?? "");
  if (v == null || typeof v === "boolean" || typeof v === "number") return SECRET_KEY.test(k) ? "<set>" : v;
  if (typeof v === "string") return SECRET_KEY.test(k) ? "<set>" : maskString(v);
  if (Array.isArray(v)) return v.map((x) => maskValue(k, x));
  if (isObj(v)) {
    if (/^(env|headers|extraHeaders|httpHeaders)$/i.test(k)) return Object.fromEntries(Object.keys(v).map((n) => [n, "<set>"]));
    return Object.fromEntries(Object.entries(v).map(([n, x]) => [n, maskValue(n, x)]));
  }
  return String(v);
}
const shorten = (v, n = 300) => {
  const s = JSON.stringify(v);
  return s && s.length > n ? { truncated: true, type: Array.isArray(v) ? `array of ${v.length}` : typeof v, preview: s.slice(0, n) + "…" } : v;
};

// ---------- files ----------

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? { path: file, exists: false } : { path: file, exists: true, valid: false, error: `cannot read: ${e.code || "error"}` };
  }
  try {
    const data = JSON.parse(raw);
    if (!isObj(data)) return { path: file, exists: true, valid: false, error: "the top level is not a JSON object" };
    return { path: file, exists: true, valid: true, data, raw };
  } catch (e) {
    const m = /at position (\d+)/.exec(String(e.message));
    let where = "";
    if (m) {
      const pos = +m[1];
      const before = raw.slice(0, pos);
      where = ` at line ${before.split("\n").length} column ${pos - before.lastIndexOf("\n")}`;
    }
    const what = String(e.message).replace(/\s*["'][\s\S]*$/, "").replace(/ in JSON at position.*$/, "").slice(0, 80);
    if (!raw.trim()) return { path: file, exists: true, valid: false, error: "empty file (0 bytes): not valid JSON, a settings file needs at least {}" };
    return { path: file, exists: true, valid: false, error: `invalid JSON${where}${what ? ` (${what})` : ""}` };
  }
}
const home0 = () => process.env.HOME || os.homedir();
const short = (p, home) => (p && home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);
const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
function which(cmd) {
  if (cmd.includes("/")) return isExec(cmd) ? cmd : null;
  for (const d of (process.env.PATH || "").split(":")) if (d && isExec(path.join(d, cmd))) return path.join(d, cmd);
  return null;
}

// ---------- commands in hooks and MCP servers ----------

function tokenize(s) {
  const out = [];
  let cur = "", q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur), (cur = ""), (has = false);
    } else if (c === "\\" && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
function hasShellOps(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') i++;
      else if (q === '"' && (c === "`" || (c === "$" && s[i + 1] === "("))) return true;
    } else if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if ("|&;<>`".includes(c) || (c === "$" && s[i + 1] === "(")) return true;
  }
  return false;
}
function expandVars(t, vars) {
  let r = t.replace(/^~(?=\/|$)/, vars.HOME);
  r = r.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (m, a, dflt, b) => {
    const k = a || b;
    return vars[k] ?? (dflt !== undefined ? dflt : m);
  });
  return r;
}
const INTERP = /^(bash|sh|zsh|dash|fish|python3?|node|deno|bun|tsx|ruby|perl|php)$/;
/** What a command string runs: the script file it points at (and whether it exists and may run), or the program on PATH. */
function commandTarget(command, args, vars, cwd) {
  if (!command) return null;
  const complex = !args && hasShellOps(command);
  let toks = args ? [command, ...args.map(String)] : tokenize(command);
  toks = toks.map((t) => expandVars(t, vars));
  while (toks.length && /^[A-Za-z_]\w*=/.test(toks[0])) toks.shift();
  let first = toks[0];
  if (!first) return null;
  let interpreter = null;
  if (INTERP.test(path.basename(first))) {
    interpreter = path.basename(first);
    if (toks.some((t) => t === "-c" || t === "-e" || t === "-p")) return { interpreter, inline: true, complex };
    const arg = toks.slice(1).find((t) => !t.startsWith("-") && !/^[A-Za-z_]\w*=/.test(t));
    if (!arg || !(arg.includes("/") || /\.\w+$/.test(arg))) return { interpreter, complex, interpreterOnPath: !!which(first) };
    const p = path.resolve(cwd, arg);
    return { interpreter, script: p, exists: exists(p), executable: isExec(p), runsDirectly: false, complex, ...(/\$\{?\w+/.test(p) ? { unresolved: true } : {}) };
  }
  if (first.includes("/") || first.startsWith(".")) {
    const p = path.resolve(cwd, first);
    return { script: p, exists: exists(p), executable: isExec(p), runsDirectly: true, complex, ...(/\$\{?\w+/.test(p) ? { unresolved: true } : {}) };
  }
  const w = which(first);
  return { program: first, onPath: w, complex };
}

// ---------- matchers, rules ----------

/** Does a hook group's matcher select this target (tool name, source, notification type...)? Follows the documented evaluation rules. */
export function matcherTest(event, matcher, target) {
  if (NO_MATCHER.has(event)) return { match: true, why: `${event} has no matcher: the hook always fires` };
  if (matcher == null || matcher === "" || matcher === "*") return { match: true, why: "no matcher: matches all" };
  if (typeof matcher !== "string") return { match: false, invalid: "matcher is not a string" };
  const narrow = event === "FileChanged" || event === "StopFailure";
  const simple = narrow ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_\-\s,|]+$/;
  if (target == null) return { match: null, why: "no target given" };
  if (simple.test(matcher)) {
    const parts = matcher.split(narrow ? "|" : /[|,]/).map((x) => x.trim()).filter(Boolean);
    return { match: parts.includes(target), why: parts.length > 1 ? `one of ${parts.join(", ")}` : "exact name" };
  }
  try {
    return { match: new RegExp(matcher).test(target), why: "unanchored regex" };
  } catch (e) {
    return { match: false, invalid: `not a valid regex: ${String(e.message).slice(0, 80)}` };
  }
}

const globRe = (g) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
export function parseRule(rule) {
  if (typeof rule !== "string") return null;
  const m = /^\s*([^()\s][^()]*?)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
  return m ? { raw: rule, tool: m[1], spec: m[2] } : null;
}
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"]);
function splitCommand(cmd) {
  const parts = [];
  let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      while (cmd[i + 1] === "&" || cmd[i + 1] === "|") i++;
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function stripWrappers(cmd, anyAssign) {
  let s = cmd.trim();
  for (let n = 0; n < 8; n++) {
    const a = /^([A-Za-z_]\w*)=\S*\s+/.exec(s);
    if (a && (anyAssign || /^(NODE_ENV|CI|LANG|LC_ALL|TERM|NO_COLOR|FORCE_COLOR|DEBUG|RUST_LOG)$/.test(a[1]))) {
      s = s.slice(a[0].length);
      continue;
    }
    const w = /^(\w+)\s+/.exec(s);
    if (w && WRAPPERS.has(w[1])) {
      s = s.slice(w[0].length);
      if (w[1] === "timeout") s = s.replace(/^\S+\s+/, "");
      continue;
    }
    break;
  }
  return s;
}
function bashMatch(spec, command, anyAssign) {
  let g = spec.trim();
  if (g === "*" || g === "") return true;
  if (g.endsWith(":*")) g = g.slice(0, -2) + " *";
  const c = stripWrappers(command, anyAssign);
  if (g.endsWith(" *") && !g.slice(0, -2).includes("*")) {
    const base = g.slice(0, -2);
    return c === base || c.startsWith(base + " ");
  }
  return new RegExp("^" + globRe(g) + "$", "s").test(c);
}
function pathMatch(spec, file, ctx) {
  if (!file) return null;
  const home = ctx.home;
  let g = spec.trim();
  let abs = path.isAbsolute(file) ? file : path.resolve(ctx.cwd, file);
  let anchor = null;
  if (g.startsWith("//")) anchor = g.slice(1);
  else if (g.startsWith("~/")) anchor = path.join(home, g.slice(2));
  else if (g.startsWith("/")) anchor = path.join(ctx.ruleRoot, g.slice(1));
  else if (g.startsWith("./")) anchor = path.join(ctx.cwd, g.slice(2));
  const re = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(?:.*/)?") + "$");
  if (anchor) return re(anchor).test(abs) || re(anchor + "/**").test(abs);
  const rel = abs.startsWith(ctx.cwd + "/") ? abs.slice(ctx.cwd.length + 1) : abs;
  if (!g.includes("/")) return re("**/" + g).test(rel) || re("**/" + g + "/**").test(rel);
  return re(g).test(rel) || re(g.replace(/\/?$/, "/**")).test(rel);
}
const FILE_ALIAS = { Read: ["Read", "Glob", "Grep"], Edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"] };
function toolNameMatches(ruleTool, tool, kind) {
  if (ruleTool === tool) return true;
  if (FILE_ALIAS[ruleTool]?.includes(tool)) return true;
  if (ruleTool.startsWith("mcp__") && !ruleTool.slice(5).includes("__") && !ruleTool.includes("*") && tool.startsWith(ruleTool + "__")) return true;
  if (ruleTool.includes("*")) {
    if (kind !== "allow") return new RegExp("^" + globRe(ruleTool) + "$").test(tool);
    const m = /^(mcp__[^*_][^*]*?__)/.exec(ruleTool);
    if (m) return new RegExp("^" + globRe(ruleTool) + "$").test(tool);
  }
  return false;
}
/** Does one permission rule match one tool call? true, false, or null when the call lacks what the rule needs. */
export function ruleMatches(rule, call, kind, ctx) {
  const r = typeof rule === "string" ? parseRule(rule) : rule;
  if (!r || !toolNameMatches(r.tool, call.tool, kind)) return false;
  if (r.spec == null || (r.spec === "*" && /^(Bash|PowerShell)$/.test(r.tool))) return true;
  if (r.tool.startsWith("mcp__")) return false; // a rule with parentheses on an MCP tool is skipped by Claude Code
  if (/^(Bash|PowerShell)$/.test(r.tool)) {
    if (call.command == null) return null;
    return bashMatch(r.spec, call.command, kind !== "allow");
  }
  if (r.tool === "WebFetch") {
    const host = call.domain ?? (call.url ? (() => { try { return new URL(call.url).hostname; } catch { return null; } })() : null);
    if (host == null) return null;
    const d = r.spec.replace(/^domain:/, "");
    return host === d;
  }
  if (FILE_ALIAS.Read.includes(r.tool) || FILE_ALIAS.Edit.includes(r.tool)) return pathMatch(r.spec, call.path, ctx);
  const v = call.name ?? call.value ?? call.command ?? call.path;
  if (v == null) return null;
  const g = r.spec.endsWith(":*") ? r.spec.slice(0, -2) + "*" : r.spec;
  return new RegExp("^" + globRe(g) + "$").test(String(v));
}
function toolCall(o) {
  const c = { tool: o.tool };
  if (o.command != null) c.command = String(o.command);
  if (o.path != null || o.file != null) c.path = String(o.path ?? o.file);
  if (o.url != null) c.url = String(o.url);
  if (o.domain != null) c.domain = String(o.domain);
  if (o.name != null) c.name = String(o.name);
  return c;
}

// ---------- the client ----------

export function make({ settings, push, cwd, act }) {
  return makeSetup({ cwd: cwd || process.cwd(), push, act: !!act });
}

export function makeSetup({ cwd, push = () => {}, act = false, home = home0(), managedDir, stateDir } = {}) {
  const claudeDir = path.join(home, ".claude");
  const managed = managedDir ?? (process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code");
  const state = stateDir || path.join(process.env.ASK_KIT_STATE || (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "ask-kit") : path.join(home, ".local", "state", "ask-kit")), "claude-setup-backups");
  const sh = (p) => short(p, home);

  function folderOf(o) {
    const f = o?.folder ? path.resolve(cwd, String(o.folder).replace(/^~(?=\/|$)/, home)) : cwd;
    if (!fs.existsSync(f)) fail(`no such folder: ${f}`);
    return f;
  }
  function rootOf(folder) {
    let d = folder;
    for (;;) {
      if (exists(path.join(d, ".git"))) return d;
      const up = path.dirname(d);
      if (up === d) return folder;
      d = up;
    }
  }

  /** The files a folder's settings come from, lowest precedence first, each read: scope, path, exists, valid, data. */
  function layers(o = {}) {
    const folder = folderOf(o);
    const root = rootOf(folder);
    const out = [];
    const userFile = path.join(claudeDir, "settings.json");
    out.push({ scope: "user", ...readJson(userFile) });
    const proj = path.join(root, ".claude", "settings.json");
    if (proj !== userFile) out.push({ scope: "project", ...readJson(proj) });
    out.push({ scope: "local", ...readJson(path.join(root, ".claude", "settings.local.json")) });
    const mfiles = [];
    const mj = path.join(managed, "managed-settings.json");
    mfiles.push(mj);
    try {
      for (const f of fs.readdirSync(path.join(managed, "managed-settings.d")).filter((x) => x.endsWith(".json")).sort()) mfiles.push(path.join(managed, "managed-settings.d", f));
    } catch {}
    for (const f of mfiles) {
      const r = readJson(f);
      if (r.exists) out.push({ scope: "managed", ...r });
    }
    if (!out.some((l) => l.scope === "managed")) out.push({ scope: "managed", path: mj, exists: false });
    return { folder, root, layers: out };
  }
  const present = (L) => L.layers.filter((l) => l.exists && l.valid);
  const mergedOf = (L) => {
    let m = {};
    for (const l of present(L)) m = deepMerge(m, l.data);
    return m;
  };
  function deepMerge(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
    if (isObj(a) && isObj(b)) {
      const r = { ...a };
      for (const k of Object.keys(b)) r[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
      return r;
    }
    return b;
  }
  const layerSummary = (l) => ({ scope: l.scope, path: sh(l.path), exists: !!l.exists, ...(l.exists ? { valid: !!l.valid } : {}), ...(l.error ? { error: l.error } : {}), ...(l.valid ? { keys: Object.keys(l.data).length } : {}) });

  // ~/.claude.json: only the keys this client needs. It also holds account data and history, which are never read out.
  function claudeJson(folder, root) {
    const r = readJson(path.join(home, ".claude.json"));
    const out = { path: sh(r.path), exists: !!r.exists, valid: r.valid, error: r.error, userMcp: {}, project: {}, projectKey: null };
    if (!r.valid) return out;
    out.userMcp = isObj(r.data.mcpServers) ? r.data.mcpServers : {};
    const projects = isObj(r.data.projects) ? r.data.projects : {};
    const key = [folder, root].find((k) => isObj(projects[k]));
    if (key) {
      const p = projects[key];
      out.projectKey = key;
      out.project = { mcpServers: isObj(p.mcpServers) ? p.mcpServers : {}, allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools : [], enabledMcpjsonServers: p.enabledMcpjsonServers ?? [], disabledMcpjsonServers: p.disabledMcpjsonServers ?? [], disabledMcpServers: p.disabledMcpServers ?? [], enabledMcpServers: p.enabledMcpServers ?? [] };
    }
    return out;
  }

  // ---------- plugins and mods ----------

  function pluginState(L) {
    const inst = readJson(path.join(claudeDir, "plugins", "installed_plugins.json"));
    const known = readJson(path.join(claudeDir, "plugins", "known_marketplaces.json"));
    const merged = mergedOf(L);
    const enabled = isObj(merged.enabledPlugins) ? merged.enabledPlugins : {};
    const enabledIn = {};
    for (const l of present(L)) if (isObj(l.data.enabledPlugins)) for (const [k, v] of Object.entries(l.data.enabledPlugins)) enabledIn[k] = { scope: l.scope, value: v };
    return { inst, known, merged, enabled, enabledIn };
  }
  const asList = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  /** What a plugin folder contributes: skills, agents, commands, hooks, MCP servers; and whether it is a mod. */
  function inspectPlugin(dir) {
    const out = { dir: sh(dir), exists: exists(dir), skills: [], agents: [], commands: [], hooks: [], mcpServers: [], mod: null };
    if (!out.exists) return out;
    const mf = readJson(path.join(dir, ".claude-plugin", "plugin.json"));
    const m = mf.valid ? mf.data : {};
    out.name = typeof m.name === "string" ? m.name : path.basename(dir);
    out.version = m.version;
    if (mf.exists && !mf.valid) out.manifestError = mf.error;
    const names = (rel, kind) => {
      const found = [];
      const paths = [...asList(m[kind]), ...(m[kind] === undefined || kind !== "skills" ? [] : [])];
      const dirs = [path.join(dir, kind), ...paths.map((p) => path.resolve(dir, p))];
      for (const d of dirs) {
        try {
          const st = fs.statSync(d);
          if (st.isFile()) found.push(path.basename(d, ".md"));
          else
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (e.isDirectory() || e.isSymbolicLink()) {
                if (exists(path.join(d, e.name, "SKILL.md"))) found.push(e.name);
              } else if (e.name.endsWith(".md")) found.push(e.name.slice(0, -3));
            }
        } catch {}
      }
      return [...new Set(found)];
    };
    out.skills = names(dir, "skills");
    out.agents = names(dir, "agents");
    out.commands = names(dir, "commands");
    // hooks: inline in the manifest, a path in the manifest, or hooks/hooks.json
    let hooksObj = null;
    let hooksFile = null;
    if (isObj(m.hooks)) hooksObj = m.hooks;
    else if (typeof m.hooks === "string") hooksFile = path.resolve(dir, m.hooks);
    if (!hooksObj) hooksFile = hooksFile || path.join(dir, "hooks", "hooks.json");
    if (hooksFile) {
      const h = readJson(hooksFile);
      if (h.valid) {
        if (Array.isArray(h.data.modules)) out.mod = { hooksFile: sh(hooksFile), modules: h.data.modules.map((x) => ({ module: x, exists: exists(path.resolve(path.dirname(hooksFile), String(x))) })) };
        hooksObj = isObj(h.data.hooks) ? h.data.hooks : Object.keys(h.data).some((k) => EVENTS.includes(k)) ? h.data : null;
      } else if (h.exists) out.hooksError = h.error;
    }
    out.hookDefs = hooksObj;
    // MCP servers: .mcp.json at the root, or inline in the manifest
    let servers = isObj(m.mcpServers) ? m.mcpServers : null;
    if (!servers) {
      const mj = readJson(path.join(dir, ".mcp.json"));
      if (mj.valid) servers = isObj(mj.data.mcpServers) ? mj.data.mcpServers : mj.data;
    }
    out.mcpDefs = servers || {};
    out.mcpServers = Object.keys(out.mcpDefs);
    return out;
  }
  const hookCount = (h) => (isObj(h) ? Object.values(h).reduce((n, g) => n + (Array.isArray(g) ? g.reduce((k, x) => k + (Array.isArray(x?.hooks) ? x.hooks.length : 0), 0) : 0), 0) : 0);
  function installsFor(ps, L, id) {
    const list = ps.inst.valid && isObj(ps.inst.data.plugins) ? ps.inst.data.plugins[id] : null;
    return (Array.isArray(list) ? list : []).filter((e) => !e.projectPath || e.projectPath === L.root || e.projectPath === L.folder);
  }

  /** Marketplaces, installed plugins (version, scope, enabled, what each contributes) and mods, for a folder. */
  function plugins(o = {}) {
    const L = layers(o);
    const ps = pluginState(L);
    const out = { folder: L.folder, marketplaces: [], plugins: [], enabledNotInstalled: [], installedNotEnabled: [], mods: mods(o, L), notes: [] };
    const fromSettings = {};
    for (const l of present(L)) if (isObj(l.data.extraKnownMarketplaces)) for (const [k, v] of Object.entries(l.data.extraKnownMarketplaces)) fromSettings[k] = { scope: l.scope, source: v?.source };
    const srcText = (s) => (!s ? null : s.source === "github" ? `github:${s.repo}` : s.source === "git" || s.source === "url" ? maskUrl(String(s.url ?? s.repo ?? "")) : s.source === "directory" || s.source === "file" ? s.path : s.source);
    const kn = ps.known.valid ? ps.known.data : {};
    for (const [name, v] of Object.entries(kn)) out.marketplaces.push({ name, source: srcText(v?.source), installLocation: sh(v?.installLocation), exists: v?.installLocation ? exists(v.installLocation) : false, lastUpdated: v?.lastUpdated, declaredInSettings: fromSettings[name]?.scope ?? null });
    for (const [name, v] of Object.entries(fromSettings)) if (!(name in kn)) out.marketplaces.push({ name, source: srcText(v.source), declaredInSettings: v.scope, installed: false, note: "declared in settings but not in known_marketplaces.json: Claude Code adds it at the next start or `claude plugin marketplace add`" });
    const ids = new Set([...Object.keys(ps.inst.valid && isObj(ps.inst.data.plugins) ? ps.inst.data.plugins : {}), ...Object.keys(ps.enabled)]);
    for (const id of ids) {
      if (id.endsWith("@inline") || id.endsWith("@builtin")) {
        if (ps.enabled[id] !== undefined) out.plugins.push({ id, kind: id.split("@")[1], enabled: ps.enabled[id], enabledIn: ps.enabledIn[id]?.scope });
        continue;
      }
      const installs = ps.inst.valid && isObj(ps.inst.data.plugins) ? ps.inst.data.plugins[id] || [] : [];
      const here = installsFor(ps, L, id);
      const row = { id, installs: installs.filter((e) => !e.projectPath || e.projectPath === L.root || e.projectPath === L.folder).map((e) => ({ scope: e.scope, ...(e.projectPath ? { projectPath: e.projectPath } : {}), version: e.version, installPath: sh(e.installPath), installPathExists: exists(e.installPath || "") })), ...(installs.some((e) => e.projectPath && e.projectPath !== L.root && e.projectPath !== L.folder) ? { installedForOtherProjects: installs.filter((e) => e.projectPath && e.projectPath !== L.root && e.projectPath !== L.folder).length } : {}), installedHere: here.length > 0, enabled: ps.enabled[id] === true, enabledIn: ps.enabledIn[id] ? `${ps.enabledIn[id].scope} (${ps.enabledIn[id].value})` : null };
      if (here.length && exists(here[0].installPath || "")) {
        const p = inspectPlugin(here[0].installPath);
        row.contributes = { skills: p.skills.slice(0, 20), agents: p.agents.slice(0, 20), commands: p.commands.slice(0, 20), hooks: hookCount(p.hookDefs), mcpServers: p.mcpServers, mod: !!p.mod };
        if (p.skills.length > 20) row.contributes.skillsTotal = p.skills.length;
      }
      out.plugins.push(row);
      if (row.enabled && !installs.length) out.enabledNotInstalled.push(id);
      if (installs.length && ps.enabled[id] !== true && here.length) out.installedNotEnabled.push(id);
    }
    out.notes.push("A plugin is active in a folder when it is installed for the user (or for that project) and enabledPlugins sets it true in the merged settings.");
    return out;
  }

  /** Mods under ~/.claude/mods, and whether each is loaded. Claude Code does not scan that folder: a mod loads through CLAUDE_CODE_PLUGIN_DIRS, --plugin-dir, or as an installed plugin. */
  function mods(o = {}, L0) {
    const L = L0 || layers(o);
    const merged = mergedOf(L);
    const envDirs = String((isObj(merged.env) ? merged.env.CLAUDE_CODE_PLUGIN_DIRS : "") || process.env.CLAUDE_CODE_PLUGIN_DIRS || "").split(":").filter(Boolean);
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const loadedSet = new Set(envDirs.map(real));
    const out = { folder: path.join(sh(claudeDir), "mods"), loadedBy: envDirs.length ? `env CLAUDE_CODE_PLUGIN_DIRS names ${envDirs.length} folders` : "no CLAUDE_CODE_PLUGIN_DIRS", mods: [], missingFromDirs: [] };
    const dir = path.join(claudeDir, "mods");
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const row = { name: e.name, path: sh(p) };
      if (e.isSymbolicLink()) {
        row.symlinkTo = sh(fs.readlinkSync(p));
        row.targetExists = exists(p);
      }
      if (exists(p)) {
        const info = inspectPlugin(real(p));
        row.plugin = info.name;
        row.version = info.version;
        if (info.mod) row.modules = info.mod.modules;
        else row.note = "no hooks/hooks.json `modules` entry: not a mod";
        if (info.manifestError) row.manifestError = info.manifestError;
        row.loaded = loadedSet.has(real(p));
      } else row.loaded = false;
      out.mods.push(row);
    }
    for (const d of envDirs) if (!exists(d)) out.missingFromDirs.push(sh(d));
    out.loadedCount = out.mods.filter((m) => m.loaded).length;
    return out;
  }

  // ---------- hooks ----------

  function normalizeHooks(obj, source, vars, cwd2) {
    const rows = [];
    if (!isObj(obj)) return rows;
    for (const [event, groups] of Object.entries(obj)) {
      if (!Array.isArray(groups)) {
        rows.push({ event, source, malformed: "the value is not an array of matcher groups" });
        continue;
      }
      groups.forEach((g, gi) => {
        if (!isObj(g)) return rows.push({ event, source, malformed: `group ${gi} is not an object` });
        const hs = Array.isArray(g.hooks) ? g.hooks : [];
        if (!Array.isArray(g.hooks)) rows.push({ event, matcher: g.matcher, source, malformed: `group ${gi} has no hooks array` });
        hs.forEach((h, hi) => {
          const r = { event, matcher: typeof g.matcher === "string" ? g.matcher : g.matcher === undefined ? null : g.matcher, type: h?.type, source, at: `${event}[${gi}].hooks[${hi}]` };
          if (!isObj(h)) return rows.push({ ...r, malformed: "handler is not an object" });
          if (h.if !== undefined) r.if = h.if;
          if (h.timeout !== undefined) r.timeout = h.timeout;
          if (h.async) r.async = true;
          if (h.once) r.once = true;
          if (h.type === "command") {
            r.command = maskString([h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => x != null).join(" "));
            r._raw = { command: h.command, args: h.args };
            r.target = commandTarget(h.command, Array.isArray(h.args) ? h.args : null, vars, cwd2);
            if (r.target?.script) r.target.script = short(r.target.script, home);
            if (r.target) r.target = compact(r.target);
          } else if (h.type === "http") r.url = typeof h.url === "string" ? maskUrl(h.url) : null;
          else if (h.type === "mcp_tool") r.mcp = `${h.server}.${h.tool}`;
          else if (h.type === "prompt" || h.type === "agent") r.prompt = maskString(String(h.prompt ?? "")).slice(0, 100);
          rows.push(r);
        });
      });
    }
    return rows;
  }
  const compact = (t) => Object.fromEntries(Object.entries(t).filter(([k, v]) => v !== undefined && v !== null && !(k === "complex" && v === false)));

  /**
   * Every hook that applies to a folder: settings layers, enabled plugins, and mods (listed as mod modules).
   * o.event, o.tool narrow the list. Rows keep their source and their position in `order`.
   */
  function hooks(o = {}) {
    const L = layers(o);
    const ps = pluginState(L);
    const rows = [];
    const notes = [];
    for (const l of present(L)) {
      const vars = { HOME: home, CLAUDE_PROJECT_DIR: L.root };
      rows.push(...normalizeHooks(l.data.hooks, { kind: "settings", scope: l.scope, file: sh(l.path) }, vars, L.root));
      if (l.data.disableAllHooks === true) notes.push(`${l.scope} settings (${sh(l.path)}) set disableAllHooks: true, which turns off user, project, local and plugin hooks (managed hooks keep running)`);
      if (l.data.allowManagedHooksOnly === true) notes.push(`${l.scope} settings set allowManagedHooksOnly: true`);
    }
    for (const id of Object.keys(ps.enabled).filter((k) => ps.enabled[k] === true)) {
      for (const inst of installsFor(ps, L, id).slice(0, 1)) {
        if (!exists(inst.installPath || "")) continue;
        const p = inspectPlugin(inst.installPath);
        const vars = { HOME: home, CLAUDE_PROJECT_DIR: L.root, CLAUDE_PLUGIN_ROOT: inst.installPath };
        rows.push(...normalizeHooks(p.hookDefs, { kind: "plugin", plugin: id, file: sh(inst.installPath) }, vars, inst.installPath));
      }
    }
    for (const m of mods(o, L).mods.filter((x) => x.loaded && x.modules)) rows.push({ event: "(mod)", type: "mod", source: { kind: "mod", name: m.name, file: m.path }, modules: m.modules.map((x) => x.module) });
    let list = rows;
    if (o.event) list = list.filter((r) => r.event === o.event);
    if (o.tool) list = list.filter((r) => r.type === "mod" || !TOOL_EVENTS.has(r.event) || matcherTest(r.event, r.matcher, o.tool).match !== false);
    const strip = ({ _raw, ...r }) => r;
    const order = list.map((r, i) => ({ n: i + 1, ...strip(r) }));
    return { folder: L.folder, project: L.root, total: rows.length, shown: order.length, layers: L.layers.map(layerSummary), notes, hooks: order, _rows: rows };
  }

  /** The `if` field is one permission rule, tested against the tool call. null when the call lacks what it needs. */
  function ifMatches(cond, call, ctx) {
    if (cond == null) return { applies: true };
    if (typeof cond !== "string") return { applies: false, why: "if is not a string" };
    if (/&&|\|\|/.test(cond)) return { applies: null, why: "if holds one rule only (no && or ||): the form is wrong" };
    const parts = call.command ? splitCommand(call.command) : [];
    const r = parseRule(cond);
    if (!r) return { applies: null, why: "if is not a permission rule" };
    if (!toolNameMatches(r.tool, call.tool, "ask")) return { applies: false, why: `if names ${r.tool}, the call is ${call.tool}` };
    if (/^(Bash|PowerShell)$/.test(r.tool) && r.spec && parts.length) {
      const hit = parts.some((p) => bashMatch(r.spec, p, true));
      return { applies: hit || /\$\(|`|\$\w/.test(call.command) && r.spec.includes(" "), why: hit ? "a subcommand matches" : "no subcommand matches" };
    }
    const m = ruleMatches(r, call, "ask", ctx);
    return { applies: m === null ? null : m, why: m === null ? "no command or path given to test the if" : m ? "matches" : "does not match" };
  }

  /**
   * The hooks that would run for an event, in settings order. o: event (required); tool (tool name, or the matcher target: source, notification type, agent type);
   * command and file narrow the `if` test. Hooks in one group run in parallel; identical handlers run once.
   */
  function wouldFire(o = {}) {
    if (!o.event) fail("wouldFire needs an event");
    if (!EVENTS.includes(o.event)) fail(`unknown event ${o.event}; the names are case-sensitive: ${EVENTS.join(", ")}`);
    const H = hooks({ folder: o.folder });
    const call = toolCall({ tool: o.tool, command: o.command, file: o.file ?? o.path });
    const ctx = { home, cwd: H.folder, ruleRoot: H.project };
    const fires = [], notFiring = [];
    const seen = new Set();
    for (const r of H._rows.filter((x) => x.event === o.event)) {
      if (r.malformed) {
        notFiring.push({ ...pick(r), why: r.malformed });
        continue;
      }
      const mt = matcherTest(r.event, r.matcher, o.tool);
      const why = [];
      let fire = mt.match;
      if (mt.invalid) why.push(mt.invalid);
      else why.push(mt.why);
      let ifr = null;
      if (r.if !== undefined) {
        if (!TOOL_EVENTS.has(r.event)) {
          fire = false;
          why.push(`has an if, which is only evaluated on tool events: this hook never runs on ${r.event}`);
        } else {
          ifr = ifMatches(r.if, call, ctx);
          if (ifr.applies === false) fire = false;
          else if (ifr.applies === null && fire) fire = null;
          why.push(`if ${r.if}: ${ifr.why ?? (ifr.applies ? "applies" : "no")}`);
        }
      }
      const disabled = H.notes.find((n) => /disableAllHooks/.test(n) && r.source.kind !== "managed");
      if (disabled && fire) why.push("but disableAllHooks is set");
      const key = JSON.stringify([r.type, r.command ?? r.url ?? r.prompt ?? r.mcp, r.matcher]);
      if (fire && seen.has(key)) why.push("identical to an earlier hook: runs once");
      if (fire) seen.add(key);
      (fire === false ? notFiring : fires).push({ ...pick(r), result: fire === null ? "maybe" : fire ? "fires" : "no", why: why.join("; ") });
    }
    return { event: o.event, tool: o.tool ?? null, input: { command: o.command ? maskString(o.command).slice(0, 120) : undefined, file: o.file ?? o.path }, fires: fires.map((x, i) => ({ order: i + 1, ...x })), notFiring: notFiring.length, notFiringList: notFiring.slice(0, 20), notes: [...H.notes, "Hooks from every location fire together; a PreToolUse deny beats allow rules, and a hook allow never overrides a settings deny. Mods and the permission mode can also decide a call."] };
  }
  const pick = (r) => ({ event: r.event, matcher: r.matcher ?? null, type: r.type, command: r.command, url: r.url, mcp: r.mcp, prompt: r.prompt, if: r.if, timeout: r.timeout, source: r.source, at: r.at, target: r.target });

  // ---------- permissions ----------

  function ruleLists(L, cj) {
    const out = [];
    for (const l of present(L)) {
      const p = isObj(l.data.permissions) ? l.data.permissions : {};
      for (const kind of ["allow", "ask", "deny"]) for (const [i, rule] of (Array.isArray(p[kind]) ? p[kind] : []).entries()) out.push({ kind, rule, source: `${l.scope}: ${sh(l.path)}`, scope: l.scope, index: i, ruleRoot: l.scope === "user" || l.scope === "managed" ? claudeDir : L.root });
    }
    for (const rule of cj.project.allowedTools ?? []) out.push({ kind: "allow", rule, source: `~/.claude.json projects[${sh(cj.projectKey)}].allowedTools`, scope: "claude.json", ruleRoot: L.root });
    return out;
  }

  /** Allow, ask and deny rules for a folder with where each comes from; with a tool call, the rule that decides it (deny, then ask, then allow). */
  function permissions(o = {}) {
    if (o.tool) return decide(o);
    const L = layers(o);
    const cj = claudeJson(L.folder, L.root);
    const rules = ruleLists(L, cj);
    const merged = mergedOf(L);
    const out = { folder: L.folder, defaultMode: merged.permissions?.defaultMode ?? "default", defaultModeFrom: lastScope(L, (d) => d.permissions?.defaultMode), counts: {}, rules: {}, notes: [] };
    for (const kind of ["deny", "ask", "allow"]) {
      const rs = rules.filter((r) => r.kind === kind);
      out.counts[kind] = rs.length;
      out.rules[kind] = rs.slice(0, o.max ?? 60).map((r) => `${typeof r.rule === "string" ? maskString(r.rule) : JSON.stringify(r.rule)}  <- ${r.source}`);
      if (rs.length > (o.max ?? 60)) out.rules[kind].push(`[${rs.length - (o.max ?? 60)} more cut]`);
    }
    for (const k of ["additionalDirectories", "disableBypassPermissionsMode", "disableAutoMode", "blockReadsOutsideWorkingDirectories", "blockWritesOutsideWorkingDirectories", "denyInsteadOfPrompting"]) if (merged.permissions?.[k] !== undefined) out[k] = merged.permissions[k];
    if (merged.skipDangerousModePermissionPrompt) out.skipDangerousModePermissionPrompt = true;
    if (merged.autoMode) out.autoMode = "configured (classifier rules)";
    if (!rules.length) out.notes.push("No permission rules in any layer: the permission mode decides every call. Read-only Bash commands and file reads in the working directories need no approval.");
    out.notes.push("Rules from every layer are combined, not replaced. Order: deny, then ask, then allow; the first match decides, a narrower allow never overrides a broader deny or ask. A hook or mod can also approve or block a call.");
    return out;
  }
  const lastScope = (L, get) => {
    let s = null;
    for (const l of present(L)) if (get(l.data) !== undefined) s = l.scope;
    return s;
  };

  /** The rule that decides one tool call. o: tool ("Bash", "Read", "Edit", "WebFetch", "mcp__server__tool"...) and command, path, url or name. */
  function decide(o = {}) {
    if (!o.tool) fail("decide needs a tool name");
    const L = layers(o);
    const cj = claudeJson(L.folder, L.root);
    const rules = ruleLists(L, cj);
    const call = toolCall(o);
    const merged = mergedOf(L);
    const mode = merged.permissions?.defaultMode ?? "default";
    const evalOne = (c) => {
      const tried = [];
      for (const kind of ["deny", "ask", "allow"])
        for (const r of rules.filter((x) => x.kind === kind)) {
          const m = ruleMatches(r.rule, c, kind, { home, cwd: L.folder, ruleRoot: r.ruleRoot });
          if (m === true) return { decision: kind, rule: maskString(String(r.rule)), source: r.source };
          if (m === null) tried.push({ kind, rule: maskString(String(r.rule)), source: r.source });
        }
      return { decision: "none", maybe: tried.slice(0, 8) };
    };
    const out = { tool: o.tool, input: { command: call.command ? maskString(call.command).slice(0, 160) : undefined, path: call.path, url: call.url ? maskUrl(call.url) : undefined }, mode, notes: [] };
    if (/^(Bash|PowerShell)$/.test(o.tool) && call.command) {
      const parts = splitCommand(call.command);
      const per = parts.map((p) => ({ part: maskString(p).slice(0, 100), ...evalOne({ ...call, command: p }) }));
      out.parts = per;
      const deny = per.find((p) => p.decision === "deny"), ask = per.find((p) => p.decision === "ask");
      if (deny) Object.assign(out, { decision: "deny", rule: deny.rule, source: deny.source });
      else if (ask) Object.assign(out, { decision: "ask", rule: ask.rule, source: ask.source });
      else if (per.length && per.every((p) => p.decision === "allow")) Object.assign(out, { decision: "allow", rule: per.map((p) => p.rule).join(" + "), source: [...new Set(per.map((p) => p.source))].join(", ") });
      else out.decision = "none";
      if (per.length > 1) out.notes.push("A compound command is allowed only when every part is allowed; one denied or asked part decides the whole.");
    } else Object.assign(out, evalOne(call));
    if (out.decision === "none") out.notes.push(`No rule matches: the permission mode (${mode}) decides. Read-only commands and reads inside the working directories need no approval; hooks and mods can still approve or block.${mode === "auto" ? " In auto mode a classifier reviews the call." : ""}`);
    out.notes.push("Path and wildcard matching here follows the documented rules but is approximate for unusual patterns; `claude` itself has the last word.");
    return out;
  }

  // ---------- MCP ----------

  function describeServer(name, def, scope, file, vars, cwd2, extra = {}) {
    const row = { name, scope, file, ...extra };
    if (!isObj(def)) return { ...row, malformed: "the entry is not an object" };
    row.transport = def.type ?? (def.url ? "http" : def.command ? "stdio" : "unknown");
    if (def.command) {
      row.command = maskString(String(def.command));
      if (Array.isArray(def.args)) row.args = def.args.slice(0, 12).map((a) => maskString(String(a)));
      const t = commandTarget(String(def.command), Array.isArray(def.args) ? def.args : null, vars, cwd2);
      row.programFound = t ? (t.program ? !!t.onPath : t.script ? t.exists : t.interpreterOnPath ?? null) : null;
      const prog = tokenize(String(def.command))[0];
      if (prog && !prog.includes("/")) row.onPath = which(prog) ? sh(which(prog)) : null;
      else if (prog) {
        const p = path.resolve(cwd2, expandVars(prog, vars));
        row.onPath = isExec(p) ? sh(p) : null;
      }
    }
    if (def.url) row.url = maskUrl(String(def.url));
    if (isObj(def.env)) row.envKeys = Object.keys(def.env);
    if (isObj(def.headers)) row.headerKeys = Object.keys(def.headers);
    if (def.disabled === true) row.disabled = true;
    return row;
  }

  /** MCP servers for a folder by scope: user and local (~/.claude.json), project (.mcp.json), plugin, managed. Env and header values are never returned, only their names. */
  function mcp(o = {}) {
    const L = layers(o);
    const cj = claudeJson(L.folder, L.root);
    const merged = mergedOf(L);
    const vars = { HOME: home, CLAUDE_PROJECT_DIR: L.root };
    const servers = [];
    const notes = [];
    const disabled = new Set([...(cj.project.disabledMcpServers ?? [])]);
    for (const [n, d] of Object.entries(cj.userMcp)) servers.push(describeServer(n, d, "user", cj.path, vars, L.root));
    for (const [n, d] of Object.entries(cj.project.mcpServers ?? {})) servers.push(describeServer(n, d, "local", `${cj.path} projects[${sh(cj.projectKey)}]`, vars, L.root));
    const mj = readJson(path.join(L.root, ".mcp.json"));
    const enabledJson = new Set([...(Array.isArray(merged.enabledMcpjsonServers) ? merged.enabledMcpjsonServers : []), ...(cj.project.enabledMcpjsonServers ?? [])]);
    const disabledJson = new Set([...(Array.isArray(merged.disabledMcpjsonServers) ? merged.disabledMcpjsonServers : []), ...(cj.project.disabledMcpjsonServers ?? [])]);
    if (mj.exists && !mj.valid) notes.push(`.mcp.json: ${mj.error}`);
    if (mj.valid) {
      const defs = isObj(mj.data.mcpServers) ? mj.data.mcpServers : {};
      for (const [n, d] of Object.entries(defs)) {
        const status = disabledJson.has(n) ? "rejected (disabledMcpjsonServers)" : merged.enableAllProjectMcpServers === true ? "approved (enableAllProjectMcpServers)" : enabledJson.has(n) ? "approved (enabledMcpjsonServers)" : "pending approval: a person approves it in an interactive session";
        servers.push(describeServer(n, d, "project", sh(mj.path), vars, L.root, { status }));
      }
    }
    const ps = pluginState(L);
    for (const id of Object.keys(ps.enabled).filter((k) => ps.enabled[k] === true)) {
      for (const inst of installsFor(ps, L, id).slice(0, 1)) {
        if (!exists(inst.installPath || "")) continue;
        const p = inspectPlugin(inst.installPath);
        for (const [n, d] of Object.entries(p.mcpDefs)) servers.push(describeServer(`plugin:${p.name}:${n}`, d, "plugin", sh(inst.installPath), { ...vars, CLAUDE_PLUGIN_ROOT: inst.installPath }, inst.installPath, { plugin: id, toolPrefix: `mcp__plugin_${p.name}_${n}__` }));
      }
    }
    const mm = readJson(path.join(managed, "managed-mcp.json"));
    if (mm.valid) for (const [n, d] of Object.entries(isObj(mm.data.mcpServers) ? mm.data.mcpServers : {})) servers.push(describeServer(n, d, "managed", sh(mm.path), vars, L.root));
    for (const s of servers) if (disabled.has(s.name)) s.disabled = true;
    for (const s of servers) if (!s.toolPrefix) s.toolPrefix = `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
    notes.push("claude.ai connectors (Slack, Docs...) come from the account, are not in any file, and show in `claude mcp list`. A project's own list of servers a person switched off lives in ~/.claude.json (disabledMcpServers).");
    const byName = {};
    for (const s of servers) (byName[s.name] ??= []).push(s);
    const same = (x, y) => JSON.stringify([x.command, x.args, x.url]) === JSON.stringify([y.command, y.args, y.url]);
    const dup = Object.entries(byName).filter(([, v]) => v.length > 1).map(([n, v]) => `${n}: ${v.map((x) => x.scope).join(", ")}${v.every((x) => same(x, v[0])) ? " (same definition)" : " (different definitions)"}`);
    return { folder: L.folder, project: L.root, claudeJson: { path: cj.path, ...(cj.valid === false ? { error: cj.error } : {}), localKey: cj.projectKey ? sh(cj.projectKey) : null }, total: servers.length, servers, sameNameInSeveralScopes: dup, notes };
  }

  // ---------- settings ----------

  const EXPAND = new Set(["env", "permissions", "enabledPlugins", "extraKnownMarketplaces", "pluginConfigs", "modelSettings"]);
  /**
   * The settings in force after the layers merge, with the layer that set each key (highest of managed, local, project, user wins; lists merge).
   * o.key narrows to a key or a dotted path prefix ("model", "env", "permissions.allow").
   */
  function settings(o = {}) {
    const L = layers(o);
    const keys = new Map();
    for (const l of present(L)) {
      for (const [k, v] of Object.entries(l.data)) {
        if (k === "hooks") {
          for (const [ev, g] of Object.entries(isObj(v) ? v : {})) add(`hooks.${ev}`, l.scope, `${hookCount({ [ev]: g })} handlers`);
        } else if (EXPAND.has(k) && isObj(v)) {
          for (const [sk, sv] of Object.entries(v)) add(`${k}.${sk}`, l.scope, sv, k);
        } else add(k, l.scope, v);
      }
    }
    function add(key, scope, value, parent) {
      const e = keys.get(key) ?? [];
      e.push({ scope, value, parent });
      keys.set(key, e);
    }
    const rows = [];
    for (const [key, es] of keys) {
      if (o.key && !(key === o.key || key.startsWith(o.key + ".") || key.startsWith(o.key))) continue;
      const winner = es[es.length - 1];
      const list = es.every((e) => Array.isArray(e.value));
      const val = list ? [...new Set(es.flatMap((e) => e.value.map((x) => JSON.stringify(x))))].map((x) => JSON.parse(x)) : winner.value;
      const top = key.split(".")[0];
      const row = { key, value: shorten(key.startsWith("env.") ? "<set>" : maskValue(top === "env" || top === "mcpServers" ? top : key.split(".").pop(), val)), from: list ? [...new Set(es.map((e) => e.scope))].join("+") : winner.scope };
      if (!list && es.length > 1) row.alsoSetIn = es.slice(0, -1).map((e) => e.scope);
      rows.push(row);
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    const notes = ["Lists (permissions.allow, deny, ask) merge across layers; a scalar comes from the highest layer that sets it: managed, then a --settings flag, then local, project, user. A flag or shell environment variable can override a file for one session, which no file shows."];
    if (!L.layers.some((l) => l.scope === "managed" && l.exists)) notes.push("No managed settings file on this machine.");
    return { folder: L.folder, project: L.root, layers: L.layers.map(layerSummary), total: rows.length, effective: rows.slice(0, o.max ?? 120), cut: Math.max(0, rows.length - (o.max ?? 120)), notes };
  }

  // ---------- check ----------

  /** Problems across every layer, hook, rule, MCP server, plugin and mod. Each: severity, where (file), key, problem. */
  function check(o = {}) {
    const L = layers(o);
    const probs = [];
    const P = (severity, where, key, problem) => probs.push({ severity, where, key, problem });
    for (const l of L.layers) if (l.exists && !l.valid) P("error", sh(l.path), "(file)", l.error);
    const hs = hooks(o);
    const seen = new Map();
    for (const r of hs._rows) {
      const where = r.source.file ?? r.source.name;
      const key = `hooks.${r.at ?? r.event}`;
      if (r.type === "mod") continue;
      if (r.malformed) {
        P("error", where, key, r.malformed);
        continue;
      }
      if (!EVENTS.includes(r.event)) P("warn", where, key, `unknown event name ${r.event} (names are case-sensitive)`);
      if (!HANDLER_TYPES.has(r.type)) P("error", where, key, `unknown handler type ${r.type}`);
      if (r.matcher !== null && typeof r.matcher !== "string") P("error", where, key, "matcher is not a string");
      else if (typeof r.matcher === "string" && NO_MATCHER.has(r.event) && r.matcher !== "") P("info", where, key, `${r.event} has no matcher: "${r.matcher}" is ignored and the hook always fires`);
      else if (typeof r.matcher === "string") {
        const mt = matcherTest(r.event, r.matcher, "x");
        if (mt.invalid) P("error", where, key, `matcher ${mt.invalid}`);
      }
      if (r.timeout !== undefined && typeof r.timeout !== "number") P("error", where, key, "timeout is not a number (it is in seconds)");
      if (r.if !== undefined && !TOOL_EVENTS.has(r.event)) P("error", where, key, `has an if on ${r.event}: the hook never runs, because if is only evaluated on tool events`);
      if (typeof r.if === "string" && /&&|\|\|/.test(r.if)) P("error", where, key, "if holds one permission rule: && and || are not supported (use one handler per condition)");
      if (r.type === "command") {
        if (!r._raw.command) P("error", where, key, "command hook without a command");
        const t = r.target;
        if (t?.script && !t.unresolved) {
          if (!t.exists) P("error", where, key, `script not found: ${t.script}`);
          else if (t.runsDirectly && !t.executable) P("error", where, key, `script is not executable: ${t.script}`);
        } else if (t?.program && !t.onPath) P("error", where, key, `program not on PATH: ${t.program}`);
      }
      if (r.type === "http" && !r.url) P("error", where, key, "http hook without a url");
      const dkey = JSON.stringify([r.event, r.matcher, r.type, r.command ?? r.url ?? r.prompt ?? r.mcp, r.if]);
      if (seen.has(dkey)) P("info", where, key, `same hook as in ${seen.get(dkey)}: identical handlers run once`);
      else seen.set(dkey, where);
    }
    // permissions
    const cj = claudeJson(L.folder, L.root);
    const rules = ruleLists(L, cj);
    for (const r of rules) {
      const where = r.source;
      const key = `permissions.${r.kind}`;
      const p = parseRule(r.rule);
      if (!p) {
        P("error", where, key, `rule is not in the form Tool or Tool(specifier): ${maskString(JSON.stringify(r.rule)).slice(0, 80)}`);
        continue;
      }
      const shownRule = maskString(String(r.rule)).slice(0, 80);
      if (p.tool.startsWith("mcp__") && p.spec !== undefined) P("error", where, key, `"${shownRule}": Claude Code skips an mcp__ rule that has parentheses`);
      else if (!p.tool.startsWith("mcp__") && !KNOWN_TOOLS.has(p.tool) && !p.tool.includes("*")) P("warn", where, key, `"${shownRule}": unknown tool name ${p.tool} (tool names are case-sensitive)`);
      if (/^(Bash|PowerShell)$/.test(p.tool) && p.spec) {
        if (/^command:/.test(p.spec)) P("error", where, key, `"${shownRule}": a command: prefix is ignored with a startup warning; write Bash(rm *)`);
        if (/:\*./.test(p.spec)) P("warn", where, key, `"${shownRule}": :* is recognised only at the end of a pattern`);
        if (r.kind === "allow" && /^\S+ \*\s\S/.test(p.spec) && !/^\S+ \*$/.test(p.spec)) P("warn", where, key, `"${shownRule}": a * before the rest of the command (warned at startup for allow rules)`);
      }
      if (r.kind === "allow" && p.tool.includes("*") && !p.tool.startsWith("mcp__")) P("warn", where, key, `"${shownRule}": an unanchored allow glob approves nothing`);
      if (r.kind === "allow") {
        const other = rules.find((x) => x.kind !== "allow" && x.rule === r.rule);
        if (other) P("warn", where, key, `"${shownRule}" is also in ${other.kind} (${other.source}); ${other.kind} wins`);
      }
    }
    // mcp
    const M = mcp(o);
    for (const s of M.servers) {
      if (s.malformed) P("error", s.file, `mcpServers.${s.name}`, s.malformed);
      else if (s.command && s.programFound === false) P("error", s.file, `mcpServers.${s.name}`, `command not found: ${s.command}${s.onPath === null ? " (not on PATH)" : ""}`);
      else if (s.transport === "unknown") P("warn", s.file, `mcpServers.${s.name}`, "no command and no url");
    }
    const pending = M.servers.filter((s) => s.status?.startsWith("pending"));
    if (pending.length) P("info", pending[0].file, "mcpServers", `${pending.length} project server(s) awaiting approval, which do not load until a person approves them: ${pending.map((s) => s.name).join(", ")}`);
    for (const d of M.sameNameInSeveralScopes) P(d.endsWith("(same definition)") ? "info" : "warn", "(mcp)", "mcpServers", `defined in several scopes: ${d}`);
    // plugins
    const PL = plugins(o);
    for (const id of PL.enabledNotInstalled) P("error", "enabledPlugins", id, "enabled but not installed");
    for (const p of PL.plugins) for (const i of p.installs ?? []) if (!i.installPathExists) P("error", "~/.claude/plugins/installed_plugins.json", p.id, `install folder missing: ${i.installPath}`);
    for (const p of PL.plugins) {
      const mk = p.id.split("@")[1];
      if (mk && p.enabled && !PL.marketplaces.some((m) => m.name === mk) && !["inline", "builtin"].includes(mk)) P("warn", "enabledPlugins", p.id, `marketplace ${mk} is not registered`);
    }
    for (const m of PL.marketplaces) if (m.exists === false) P("warn", "~/.claude/plugins/known_marketplaces.json", m.name, "marketplace folder missing");
    for (const m of PL.mods.mods) {
      if (m.targetExists === false) P("error", m.path, "(symlink)", `dangling symlink to ${m.symlinkTo}`);
      for (const x of m.modules ?? []) if (!x.exists) P("error", m.path, "hooks/hooks.json modules", `module file missing: ${x.module}`);
    }
    const idle = PL.mods.mods.filter((m) => m.modules && !m.loaded);
    if (idle.length) P("info", "~/.claude/mods", "CLAUDE_CODE_PLUGIN_DIRS", `${idle.length} mod(s) installed but not named in CLAUDE_CODE_PLUGIN_DIRS, so Claude Code does not load them: ${idle.map((m) => m.name).join(", ")}`);
    for (const d of PL.mods.missingFromDirs) P("error", "settings env", "CLAUDE_CODE_PLUGIN_DIRS", `names a folder that does not exist: ${d}`);
    // settings values
    const merged = mergedOf(L);
    if (typeof merged.statusLine?.command === "string") {
      const t = commandTarget(merged.statusLine.command, null, { HOME: home, CLAUDE_PROJECT_DIR: L.root }, L.root);
      if (t?.script && !t.exists) P("error", "statusLine", "command", `script not found: ${sh(t.script)}`);
      else if (t?.script && t.runsDirectly && !t.executable) P("error", "statusLine", "command", `script not executable: ${sh(t.script)}`);
      else if (t?.program && !t.onPath) P("error", "statusLine", "command", `program not on PATH: ${t.program}`);
    }
    if (merged.permissions?.defaultMode !== undefined && !["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].includes(merged.permissions.defaultMode)) P("error", "permissions", "defaultMode", `unknown mode ${merged.permissions.defaultMode}`);
    if (merged.disableAllHooks === true) P("warn", "settings", "disableAllHooks", "true: user, project, local and plugin hooks are off");
    const order = { error: 0, warn: 1, info: 2 };
    probs.sort((a, b) => order[a.severity] - order[b.severity]);
    const counts = { error: 0, warn: 0, info: 0 };
    for (const p of probs) counts[p.severity]++;
    return { folder: L.folder, counts, problems: probs.slice(0, o.max ?? 80), cut: Math.max(0, probs.length - (o.max ?? 80)), checked: { layers: L.layers.filter((l) => l.exists).length, hooks: hs._rows.length, permissionRules: rules.length, mcpServers: M.servers.length, plugins: PL.plugins.length, mods: PL.mods.mods.length } };
  }

  // ---------- hooks validation ----------

  /**
   * The hooks block of each settings file that applies (user, project, local, and managed when present), or of one `file`,
   * checked one handler at a time. Every problem carries the file and the JSON path. Reads only.
   */
  function validateHooks(o = {}) {
    const L = layers(o);
    let files = L.layers.filter((l) => l.exists || l.scope !== "managed");
    if (o.file) {
      const f = path.resolve(L.folder, String(o.file).replace(/^~(?=\/|$)/, home));
      const base = path.basename(f);
      if (!/\.json$/i.test(base) || /credential|secret|token/i.test(base) || path.resolve(f) === path.join(home, ".claude.json")) fail(`validateHooks reads settings-style .json files only, and not credentials or ~/.claude.json: ${base}`);
      files = [{ scope: "file", ...readJson(f) }];
    }
    const vars = { HOME: home, CLAUDE_PROJECT_DIR: L.root };
    const rel = (p) => (p.startsWith(L.root + "/") ? p.slice(L.root.length + 1) : sh(p));
    const probs = [];
    const summary = [];
    let handlers = 0;
    for (const l of files) {
      const file = l.scope !== "user" ? rel(l.path) : sh(l.path);
      const P = (severity, jpath, problem) => probs.push({ severity, scope: l.scope, file, path: jpath, problem });
      const row = { scope: l.scope, file, state: "", events: 0, handlers: 0 };
      summary.push(row);
      if (!l.exists) {
        row.state = "absent";
        continue;
      }
      if (!l.valid) {
        row.state = "invalid JSON";
        P("error", "(file)", l.error);
        continue;
      }
      if (l.data.disableAllHooks === true) P("warn", "disableAllHooks", "true: user, project, local and plugin hooks are all off while this is set");
      else if (l.data.disableAllHooks !== undefined && typeof l.data.disableAllHooks !== "boolean") P("error", "disableAllHooks", `must be true or false, got ${typeof l.data.disableAllHooks}`);
      if (l.data.hooks === undefined) {
        row.state = "no hooks block";
        continue;
      }
      if (!isObj(l.data.hooks)) {
        row.state = "hooks is not an object";
        P("error", "hooks", `must be an object with event names as keys, got ${Array.isArray(l.data.hooks) ? "an array" : typeof l.data.hooks}`);
        continue;
      }
      for (const [event, groups] of Object.entries(l.data.hooks)) {
        row.events++;
        const ev = `hooks.${maskString(event).slice(0, 60)}`;
        if (!EVENTS.includes(event)) {
          const near = EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
          P("error", ev, `unknown event name${near ? `, did you mean ${near}` : ""} (names are case-sensitive; setup.events lists the valid ones)`);
          continue;
        }
        if (!Array.isArray(groups)) {
          P("error", ev, `must be an array of matcher groups, got ${isObj(groups) ? "an object" : typeof groups}`);
          continue;
        }
        groups.forEach((g, gi) => {
          const gp = `${ev}[${gi}]`;
          if (!isObj(g)) return P("error", gp, "a matcher group must be an object with a hooks array");
          if (g.matcher !== undefined) {
            if (typeof g.matcher !== "string") P("error", `${gp}.matcher`, `must be a string, got ${Array.isArray(g.matcher) ? "an array" : typeof g.matcher}`);
            else if (NO_MATCHER.has(event) && g.matcher !== "") P("warn", `${gp}.matcher`, `${event} takes no matcher: it is ignored and the hook fires on every ${event}`);
            else if (!NO_MATCHER.has(event)) {
              const mt = matcherTest(event, g.matcher, "x");
              if (mt.invalid) P("error", `${gp}.matcher`, mt.invalid);
              else if (TOOL_EVENTS.has(event) && /^mcp__/.test(g.matcher) && /^[A-Za-z0-9_\-\s,|]+$/.test(g.matcher) && !/^mcp__.+__.+/.test(g.matcher)) P("warn", `${gp}.matcher`, "a bare mcp__<server> is an exact name and matches no tool; a whole server needs mcp__<server>__.*");
            }
          }
          if (!Array.isArray(g.hooks)) return P("error", `${gp}.hooks`, `must be an array of handlers, got ${g.hooks === undefined ? "nothing" : isObj(g.hooks) ? "an object" : typeof g.hooks}`);
          g.hooks.forEach((h, hi) => {
            const hp = `${gp}.hooks[${hi}]`;
            handlers++;
            row.handlers++;
            if (!isObj(h)) return P("error", hp, "a handler must be an object");
            if (h.type === undefined) P("error", `${hp}.type`, "missing: every handler needs a type (command, http, mcp_tool, prompt or agent)");
            else if (!HANDLER_TYPES.has(h.type)) P("error", `${hp}.type`, `unknown type ${maskString(JSON.stringify(h.type)).slice(0, 40)}: must be command, http, mcp_tool, prompt or agent`);
            if (h.timeout !== undefined) {
              if (typeof h.timeout !== "number" || !Number.isFinite(h.timeout) || h.timeout <= 0) P("error", `${hp}.timeout`, `must be a positive number of seconds, got ${typeof h.timeout === "number" ? "a number that is not above 0" : typeof h.timeout}`);
              else if (h.timeout >= 1000) P("warn", `${hp}.timeout`, `${h.timeout} seconds is over 16 minutes: timeout is in seconds, not milliseconds`);
            }
            if (h.if !== undefined) {
              if (typeof h.if !== "string") P("error", `${hp}.if`, "must be one permission rule as a string");
              else if (/&&|\|\|/.test(h.if)) P("error", `${hp}.if`, "holds one permission rule: && and || are not supported (use one handler per condition)");
              if (!TOOL_EVENTS.has(event)) P("error", `${hp}.if`, `${event} never evaluates if, so this hook never runs (if works on PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest and PermissionDenied)`);
            }
            if (h.async !== undefined) {
              if (typeof h.async !== "boolean") P("error", `${hp}.async`, "must be true or false");
              else if (h.async && h.type !== undefined && h.type !== "command") P("warn", `${hp}.async`, "async runs command hooks only");
            }
            if (h.once !== undefined) P("info", `${hp}.once`, "once is honoured only for hooks in skill frontmatter; here it is ignored");
            if (h.type === "command") {
              if (typeof h.command !== "string" || !h.command.trim()) return P("error", `${hp}.command`, "a command handler needs a non-empty command string");
              if (h.args !== undefined && !(Array.isArray(h.args) && h.args.every((x) => typeof x === "string"))) return P("error", `${hp}.args`, "must be an array of strings");
              const t = commandTarget(h.command, h.args ?? null, vars, L.root);
              if (t?.script && !t.unresolved) {
                if (!t.exists) P("error", `${hp}.command`, `script not found: ${rel(t.script)}`);
                else if (t.runsDirectly && !t.executable) P("error", `${hp}.command`, `script is not executable: ${rel(t.script)} (chmod +x it, or run it through an interpreter)`);
              } else if (t?.program && !t.onPath) P("error", `${hp}.command`, `program not found on PATH: ${t.program}`);
              else if (t?.interpreter && t.interpreterOnPath === false) P("error", `${hp}.command`, `interpreter not found on PATH: ${t.interpreter}`);
            } else if (h.type === "http") {
              if (typeof h.url !== "string" || !/^https?:\/\//i.test(h.url)) P("error", `${hp}.url`, "an http handler needs a url starting with http:// or https://");
            } else if (h.type === "mcp_tool") {
              for (const k of ["server", "tool"]) if (typeof h[k] !== "string" || !h[k]) P("error", `${hp}.${k}`, `an mcp_tool handler needs a ${k} name`);
            } else if (h.type === "prompt" || h.type === "agent") {
              if (typeof h.prompt !== "string" || !h.prompt.trim()) P("error", `${hp}.prompt`, `a ${h.type} handler needs a prompt string`);
            }
          });
        });
      }
      const mine = probs.filter((p) => p.file === file);
      const bad = mine.filter((p) => p.severity !== "info").length;
      row.state = bad ? `${bad} problem${bad === 1 ? "" : "s"}` : "ok";
    }
    const order = { error: 0, warn: 1, info: 2 };
    probs.sort((a, b) => order[a.severity] - order[b.severity]);
    const counts = { error: 0, warn: 0, info: 0 };
    for (const p of probs) counts[p.severity]++;
    const max = o.max ?? 80;
    return { folder: L.folder, files: summary, handlersChecked: handlers, counts, problems: probs.slice(0, max), cut: Math.max(0, probs.length - max) };
  }

  // ---------- commands for what lives only in ~/.claude.json ----------

  /** The `claude` command to run for something this client does not write (user and local MCP servers, plugin install, marketplaces). Returns text only; nothing runs. */
  function cli(kind, o = {}) {
    const q = (s) => (/^[\w@./:=,+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);
    const scope = o.scope ? ` --scope ${q(o.scope)}` : "";
    switch (kind) {
      case "mcp-add": {
        if (!o.name) fail("mcp-add needs a name");
        const env = Object.keys(o.env ?? {}).map((k) => ` --env ${q(k)}=<VALUE>`).join("");
        const hdr = Object.keys(o.headers ?? {}).map((k) => ` --header ${q(k + ": <VALUE>")}`).join("");
        if (o.url) return { command: `claude mcp add --transport ${o.type === "sse" ? "sse" : "http"}${scope}${hdr} ${q(o.name)} ${q(maskUrl(o.url))}`, note: "Replace <VALUE> with the real value yourself; the value was not echoed." };
        if (!o.command) fail("mcp-add needs a command or a url");
        return { command: `claude mcp add${scope}${env} ${q(o.name)} -- ${[o.command, ...(o.args ?? [])].map(q).join(" ")}`, note: env ? "Replace <VALUE> with the real value yourself; the value was not echoed." : undefined };
      }
      case "mcp-remove": return { command: `claude mcp remove ${q(o.name)}${scope}` };
      case "mcp-add-json": return { command: `claude mcp add-json${scope} ${q(o.name)} '<json>'` };
      case "plugin-install": return { command: `claude plugin install ${q(o.id)}${scope}` };
      case "plugin-uninstall": return { command: `claude plugin uninstall ${q(o.id)}${scope}` };
      case "marketplace-add": return { command: `claude plugin marketplace add ${q(o.source)}` };
      default: fail(`unknown kind ${kind}: mcp-add, mcp-remove, plugin-install, plugin-uninstall, marketplace-add`);
    }
  }

  // ---------- changes (settings files and .mcp.json only) ----------

  const needAct = (what) => {
    if (!act) notInThisAsk(`setup.${what}`);
  };
  function targetFile(scope, o) {
    const L = rootOf(folderOf(o));
    const f = { user: path.join(claudeDir, "settings.json"), project: path.join(L, ".claude", "settings.json"), local: path.join(L, ".claude", "settings.local.json"), mcp: path.join(L, ".mcp.json") }[scope];
    if (!f) fail(`scope must be user, project or local (managed settings need root: edit /etc/claude-code/managed-settings.json yourself)`);
    return f;
  }
  function guardPath(f) {
    const b = path.basename(f);
    if (!(b === "settings.json" || b === "settings.local.json" || b === ".mcp.json")) fail(`refused: only settings.json, settings.local.json and .mcp.json are written (${b})`);
    if (path.resolve(f) === path.join(home, ".claude.json")) fail("refused: ~/.claude.json is rewritten by running sessions; use the claude command instead");
  }
  function backup(file, raw) {
    fs.mkdirSync(state, { recursive: true });
    const id = crypto.createHash("sha1").update(file).digest("hex").slice(0, 6);
    const dest = path.join(state, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}-${path.basename(file)}`);
    fs.writeFileSync(dest, raw, { mode: 0o600 });
    return dest;
  }
  /** Read, change in memory, back up, write atomically, re-read and check the JSON; restore on failure. */
  function editFile(file, fn) {
    guardPath(file);
    const r = readJson(file);
    if (r.exists && !r.valid) fail(`${sh(file)}: ${r.error}; not valid JSON, so it is not edited: fix it by hand first; nothing was changed`);
    const data = r.valid ? structuredClone(r.data) : {};
    const before = JSON.stringify(data);
    const result = fn(data);
    if (JSON.stringify(data) === before) return { changed: false, file: sh(file), ...result };
    const bk = r.valid ? backup(file, r.raw) : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const mode = r.exists ? fs.statSync(file).mode & 0o777 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
    const again = readJson(file);
    if (!again.valid) {
      if (bk) fs.copyFileSync(bk, file);
      else fs.rmSync(file, { force: true });
      fail(`the written file failed the JSON check; the original was put back`);
    }
    push({ kind: "claude-setup", detail: `write ${sh(file)}`, ms: 0 });
    return { changed: true, file: sh(file), backup: bk ? sh(bk) : null, validJson: true, ...result };
  }
  const dig = (data, keyPath, create) => {
    const parts = keyPath.split(".");
    let cur = data;
    for (const p of parts.slice(0, -1)) {
      if (!isObj(cur[p])) {
        if (!create) return [null, null];
        cur[p] = {};
      }
      cur = cur[p];
    }
    return [cur, parts[parts.length - 1]];
  };
  const record = (r) => r;

  /** Add one hook handler. o: scope (user|project|local, default user), event, matcher, type (command|http|prompt|mcp_tool|agent), command|url|prompt, timeout (seconds), if (one permission rule), async. */
  function addHook(o = {}) {
    needAct("addHook");
    const type = o.type ?? "command";
    if (!EVENTS.includes(o.event)) fail(`unknown event ${o.event}; the names are case-sensitive: ${EVENTS.join(", ")}`);
    if (!HANDLER_TYPES.has(type)) fail(`type must be one of ${[...HANDLER_TYPES].join(", ")}`);
    if (o.matcher != null && typeof o.matcher !== "string") fail("matcher must be a string");
    if (o.matcher && NO_MATCHER.has(o.event)) fail(`${o.event} has no matcher: leave it out`);
    if (o.matcher) {
      const mt = matcherTest(o.event, o.matcher, "x");
      if (mt.invalid) fail(`matcher ${mt.invalid}`);
    }
    if (o.if != null && !TOOL_EVENTS.has(o.event)) fail(`if only works on ${[...TOOL_EVENTS].join(", ")}`);
    if (o.if != null && (typeof o.if !== "string" || /&&|\|\|/.test(o.if) || !parseRule(o.if))) fail("if is one permission rule such as Bash(git *)");
    if (o.timeout != null && !(typeof o.timeout === "number" && o.timeout > 0)) fail("timeout is a number of seconds");
    const h = { type };
    if (type === "command") {
      if (!o.command || typeof o.command !== "string") fail("a command hook needs command");
      h.command = o.command;
    } else if (type === "http") {
      if (!o.url) fail("an http hook needs url");
      h.url = o.url;
    } else if (type === "prompt" || type === "agent") {
      if (!o.prompt) fail(`a ${type} hook needs prompt`);
      h.prompt = o.prompt;
    } else {
      if (!o.server || !o.tool) fail("an mcp_tool hook needs server and tool");
      h.server = o.server;
      h.tool = o.tool;
    }
    if (o.timeout != null) h.timeout = o.timeout;
    if (o.if != null) h.if = o.if;
    if (o.async) h.async = true;
    const file = targetFile(o.scope ?? "user", o);
    const warnings = [];
    if (type === "command") {
      const t = commandTarget(o.command, null, { HOME: home, CLAUDE_PROJECT_DIR: rootOf(folderOf(o)) }, rootOf(folderOf(o)));
      if (t?.script && !t.unresolved && !t.exists) warnings.push(`script not found: ${sh(t.script)}`);
      else if (t?.script && t.runsDirectly && !t.executable && !t.unresolved) warnings.push(`script is not executable: ${sh(t.script)}`);
      if (t?.program && !t.onPath) warnings.push(`program not on PATH: ${t.program}`);
    }
    const same = (x) => x.type === h.type && x.command === h.command && x.url === h.url && x.prompt === h.prompt && x.server === h.server && x.tool === h.tool && x.if === h.if;
    return record(editFile(file, (data) => {
      if (data.hooks !== undefined && !isObj(data.hooks)) fail("`hooks` in that file is not an object: fix it by hand");
      data.hooks ??= {};
      if (data.hooks[o.event] !== undefined && !Array.isArray(data.hooks[o.event])) fail(`hooks.${o.event} is not an array: fix it by hand`);
      const groups = (data.hooks[o.event] ??= []);
      const want = o.matcher || undefined;
      let g = groups.find((x) => isObj(x) && (x.matcher || undefined) === want && Array.isArray(x.hooks));
      if (g?.hooks.some(same)) return { action: "already present", event: o.event, matcher: want ?? null };
      if (!g) {
        g = want ? { matcher: want, hooks: [] } : { hooks: [] };
        groups.push(g);
      }
      g.hooks.push(h);
      return { action: "added hook", event: o.event, matcher: want ?? null, handler: maskValue("hook", h), warnings, nextStep: "Test it: setup.testHook({ event, command }) with act, or pipe a sample event to the script yourself. The settings watcher loads the change in running sessions." };
    }));
  }

  /** Remove hook handlers. o: scope, event, and command (exact) or url or contains (a unique substring); matcher narrows. */
  function removeHook(o = {}) {
    needAct("removeHook");
    if (!EVENTS.includes(o.event)) fail(`unknown event ${o.event}`);
    if (!o.command && !o.url && !o.contains) fail("name the hook: command, url or contains");
    const file = targetFile(o.scope ?? "user", o);
    return editFile(file, (data) => {
      const groups = data.hooks?.[o.event];
      if (!Array.isArray(groups)) return { action: "nothing to remove", note: `no ${o.event} hooks in that file` };
      const hit = (x) => (o.command ? x.command === o.command : o.url ? x.url === o.url : String(x.command ?? x.url ?? x.prompt ?? "").includes(o.contains));
      const cands = [];
      for (const g of groups) if (isObj(g) && Array.isArray(g.hooks) && (o.matcher === undefined || (g.matcher || "") === o.matcher)) for (const x of g.hooks) if (isObj(x) && hit(x)) cands.push([g, x]);
      if (!cands.length) return { action: "nothing to remove", note: "no handler matches" };
      if (cands.length > 1 && !o.all) fail(`${cands.length} handlers match: give the exact command or matcher, or all: true`);
      const removed = [];
      for (const [g, x] of cands) {
        g.hooks.splice(g.hooks.indexOf(x), 1);
        removed.push(maskValue("hook", x));
      }
      data.hooks[o.event] = groups.filter((g) => !(isObj(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
      if (!data.hooks[o.event].length) delete data.hooks[o.event];
      if (!Object.keys(data.hooks).length) delete data.hooks;
      return { action: "removed hook", event: o.event, removed };
    });
  }

  const SENSITIVE_PATH = /^(env|mcpServers)\b/;
  /** Set a settings key (a dotted path) to a JSON value: model, env.NAME, statusLine, theme... Hooks and permission rules have their own calls. The value is not echoed for env, headers and secret-looking keys. */
  function set(o = {}) {
    needAct("set");
    if (!o.key || typeof o.key !== "string") fail("set needs a key");
    if (o.key === "hooks" || o.key.startsWith("hooks.")) fail("use addHook and removeHook for hooks");
    if (/^permissions\.(allow|ask|deny)$/.test(o.key)) fail("use addPermission and removePermission for rules");
    if (o.key === "mcpServers" || o.key.startsWith("mcpServers")) fail("settings files hold no MCP servers: use addMcp (.mcp.json) or the claude command");
    if (o.value === undefined) fail("set needs a value");
    const file = targetFile(o.scope ?? "user", o);
    const hide = SENSITIVE_PATH.test(o.key) || SECRET_KEY.test(o.key);
    return editFile(file, (data) => {
      const [parent, last] = dig(data, o.key, true);
      if (!isObj(parent)) fail(`${o.key}: a parent of that path is not an object`);
      const prev = parent[last];
      parent[last] = o.value;
      return { action: prev === undefined ? "set" : "changed", key: o.key, was: prev === undefined ? "(unset)" : hide ? "<set>" : shorten(maskValue(last, prev), 120), now: hide ? "<set>" : shorten(maskValue(last, o.value), 120) };
    });
  }
  /** Remove a settings key (dotted path). */
  function unset(o = {}) {
    needAct("unset");
    if (!o.key) fail("unset needs a key");
    const file = targetFile(o.scope ?? "user", o);
    return editFile(file, (data) => {
      const [parent, last] = dig(data, o.key, false);
      if (!parent || !(last in parent)) return { action: "nothing to remove", key: o.key };
      delete parent[last];
      return { action: "removed key", key: o.key };
    });
  }

  const RULE_OK = (rule, kind) => {
    const p = parseRule(rule);
    if (!p) fail(`${JSON.stringify(rule)} is not in the form Tool or Tool(specifier)`);
    if (p.tool.startsWith("mcp__") && p.spec !== undefined) fail("Claude Code skips an mcp__ rule that has parentheses: name the tool (mcp__server__tool) or the server (mcp__server)");
    if (/^(Bash|PowerShell)$/.test(p.tool) && /^command:/.test(p.spec ?? "")) fail("a command: prefix is ignored: write Bash(rm *)");
    if (kind === "allow" && p.tool.includes("*") && !p.tool.startsWith("mcp__")) fail("an unanchored allow glob approves nothing");
    return p;
  };
  /** Add one permission rule. o: list (allow|ask|deny), rule ("Bash(git status *)"), scope (default local: this project, not committed). */
  function addPermission(o = {}) {
    needAct("addPermission");
    if (!["allow", "ask", "deny"].includes(o.list)) fail("list must be allow, ask or deny");
    const p = RULE_OK(o.rule, o.list);
    const file = targetFile(o.scope ?? "local", o);
    const warnings = [];
    if (o.list === "allow" && (p.spec === undefined && /^(Bash|PowerShell)$/.test(p.tool) || p.spec === "*")) warnings.push("this allows every command of that tool");
    if (o.list === "allow") {
      const d = decide({ ...(/^(Bash|PowerShell)$/.test(p.tool) && p.spec ? { tool: p.tool, command: p.spec.replace(/ ?\*$/, "").replace(/:\*$/, "") } : { tool: p.tool }), folder: o.folder });
      if (d.decision === "deny" || d.decision === "ask") warnings.push(`an existing ${d.decision} rule (${d.rule}, ${d.source}) takes precedence over this allow`);
    }
    return editFile(file, (data) => {
      if (data.permissions !== undefined && !isObj(data.permissions)) fail("`permissions` is not an object: fix it by hand");
      data.permissions ??= {};
      if (data.permissions[o.list] !== undefined && !Array.isArray(data.permissions[o.list])) fail(`permissions.${o.list} is not an array: fix it by hand`);
      const list = (data.permissions[o.list] ??= []);
      if (list.includes(o.rule)) return { action: "already present", list: o.list, rule: maskString(o.rule) };
      list.push(o.rule);
      return { action: "added rule", list: o.list, rule: maskString(o.rule), warnings };
    });
  }
  /** Remove one permission rule (exact text) from a list. */
  function removePermission(o = {}) {
    needAct("removePermission");
    const file = targetFile(o.scope ?? "local", o);
    return editFile(file, (data) => {
      const lists = o.list ? [o.list] : ["allow", "ask", "deny"];
      const gone = [];
      for (const l of lists) {
        const a = data.permissions?.[l];
        if (Array.isArray(a) && a.includes(o.rule)) {
          data.permissions[l] = a.filter((x) => x !== o.rule);
          gone.push(l);
        }
      }
      return gone.length ? { action: "removed rule", rule: maskString(String(o.rule)), from: gone } : { action: "nothing to remove", rule: maskString(String(o.rule)) };
    });
  }

  /** Add an MCP server. scope project writes .mcp.json. Scopes user and local live in ~/.claude.json, which this client never writes: it returns the `claude mcp add` command to run. env and headers values go into the file but are never echoed. */
  function addMcp(o = {}) {
    needAct("addMcp");
    if (!o.name || /[^\w.-]/.test(o.name)) fail("name: letters, digits, _, - and .");
    const scope = o.scope ?? "project";
    if (scope !== "project") return { changed: false, needsCli: true, why: `${scope}-scope servers live in ~/.claude.json, which running sessions rewrite: it is not edited here`, ...cli("mcp-add", { ...o, scope }) };
    const def = o.url ? { type: o.type === "sse" ? "sse" : "http", url: o.url, ...(o.headers ? { headers: o.headers } : {}) } : { type: "stdio", command: o.command, ...(o.args?.length ? { args: o.args.map(String) } : {}), ...(o.env ? { env: o.env } : {}) };
    if (!o.url && !o.command) fail("a server needs command or url");
    const file = targetFile("mcp", o);
    const warnings = [];
    if (o.command && !which(o.command.includes("/") ? o.command : o.command)) warnings.push(`command not found on PATH: ${o.command}`);
    return editFile(file, (data) => {
      data.mcpServers ??= {};
      if (data.mcpServers[o.name]) fail(`a server named ${o.name} is already in .mcp.json: removeMcp it first`);
      data.mcpServers[o.name] = def;
      return { action: "added server", name: o.name, transport: def.type, command: def.command ? maskString(def.command) : undefined, url: def.url ? maskUrl(def.url) : undefined, envKeys: o.env ? Object.keys(o.env) : undefined, warnings, nextStep: "A person approves a new project server in an interactive session (enabledMcpjsonServers or enableAllProjectMcpServers also approve it)." };
    });
  }
  /** Remove an MCP server from .mcp.json (project scope), or return the `claude mcp remove` command for user and local scope. */
  function removeMcp(o = {}) {
    needAct("removeMcp");
    const scope = o.scope ?? "project";
    if (scope !== "project") return { changed: false, needsCli: true, ...cli("mcp-remove", { ...o, scope }) };
    return editFile(targetFile("mcp", o), (data) => {
      if (!isObj(data.mcpServers) || !(o.name in data.mcpServers)) return { action: "nothing to remove", name: o.name };
      delete data.mcpServers[o.name];
      return { action: "removed server", name: o.name };
    });
  }
  /** Turn a plugin on or off in a settings file (enabledPlugins). Installing needs `claude plugin install`, which cli("plugin-install", {id}) returns. */
  function setPlugin(o = {}) {
    needAct("setPlugin");
    if (!/^[^@\s]+@[^@\s]+$/.test(o.id ?? "")) fail("id is name@marketplace");
    const file = targetFile(o.scope ?? "user", o);
    return editFile(file, (data) => {
      if (data.enabledPlugins !== undefined && !isObj(data.enabledPlugins)) fail("`enabledPlugins` is not an object");
      data.enabledPlugins ??= {};
      data.enabledPlugins[o.id] = o.enabled !== false;
      return { action: o.enabled === false ? "disabled plugin" : "enabled plugin", id: o.id, note: "An installed plugin only; for one that is not installed run: " + cli("plugin-install", { id: o.id }).command };
    });
  }

  const SAMPLE = {
    PreToolUse: (o) => ({ tool_name: o.tool ?? "Bash", tool_input: o.input ?? { command: o.command_input ?? "echo hello" }, tool_use_id: "toolu_test" }),
    PostToolUse: (o) => ({ tool_name: o.tool ?? "Bash", tool_input: o.input ?? { command: "echo hello" }, tool_response: { output: "hello" }, tool_use_id: "toolu_test" }),
    UserPromptSubmit: (o) => ({ prompt: o.prompt ?? "hello" }),
    SessionStart: (o) => ({ source: o.tool ?? "startup" }),
    Notification: (o) => ({ message: "test", notification_type: o.tool ?? "idle_prompt" }),
    Stop: () => ({ stop_hook_active: false }),
  };
  /** Run one hook command with a sample event on stdin and report exit code, output and how Claude Code reads it. o: event, command (+args), tool, input, fields (extra stdin fields for any event, such as stop_hook_active, tool_name, error, agent_type), timeout. No shell: a command with pipes or redirects is refused. */
  function testHook(o = {}) {
    needAct("testHook");
    if (!EVENTS.includes(o.event)) fail(`unknown event ${o.event}`);
    if (!o.command) fail("testHook needs the command to run");
    if (hasShellOps(String(o.command))) fail("the command uses a shell operator (pipe, redirect, &&, $()): test the script by its path instead");
    const root = rootOf(folderOf(o));
    const vars = { HOME: home, CLAUDE_PROJECT_DIR: root };
    const toks = tokenize(String(o.command)).map((t) => expandVars(t, vars));
    const argv = [...toks, ...(o.args ?? []).map(String)];
    while (argv.length && /^[A-Za-z_]\w*=/.test(argv[0])) argv.shift();
    const prog = argv.shift();
    if (!prog) fail("empty command");
    const input = { session_id: "claude-setup-test", transcript_path: path.join(os.tmpdir(), "none.jsonl"), cwd: root, permission_mode: "default", hook_event_name: o.event, ...(SAMPLE[o.event]?.(o) ?? {}), ...(isObj(o.fields) ? o.fields : {}) };
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = execFile(prog, argv, { cwd: root, timeout: Math.min((o.timeout ?? 10), 30) * 1000, maxBuffer: 1 << 20, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_SESSION_ID: input.session_id } }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1) : 0;
        const out = String(stdout ?? "");
        let decision = null;
        try {
          const j = JSON.parse(out);
          decision = j.hookSpecificOutput?.permissionDecision ?? j.decision ?? (j.continue === false ? "stop" : null);
        } catch {}
        resolve({ event: o.event, sampleInput: maskValue("input", input), exitCode: code, timedOut: !!err?.killed, ms: Date.now() - t0, stdout: maskString(out).slice(0, 1500), stderr: maskString(String(stderr ?? "")).slice(0, 1000), decision, reading: code === 2 ? "exit 2: blocks, stderr goes to Claude" : code === 0 ? (decision ? `exit 0 with decision ${decision}` : "exit 0: allowed to proceed; stdout JSON is read, other stdout is context for some events") : "non-zero other than 2: a non-blocking error, shown to the user", ...(err?.code === "ENOENT" ? { error: `program not found: ${prog}` } : {}) });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }

  return {
    cwd,
    act,
    home,
    events: EVENTS,
    layers: (o) => {
      const L = layers(o);
      return { folder: L.folder, project: L.root, layers: L.layers.map(layerSummary) };
    },
    settings,
    hooks: (o) => {
      const { _rows, ...r } = hooks(o);
      return r;
    },
    wouldFire,
    permissions,
    decide,
    mcp,
    plugins,
    mods: (o) => mods(o),
    check,
    validateHooks,
    cli,
    matcherTest,
    ruleMatches: (rule, call, kind = "allow") => ruleMatches(rule, call, kind, { home, cwd, ruleRoot: cwd }),
    addHook,
    removeHook,
    set,
    unset,
    addPermission,
    removePermission,
    addMcp,
    removeMcp,
    setPlugin,
    testHook,
  };
}
