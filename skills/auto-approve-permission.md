Answer permission prompts automatically for a narrow set of tools with a PermissionRequest hook

1. Read the existing rules first (`scripts.run("permissions")`). A plain `allow` rule such as
   `Read(./docs/**)` does the same job with no script. A hook is for a decision that needs logic.
2. Narrow the matcher. The matcher is the tool name: `Read|Glob|Grep|WebFetch|WebSearch`. An empty
   matcher or `*` would approve every tool that asks, destructive ones included; refuse to write one.
3. The event fires only in interactive sessions. Under `-p` and other non-interactive runs the hook
   never runs, so say that the setting has no effect there.
4. Stdin: `{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/repo/a.md"},"session_id":"s1","transcript_path":"/t.jsonl","cwd":"/repo","permission_mode":"default"}`.
   To approve, stdout is exactly:
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   To refuse: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Why","interrupt":false}}}`.
   `allow` may also carry `updatedInput` and `updatedPermissions`. This event nests `decision` inside
   `hookSpecificOutput`, which PreToolUse does not: copying a PreToolUse answer here does nothing.
   Exit code 2 is not honoured for this event, so deny through the JSON.
5. Script for the caller to save as `.claude/hooks/auto-approve.mjs`:

   ```js
   import fs from "node:fs";
   fs.readFileSync(0, "utf8");
   process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
   ```

   It reads stdin even though it ignores it, so the sender never blocks on a full pipe.
6. Add it: `await setup.addHook({ scope: "user", event: "PermissionRequest", matcher: "Read|Glob|Grep|WebFetch|WebSearch", command: "node ~/.claude/hooks/auto-approve.mjs", timeout: 5 })`.
   Test with `setup.testHook({ event: "PermissionRequest", command: "node", args: [path], fields: { tool_name: "Read", tool_input: { file_path: "a.md" } } })`
   and read `stdout`.
7. A hook allow skips the prompt only. A deny or ask rule in any settings file, managed ones
   included, still applies and wins.
