export const meta = {
  purpose:
    "Which plugins and marketplaces are installed and enabled for a folder, and which mods exist. Marketplaces with source and last update; each plugin with version, install scope, whether it is enabled and in which settings file, and what it contributes (skills, agents, commands, hooks, MCP servers); plugins enabled but not installed; mods under ~/.claude/mods and whether CLAUDE_CODE_PLUGIN_DIRS loads each.",
  params: { folder: "optional (default: the caller's folder)", plugin: "optional: only plugins whose id contains this" },
  returns: "{marketplaces:[...], plugins:['<id> <version> <scopes>; enabled <true|false> (<file>); contributes ...'], enabledNotInstalled, installedNotEnabled, mods:[...], notes}",
  example: 'await scripts.run("plugins", { plugin: "ask-kit" })',
};

export default async function plugins({ setup }, { folder, plugin } = {}) {
  const r = await setup.plugins({ folder });
  const list = plugin ? r.plugins.filter((p) => p.id.includes(plugin)) : r.plugins;
  const c = (x) => (x ? Object.entries(x).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : v}${Array.isArray(v) && v.length && v.length <= 6 ? ` (${v.join(", ")})` : ""}`).join(", ") || "nothing" : "");
  return {
    folder: r.folder,
    marketplaces: r.marketplaces.map((m) => `${m.name}: ${m.source ?? "?"}${m.declaredInSettings ? `; declared in ${m.declaredInSettings} settings` : ""}${m.exists === false ? "; FOLDER MISSING" : ""}${m.lastUpdated ? `; updated ${m.lastUpdated}` : ""}`),
    plugins: list.map((p) => (p.kind ? `${p.id}: enabled ${p.enabled} (${p.enabledIn})` : `${p.id} ${p.installs.map((i) => `${i.version ?? "?"} ${i.scope}${i.projectPath ? ` for ${i.projectPath}` : ""}${i.installPathExists ? "" : " INSTALL FOLDER MISSING"}`).join(" | ") || "not installed here"}; enabled ${p.enabled}${p.enabledIn ? ` (${p.enabledIn})` : ""}${p.installedForOtherProjects ? `; also installed for ${p.installedForOtherProjects} other project(s)` : ""}; contributes ${c(p.contributes) || "(not installed here)"}`)),
    enabledNotInstalled: r.enabledNotInstalled,
    installedNotEnabled: r.installedNotEnabled,
    mods: { folder: r.mods.folder, loadedBy: r.mods.loadedBy, list: r.mods.mods.map((m) => `${m.name}${m.symlinkTo ? ` -> ${m.symlinkTo}` : ""}: ${m.version ? `v${m.version}; ` : ""}${m.loaded ? "LOADED" : "not loaded"}${m.modules ? `; modules ${m.modules.map((x) => x.module + (x.exists ? "" : " MISSING")).join(", ")}` : ""}${m.note ? `; ${m.note}` : ""}${m.targetExists === false ? "; DANGLING LINK" : ""}`) },
    notes: [...r.notes, "~/.claude/mods is not a folder Claude Code scans; a mod loads through CLAUDE_CODE_PLUGIN_DIRS, --plugin-dir or as an installed plugin."],
  };
}
