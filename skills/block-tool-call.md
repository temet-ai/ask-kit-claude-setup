Stop Claude Code from writing to chosen files or running chosen commands: a PreToolUse hook that denies the call

1. Run `scripts.run("hooks", { event: "PreToolUse" })` first. If a hook already guards the same tool,
   change its script instead of adding a second handler.
2. A deny rule is the stronger tool. `setup.addPermission({ list: "deny", rule: "Edit(./.env)" })`
   blocks the call with no script, and a hook `allow` can never override it. Use a hook only when the
   decision needs logic a rule cannot hold (a directory list, the content of the call, a time of day).
3. Matcher and timeout for a file guard: event `PreToolUse`, matcher `Edit|Write`, timeout 5. For a
   command guard: matcher `Bash`, and an `if` such as `Bash(git push *)` so the script starts only for
   the commands it cares about. `if` takes one permission rule; a second condition is a second handler.
4. The script receives one JSON object on stdin:
   `{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":".env","old_string":"a","new_string":"b"},"session_id":"s1"}`
   (`tool_input.command` for Bash). To deny, it prints exactly this on stdout and exits 0:
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Protected file: .env"}}`
   To allow it prints nothing. `permissionDecision` is `allow`, `deny`, `ask` or `defer`. The reason
   is shown to Claude, so say what to do instead. Exit 2 with a message on stderr also blocks, and
   then the JSON is ignored: pick one way per script.
5. Script text for the caller to save as `.claude/hooks/protect-files.mjs` (any language works; Node
   is already installed with ask-kit):

   ```js
   import fs from "node:fs";
   import path from "node:path";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   const file = input.tool_input?.file_path ?? "";
   const names = new Set([".env", ".env.local", "secrets.json", "credentials.json"]);
   const dirs = ["node_modules/", ".git/", "dist/"];
   const why = names.has(path.basename(file)) ? `Protected file: ${path.basename(file)}` : dirs.find((d) => file.includes(d)) ? `Protected directory: ${dirs.find((d) => file.includes(d))}` : null;
   if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }));
   ```

6. Add it: `await setup.addHook({ scope: "project", event: "PreToolUse", matcher: "Edit|Write", command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-files.mjs", timeout: 5 })`.
   Run it by path with a sample call:
   `await setup.testHook({ event: "PreToolUse", command: "node", args: [".claude/hooks/protect-files.mjs"], tool: "Edit", input: { file_path: ".env" } })`.
   Read `decision` in the result: it should be `deny`. Test a harmless path too: it should print nothing.
7. Facts for the answer. Several hooks on one call run in parallel, and the most restrictive decision
   wins: deny, then defer, then ask, then allow. A deny from a hook wins even under
   bypassPermissions. One hook denying does not stop the others from running. `defer` works only in
   `-p` mode. If a hook cannot parse its input it should print nothing and exit 0, so a broken guard
   fails open; say so, and say that a deny rule is the guard that cannot fail open.
8. Finish with `scripts.run("validate-hooks")` and report the file, the key and the test result.
