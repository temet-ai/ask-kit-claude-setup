Turn "from now on when X, do Y" into a hook, because a note or a memory does not make anything happen

A standing instruction in a CLAUDE.md or memory is read by the model; nothing runs it. Behaviour
that must happen every time (run a formatter after an edit, refuse a command, notify when done,
add context at session start) is run by Claude Code itself, through a hook. Use this table.

1. "Before / when Claude runs <tool> ..., stop it": `PreToolUse`, matcher the tool, an `if` for the
   command pattern, a script that exits 2 or prints a deny decision.
2. "After Claude edits <files>, run <command>": `PostToolUse`, matcher `Edit|Write`, an `if` such
   as `Edit(*.ts)`.
3. "When Claude finishes / is waiting for me": `Notification` (matcher `idle_prompt`,
   `permission_prompt`) or `Stop`.
4. "At the start of every session, tell Claude ...": `SessionStart`, matcher `startup|resume|clear|compact`,
   a script that prints the context as `additionalContext` JSON.
5. "Never allow X" or "always allow X": not a hook, a permission rule (`skills.read("add-permission")`).
   A hook allow cannot override a settings deny.
6. "Set the model, theme, env variable, status line": not a hook, a setting: `setup.set`.
7. "Remember that ...": a memory or rule, which is the `rules` kit.
8. For a hook, continue with `skills.read("add-hook")`. Ask which scope when the request does not
   say: this repository (`local` or `project`) or every repository (`user`).
