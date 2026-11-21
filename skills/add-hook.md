Add a Claude Code hook: choose the event, write the matcher, put the script in the right place, test it

1. Choose the event. Blocking a tool call before it runs: `PreToolUse`. Reacting after a tool ran:
   `PostToolUse`. Checking a prompt before Claude sees it: `UserPromptSubmit`. Refusing to let
   Claude stop: `Stop` (check `stop_hook_active` in the input, or it loops). Setting up a session:
   `SessionStart` (matcher `startup|resume|clear|compact`). Alerts and sounds: `Notification`.
   Cleaning up: `SessionEnd`. The full list is `setup.events`; names are case-sensitive.
2. Write the matcher, a string. For tool events it filters on the tool name: `Bash`,
   `Edit|Write`, `mcp__server__.*` (a plugin's server is `mcp__plugin_<plugin>_<server>__.*`).
   Letters, digits, `_`, `-`, `,` and `|` only means an exact name or list; any other character
   makes it an unanchored regex. Events without a matcher (Stop, UserPromptSubmit, PostToolBatch,
   CwdChanged, TaskCreated, TaskCompleted, TeammateIdle, WorktreeCreate, WorktreeRemove,
   MessageDisplay) take none: `addHook` refuses one. Check a matcher with
   `setup.matcherTest(event, matcher, target)`.
3. To narrow by what the call does, use `if` (one permission rule such as `Bash(git commit *)` or
   `Edit(*.ts)`) on PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest or
   PermissionDenied. One rule only: use a second handler for a second condition. It is
   best-effort, not a security boundary; a real block needs a deny permission rule.
4. Where the script goes. Personal and machine-wide: `~/.claude/hooks/<name>.sh`, scope `user`.
   For one repository: `.claude/hooks/<name>.sh` and a command that uses
   `"$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.sh`, scope `project` (committed) or `local`.
   You cannot create the script file in this REPL; the caller writes it. A script run directly
   must be executable (`chmod +x`); one run as `bash script.sh` need not be. Use an absolute path
   or `$CLAUDE_PROJECT_DIR`; a bare name is looked up on PATH.
5. What the script does. It reads one JSON event on stdin (`session_id`, `cwd`, `hook_event_name`,
   and for tool events `tool_name` and `tool_input`). Exit 0: proceed, and JSON on stdout is read.
   Exit 2: block where the event can block (PreToolUse, UserPromptSubmit, Stop, ...), stderr goes
   to Claude. Any other code: a non-blocking error shown to the person. A PreToolUse decision is
   `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"..."}}`. Print
   nothing else to stdout (a noisy shell profile breaks JSON parsing). `timeout` is in seconds.
6. Add it: `await setup.addHook({ scope, event, matcher, command, timeout })`. Read the result:
   `warnings` names a missing or non-executable script; `action: "already present"` means it
   existed.
7. Test it. `await setup.testHook({ event, command, tool, input, fields })` runs the command with a
   sample event (`input` is the tool_input, `fields` adds any other stdin field) and returns exit
   code, output and how Claude Code reads it. It refuses a command
   with a pipe or redirect: test the script by path. Then `scripts.run("hooks", { event, tool,
   command })` shows it among the hooks that would fire.
8. Run `scripts.run("validate-hooks")` for the hooks block and `scripts.run("check")` for the rest.
   Settings changes load in running sessions through the file watcher; a hook in a project folder a
   person has not trusted does not run until they accept the prompt.

Worked hooks for common jobs: `skills.read("block-tool-call")` (deny a write or a command),
`skills.read("auto-approve-permission")`, `skills.read("gate-stop")` (Stop, SubagentStop,
TaskCompleted), `skills.read("inject-context")` (SessionStart, CLAUDE_ENV_FILE, PostToolUse hints),
`skills.read("failure-hints")`, `skills.read("check-after-edit")`, `skills.read("log-prompts")` and
`skills.read("one-script-many-events")`. Each gives the event, matcher, stdin JSON, stdout JSON and a
script to save.
