Keep Claude Code, a subagent or a task from finishing until a check passes: Stop, SubagentStop and TaskCompleted hooks

1. Pick the event: `Stop` when Claude ends its turn, `SubagentStop` when a subagent ends,
   `TaskCompleted` when a task is marked done. These three take no matcher; `addHook` refuses one.
2. Every gate needs a way out, or it loops. Stop and SubagentStop input carries
   `stop_hook_active`: true when Claude is already continuing because a Stop hook blocked it. A
   gate that sees `true` must allow at once. Claude Code also force-stops after 8 blocks in a row
   (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises that); do not rely on it.
3. Stop and SubagentStop. Stdin:
   `{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Done.","session_id":"s1","cwd":"/repo"}`
   (SubagentStop adds `agent_id`, `agent_type`, `agent_transcript_path`). To block, stdout is
   exactly `{"decision":"block","reason":"Uncommitted changes detected. Commit or stash before stopping."}`;
   to allow, nothing. The reason goes to Claude as its next instruction.
4. TaskCompleted. Stdin: `{"hook_event_name":"TaskCompleted","task_id":"t1","task_subject":"Add login","cwd":"/repo"}`.
   It blocks by exit code 2 with the message on stderr, which Claude receives. Exit 0 allows.
   Alternatively print `{"continue":false,"stopReason":"..."}`, which stops the teammate entirely.
5. Script for the caller to save as `.claude/hooks/stop-gate.mjs`, a Stop gate on uncommitted work:

   ```js
   import fs from "node:fs";
   import { execFileSync } from "node:child_process";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   if (input.stop_hook_active) process.exit(0);
   try {
     const out = execFileSync("git", ["status", "--porcelain"], { cwd: input.cwd || process.cwd(), encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
     if (out.trim()) process.stdout.write(JSON.stringify({ decision: "block", reason: "Uncommitted changes detected. Commit or stash before stopping." }));
   } catch {}
   ```

   The `catch` makes it fail open when git is missing, which is the right default for a gate.
6. A SubagentStop gate that asks once uses a marker file instead of `stop_hook_active`: block the
   first time, create the marker, allow when the marker exists, remove the marker when the
   condition is met. The same shape serves a TaskCompleted gate that runs a test command: run it
   with `execFileSync` and a timeout, and on failure write the last lines of output to stderr and
   `process.exit(2)`.
7. Add it: `await setup.addHook({ scope: "project", event: "Stop", command: "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-gate.mjs", timeout: 30 })`.
   A TaskCompleted test run needs a timeout above the test time: 120 for a test suite.
8. Test with `setup.testHook({ event: "Stop", command: "node", args: [path], fields: { stop_hook_active: true } })`
   (expect no output) and again without `fields` in a folder with changes (expect the block JSON). Then `scripts.run("validate-hooks")`.
