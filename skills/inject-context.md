Give Claude context or environment variables at the right moment: SessionStart and PostToolUse hooks that return additionalContext or write CLAUDE_ENV_FILE

1. Choose the event by when the text should arrive. At the start of a session, or again after
   compaction: `SessionStart`, matcher `startup`, `resume`, `clear` or `compact` (a list such as
   `startup|compact` works). Right after an edit: `PostToolUse` with matcher `Edit|Write`. Alongside a
   prompt: `UserPromptSubmit`, which takes no matcher.
2. The output shape is the same for all of them. Stdout is exactly
   `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"POST-COMPACTION REMINDERS:\n..."}}`
   with `hookEventName` set to the event that ran the hook. The text reaches Claude as a system
   reminder, and every hook that returns it contributes. It is cut at 10,000 characters. Plain text on
   stdout also works for SessionStart and UserPromptSubmit. A Setup hook's context is discarded.
3. Re-inject reminders after compaction. Stdin:
   `{"hook_event_name":"SessionStart","session_id":"s1","cwd":"/repo","source":"compact","transcript_path":"/t.jsonl"}`.
   Script for the caller to save as `.claude/hooks/compact-recovery.mjs`; it looks for
   `.claude/post-compact-reminders.md` in the cwd and two folders above:

   ```js
   import fs from "node:fs";
   import path from "node:path";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   let dir = input.cwd || "";
   for (let i = 0; dir && i < 3; i++, dir = path.dirname(dir)) {
     const file = path.join(dir, ".claude", "post-compact-reminders.md");
     if (!fs.existsSync(file)) continue;
     const text = fs.readFileSync(file, "utf8").trim();
     if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `POST-COMPACTION REMINDERS:\n${text}` } }));
     break;
   }
   ```

   Add with `setup.addHook({ scope: "project", event: "SessionStart", matcher: "compact", command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/compact-recovery.mjs", timeout: 5 })`.
4. Load environment variables into every later Bash call. `CLAUDE_ENV_FILE` is set for SessionStart,
   Setup, CwdChanged and FileChanged hooks only. The hook appends `export NAME='value'` lines to that
   file; append, so other hooks' lines survive. Always single-quote the value and escape each `'` as
   `'\''`: a double-quoted `#` or `!` is mangled by the shell. Skip any token or key variable the
   caller names. Script `.claude/hooks/env-loader.mjs`:

   ```js
   import fs from "node:fs";
   import path from "node:path";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   const target = process.env.CLAUDE_ENV_FILE;
   if (!target || !input.cwd) process.exit(0);
   let dir = input.cwd, found = null;
   for (let i = 0; i < 3 && !found; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, ".env"))) found = path.join(dir, ".env");
   if (!found) process.exit(0);
   const skip = ["CLAUDE_CODE_OAUTH_TOKEN="];
   const lines = [];
   for (const raw of fs.readFileSync(found, "utf8").split("\n")) {
     const line = raw.trim();
     if (!line || line.startsWith("#") || skip.some((p) => line.startsWith(p))) continue;
     const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
     if (!m) continue;
     let v = m[2];
     if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
     lines.push(`export ${m[1]}='${v.replaceAll("'", "'\\''")}'`);
   }
   if (lines.length) fs.appendFileSync(target, lines.join("\n") + "\n");
   process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Loaded ${lines.length} env vars from .env` } }));
   ```

   Matcher `startup`. Say in the answer that the script reads a `.env` file, so the variable values
   pass through it; its output names the count only.
5. Hint once per file type after an edit (PostToolUse). Stdin:
   `{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/src/A.java"},"session_id":"s1"}`.
   Keep a marker per session and file type in the temp folder, print the hint the first time only,
   and print nothing after. Stdout when it fires:
   `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Java file detected. Follow the layering in docs/architecture.md."}}`.
   A hook that only advises must never fail an edit: wrap the body in `try`, exit 0 on any error.
6. Test: `setup.testHook({ event: "SessionStart", tool: "compact", command: "node", args: [path] })`
   (`tool` becomes `source`), or for PostToolUse `{ event: "PostToolUse", tool: "Edit", input: { file_path: "/repo/src/A.java" }, command: "node", args: [path] }`.
   Read `stdout`: it must be one JSON object and nothing else. Banners from a shell profile break
   the parse.
