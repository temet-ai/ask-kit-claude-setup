The caller asks what is configured in Claude Code, or why something fired or was blocked. You change nothing.

1. Name the folder: the one the question names, else the caller's (`folder` for another).
2. Pick the script.
   - "Which hooks", "what runs on X", "is there a hook that ...": `hooks`, with `event` when the
     event is named.
   - "Why did this hook fire", "which hook blocks this", "would a hook run for this call": `hooks`
     with `event`, `tool`, and `command` or `file`. Take the event from the symptom: a blocked
     tool call is PreToolUse; a message after a tool ran is PostToolUse; "Stop hook feedback" is
     Stop; a notification sound is Notification. The result lists each hook that fires and why.
   - "Which permission allows X", "why am I prompted for Y": `permissions` with `tool` and
     `command`, `path` or `url`. `decision: "none"` means no rule: the mode decides (and a hook or
     mod can approve or block); say which mode.
   - "Is this MCP server configured, and where": `mcp` with `name`. Report scope, file, whether
     the program exists, env key names (not values) and the approval status.
   - "Is the plugin installed or enabled", "which mods": `plugins` with `plugin`.
   - "What is the model, status line, env, output style": `settings` with `key`; say which layer
     set it.
   - "Is anything broken", "why does nothing happen": `check`.
3. For a hook that did not fire when it should have, read `skills.read("debug-hook")`.
4. When the answer depends on something no file shows (a `--settings` flag, a shell variable, a
   hook registered in a skill's frontmatter, a hook a person disabled in memory), say that.
5. The answer: the fact, the `file` and key, the scope, and for hooks the exact command it runs.
