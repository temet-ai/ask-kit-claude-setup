Serve several hook events from one script: a dispatcher that routes on hook_event_name, tool_name and an argument

1. Use it when three or more hooks share helpers or state. One file is easier to test and settings
   hold one command, with the matcher and an optional argument saying which case applies. For two
   unrelated hooks, two scripts are simpler.
2. Every event delivers the same envelope on stdin: `hook_event_name`, `session_id`, `cwd`, and for
   tool events `tool_name` and `tool_input`; PostToolUseFailure adds `error`, SessionStart adds
   `source`. Route on `hook_event_name` first, then `tool_name`, then `process.argv[2]`.
3. Each case returns the output shape of its own event, or nothing:
   - SessionStart, PostToolUse, PostToolUseFailure, PreToolUse context:
     `{"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}}`
   - PreToolUse decision: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
   - PermissionRequest: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   - Stop, SubagentStop: `{"decision":"block","reason":"..."}`
   The shapes differ per event and must not be mixed; `skills.read("block-tool-call")`,
   `skills.read("auto-approve-permission")`, `skills.read("gate-stop")` and
   `skills.read("inject-context")` hold each one.
4. Skeleton for `.claude/hooks/dispatch.mjs`. Parse failures give an empty object and no handler
   throws out of `main`, so a broken case never fails the session:

   ```js
   import fs from "node:fs";
   const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
   const routes = {
     SessionStart: (d, arg) => (arg === "compact" ? null : context("SessionStart", "Session started")),
     "PostToolUseFailure:Edit": () => context("PostToolUseFailure", "Edit failed. Read the file again before retrying."),
     PermissionRequest: () => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }),
   };
   let data = {};
   try { data = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
   const arg = process.argv[2];
   const handler = routes[`${data.hook_event_name}:${data.tool_name}`] ?? routes[data.hook_event_name];
   try {
     const out = handler?.(data, arg);
     if (out) process.stdout.write(JSON.stringify(out));
   } catch (e) { process.stderr.write(`dispatch: ${e.message}\n`); }
   ```

5. Settings: one handler per matcher group, the same command in each, an argument where the case
   needs it. SessionStart `startup` and `compact` are two groups:
   `setup.addHook({ scope: "user", event: "SessionStart", matcher: "startup", command: "node ~/.claude/hooks/dispatch.mjs", timeout: 5 })` and
   `setup.addHook({ scope: "user", event: "SessionStart", matcher: "compact", command: "node ~/.claude/hooks/dispatch.mjs compact", timeout: 5 })`.
   A PermissionRequest group must keep a narrow matcher (`Read|Glob|Grep`): the dispatcher
   approves whatever reaches it.
6. Identical handlers inside one event are run once, matched by command text and arguments. The two
   SessionStart commands above differ by the `compact` argument, so both stay.
7. Test every route with `setup.testHook` and `fields` carrying `tool_name` and `error`; each route
   prints one JSON object or nothing.
