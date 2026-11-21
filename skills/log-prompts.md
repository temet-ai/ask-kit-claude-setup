Record something about each prompt without slowing Claude Code down: an async UserPromptSubmit hook that appends to a log

1. Event `UserPromptSubmit`, which takes no matcher. Set `async: true`:
   `setup.addHook({ scope: "user", event: "UserPromptSubmit", command: "node ~/.claude/hooks/log-prompts.mjs", async: true })`.
   An async command hook runs in the background: Claude Code does not wait for it and does not
   apply `timeout` to it, and its output cannot block or edit the prompt. Only `additionalContext` and
   `systemMessage` from it are delivered, on the next turn. It is for logging and analysis.
2. Stdin: `{"hook_event_name":"UserPromptSubmit","prompt":"no, that is wrong, use the other file","session_id":"s1","cwd":"/repo"}`.
   Without `async`, stdout of `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`
   would add context to the prompt, and `{"decision":"block","reason":"..."}` would refuse and erase it.
   A script that prints nothing, as this one does, delivers nothing either way.
3. Decide what to record and keep it small. Store a signal type and the first 200 characters of the
   prompt, never the whole prompt; prompts can hold secrets. Say in the answer where the log lives
   and that the prompt text goes into it.
4. Script `.claude/hooks/log-prompts.mjs`, which tags correction and frustration phrases and appends
   one JSON line per match:

   ```js
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
   const prompt = String(input.prompt ?? "");
   if (prompt.length < 5) process.exit(0);
   const patterns = [
     [/\bno[,.]?\s+(not |don'?t |stop )/i, "correction"],
     [/\bwrong\b/i, "correction"],
     [/\bI (already |just )?told you/i, "correction"],
     [/\bstop doing\b/i, "frustration"],
     [/\byou keep\b/i, "frustration"],
     [/\bdon'?t\s+(add|create|make|use|do)\b/i, "instruction"],
   ];
   const hits = patterns.filter(([re]) => re.test(prompt)).map(([, type]) => type);
   if (!hits.length) process.exit(0);
   const dir = path.join(os.homedir(), ".claude", "prompt-signals");
   fs.mkdirSync(dir, { recursive: true });
   fs.appendFileSync(path.join(dir, "signals.jsonl"), JSON.stringify({ at: new Date().toISOString(), session: input.session_id, cwd: input.cwd, types: [...new Set(hits)], context: prompt.slice(0, 200) }) + "\n");
   ```

5. Test with `setup.testHook({ event: "UserPromptSubmit", prompt: "no, that is wrong", command: "node", args: [path] })`:
   exit 0 and empty stdout, and one new line in the log. A prompt with no match leaves the log alone.
6. `async` belongs on command handlers; `scripts.run("validate-hooks")` warns about it on any other type.
