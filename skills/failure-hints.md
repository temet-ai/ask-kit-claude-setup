Coach Claude after a failed tool call and warn it before it repeats the same failing command: PostToolUseFailure and PreToolUse hooks that share a failure log

1. The two hooks are a pair. The failure hook runs after a tool call fails, matches the error text
   against guidance, and logs each failed Bash command; the PreToolUse hook reads that log before the
   next Bash call and warns or stops the retry. Install both or neither.
2. Failure hook. Event `PostToolUseFailure`, matcher `Bash|Edit` (the matcher is the tool name),
   timeout 2. Stdin:
   `{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"npm test"},"error":"connect ECONNREFUSED 127.0.0.1:5432","session_id":"s1"}`.
   Stdout when a pattern matches:
   `{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"Service not reachable. Check that it is running. Do not retry."}}`
   Nothing otherwise. The tool has already failed, so this event only adds context.
3. Retry hook. Event `PreToolUse`, matcher `Bash`, timeout 2. Stdin:
   `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"session_id":"s1"}`.
   It hashes the command, counts the hash in the session's log, and prints nothing for 0, a warning
   for 1, a stop for 2 or more:
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"WARNING: This command failed previously this session. If it fails again, stop retrying and diagnose."}}`
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"STOP: This exact command has failed 2 times already. Do NOT retry. Diagnose the root cause or try a different approach."}}`
   It uses `additionalContext`, so the call still runs; it advises. To refuse the call, print the
   `permissionDecision: "deny"` form from `skills.read("block-tool-call")` instead.
4. One script can serve both: save `.claude/hooks/failures.mjs`, and read `hook_event_name` to choose.

   ```js
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   import crypto from "node:crypto";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   const command = input.tool_input?.command ?? "";
   const log = path.join(os.tmpdir(), `claude-bash-failures-${input.session_id ?? "unknown"}`);
   const hash = crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
   const say = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
   const guidance = [
     [/ImportError|ModuleNotFoundError|Cannot find module/i, "Import failed. Check the dependency is declared and the import path is right."],
     [/ECONNREFUSED|Connection refused|Connection reset/i, "Service not reachable. Check that it is running. Do not retry."],
     [/No such file or directory|ENOENT/i, "Path does not exist. Use Glob to find the right path."],
     [/401|403|token.*expir|reauthentication/i, "Authentication failed. Ask the user to sign in again. Do not retry."],
   ];
   try {
     if (input.hook_event_name === "PostToolUseFailure") {
       if (input.tool_name === "Bash" && command) fs.appendFileSync(log, hash + "\n");
       if (input.tool_name === "Edit") say("PostToolUseFailure", "Edit failed (old_string not found). The file may have changed. Read it again before retrying.");
       else { const hit = guidance.find(([re]) => re.test(input.error ?? "")); if (hit) say("PostToolUseFailure", hit[1]); }
     } else if (input.hook_event_name === "PreToolUse" && command && fs.existsSync(log)) {
       const n = fs.readFileSync(log, "utf8").split("\n").filter((l) => l === hash).length;
       if (n >= 2) say("PreToolUse", `STOP: This exact command has failed ${n} times already. Do NOT retry. Diagnose the root cause or try a different approach.`);
       else if (n === 1) say("PreToolUse", "WARNING: This command failed previously this session. If it fails again, stop retrying and diagnose.");
     }
   } catch {}
   ```

5. Add both handlers to one scope:
   `setup.addHook({ scope: "user", event: "PostToolUseFailure", matcher: "Bash|Edit", command: "node ~/.claude/hooks/failures.mjs", timeout: 2 })` and
   `setup.addHook({ scope: "user", event: "PreToolUse", matcher: "Bash", command: "node ~/.claude/hooks/failures.mjs", timeout: 2 })`.
   Their handlers are in different groups, so both run (identical handlers inside one event are
   deduplicated; these differ by event).
6. Test the pair in order with `setup.testHook`, each with `fields: { session_id: "t1", tool_name: "Bash", tool_input: { command: "npm test" }, error: "ECONNREFUSED" }`:
   PostToolUseFailure once (expect the guidance), then PreToolUse (expect the WARNING), then
   PostToolUseFailure again and PreToolUse (expect the STOP). Delete the log file afterwards
   (`claude-bash-failures-t1` in the temp folder): the caller does that.
