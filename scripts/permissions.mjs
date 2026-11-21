export const meta = {
  purpose:
    "Which permission rules apply in a folder: the deny, ask and allow rules with the settings file each comes from (user, project, local, ~/.claude.json), the default mode, and extra directories. With a tool call it names the rule that decides it: deny first, then ask, then allow, each compound Bash command checked part by part, or 'no rule' with the mode that then decides.",
  params: {
    folder: "optional (default: the caller's folder)",
    tool: "optional: a tool name (Bash, Read, Edit, Write, WebFetch, mcp__server__tool); turns on the 'which rule decides' answer",
    command: "for Bash: the full command, e.g. 'git push origin main'",
    path: "for Read, Edit, Write, Glob, Grep: the file path",
    url: "for WebFetch: the URL (or domain: the host)",
    max: "rules listed per list, default 60",
  },
  returns: "list: {defaultMode, counts:{deny,ask,allow}, rules:{deny,ask,allow:['<rule>  <- <file>']}, notes}; decision: {tool, decision:'deny'|'ask'|'allow'|'none', rule, source, parts?, mode, notes}",
  example: 'await scripts.run("permissions", { tool: "Bash", command: "git push origin main" })',
};

export default async function permissions({ setup }, p = {}) {
  return setup.permissions(p);
}
