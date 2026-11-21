export const meta = {
  purpose:
    "The settings in force for a folder after the layers merge (managed, local, project, user), with the layer that set each key and which lower layers it overrides. Env values, tokens and URL credentials are masked: env shows names only. Use it for model, effort, output style, status line, permissions mode, enabled plugins, env variable names and any other key.",
  params: { folder: "optional (default: the caller's folder)", key: "optional: a key or dotted prefix to narrow to (model, env, permissions, statusLine, enabledPlugins)", max: "rows, default 120" },
  returns: "{layers:['<scope> <file> (keys N)'], effective:['<key> = <value>  [<scope>; also set in ...]'], notes}",
  example: 'await scripts.run("settings", { key: "model" })',
};

export default async function settings({ setup }, { folder, key, max } = {}) {
  const r = await setup.settings({ folder, key, max });
  return {
    folder: r.folder,
    layers: r.layers.map((l) => `${l.scope} ${l.path}${l.exists ? (l.valid ? ` (${l.keys} keys)` : ` INVALID: ${l.error}`) : " (absent)"}`),
    total: r.total,
    cut: r.cut,
    effective: r.effective.map((e) => `${e.key} = ${typeof e.value === "string" ? e.value : JSON.stringify(e.value)}  [${e.from}${e.alsoSetIn ? `; also set in ${e.alsoSetIn.join(", ")}, overridden` : ""}]`),
    notes: r.notes,
  };
}
