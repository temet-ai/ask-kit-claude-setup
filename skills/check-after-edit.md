Run a check after Claude edits a file and hand failures back to Claude: a PostToolUse hook

1. Event `PostToolUse`, matcher `Edit|Write` (add `MultiEdit` if the tool list has it). Narrow with
   `if` when the check belongs to one file type: `Edit(*.java)` or `Write(*.java)`; one rule per
   handler, so use two handlers for two tools.
2. The tool has already run, so the hook cannot undo it. It reports. Exit code 2 sends stderr to
   Claude and prevents nothing; exit 0 is silent. Alternatively print
   `{"decision":"block","reason":"..."}`, which puts the reason next to the tool result, or
   `additionalContext` for advice. Claude still sees the original tool output in each case.
3. Stdin: `{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/src/A.java"},"session_id":"s1"}`.
   Read `tool_input.file_path`; exit 0 at once when it is missing or not the file type of interest.
4. Run the project's quick check from `CLAUDE_PROJECT_DIR` with a timeout, compile or lint only
   and never the full test suite. Script `.claude/hooks/check-edit.mjs`, here for Java with Gradle:

   ```js
   import fs from "node:fs";
   import { spawnSync } from "node:child_process";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   const file = input.tool_input?.file_path ?? "";
   if (!file.endsWith(".java")) process.exit(0);
   const r = spawnSync("./gradlew", ["compileJava", "-q"], { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), encoding: "utf8", timeout: 25000 });
   if (r.status === 0) process.exit(0);
   process.stderr.write("COMPILE FAILED, fix before continuing\n" + `${r.stdout}${r.stderr}`.trim().split("\n").slice(-5).join("\n") + "\n");
   process.exit(2);
   ```

   Ask the caller for the real command and file type; do not guess the build tool. Look at the
   repository (`code` kit, or the folder) for `gradlew`, `package.json`, `pyproject.toml`.
5. Add it: `setup.addHook({ scope: "project", event: "PostToolUse", matcher: "Edit|Write", command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check-edit.mjs", timeout: 30 })`.
   The timeout must exceed the check; a hook that times out is cancelled and its output dropped.
6. Test with `setup.testHook({ event: "PostToolUse", tool: "Edit", input: { file_path: "/repo/src/A.java" }, command: "node", args: [path] })`:
   exit 0 for a clean tree, exit 2 with the compiler's last lines on `stderr` for a broken one.
