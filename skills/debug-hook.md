Find out why a hook did not fire, fired when it should not have, or blocks the wrong thing

1. Get the event and the call. A tool call blocked or annotated: PreToolUse or PostToolUse with
   the tool name and, for Bash, the command. A message "Stop hook feedback": Stop.
2. `scripts.run("hooks", { event, tool, command })`. Read each entry's `why`.
3. A hook is missing from the list or says `no`. Work through, in this order:
   - the event name has the wrong case (check against `setup.events`; the `check` script flags
     unknown names);
   - the matcher: `setup.matcherTest(event, matcher, tool)`. An exact-name matcher such as
     `mcp__memory` matches nothing: a whole server needs `mcp__memory__.*`. A plugin's server tools
     carry `mcp__plugin_<plugin>_<server>__`. A hyphenated name matched as a regex on older versions;
   - an `if` on an event that never evaluates it (the hook never runs), or an `if` the call does
     not match;
   - the event has no matcher, so the one written is ignored (the hook fires on everything);
   - `disableAllHooks: true` in some file turns off user, project, local and plugin hooks;
   - the hook is in a project's settings and the folder was never trusted;
   - the file it is in is invalid JSON (`check`), so none of it loaded;
   - the plugin that provides it is not enabled (`plugins`).
4. A hook fires but does nothing or errors. `scripts.run("hooks", { event })` shows whether its
   script exists and may run (`SCRIPT MISSING`, `NOT EXECUTABLE`, `PROGRAM NOT ON PATH`). With act,
   `setup.testHook({ event, command })` runs it with a sample event: exit 0 proceed, 2 block, other
   non-blocking. Output that is not clean JSON on stdout (a banner from a shell profile) is a
   common cause. `timeout` is in seconds; the defaults are long for command hooks and 1.5 s for
   SessionEnd unless raised.
5. A hook blocks the wrong call. Read its command and script (`hooks` gives the path; read the
   script with the code tools or ask the caller). A PreToolUse deny wins even under
   bypassPermissions, and a hook allow never overrides a settings deny rule.
6. Several hooks fire together: those in one group run in parallel, and groups from every file and
   plugin all run. There is no way to switch off one hook while keeping it configured: remove it
   (`setup.removeHook`) or turn off the plugin that supplies it.
7. The answer: which hook is responsible (event, matcher, command, `file`), the reason, and the
   change that fixes it, if one was asked for.
