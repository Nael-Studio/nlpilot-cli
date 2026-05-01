# Lifecycle Hooks

Hooks let you run external commands or HTTP requests in response to nlpilot lifecycle events. They are useful for logging, metrics, notifications, or triggering CI pipelines.

---

## Configuration

Place a hooks config in one of:

- `.nlpilot/hooks/hooks.json`
- `.nlpilot/hooks/config.json`

```json
{
  "hooks": [
    {
      "event": "sessionStart",
      "type": "command",
      "command": "echo 'Session started' >> /tmp/nlpilot.log"
    },
    {
      "event": "preToolUse",
      "type": "command",
      "match": "bash",
      "command": "notify-send 'nlpilot' 'About to run bash command'"
    },
    {
      "event": "postToolUse",
      "type": "http",
      "url": "https://hooks.slack.com/services/XXX"
    }
  ]
}
```

---

## Events

| Event | When it fires | Context available |
|---|---|---|
| `sessionStart` | After the session is initialized but before the first prompt | `sessionId`, `cwd` |
| `preToolUse` | Before a tool executes | `toolName`, `input`, `sessionId`, `cwd` |
| `postToolUse` | After a tool finishes | `toolName`, `input`, `output`, `sessionId`, `cwd` |
| `agentStop` | When the model finishes its turn | `sessionId`, `cwd` |

---

## Hook Types

### Command Hooks

Spawns `/bin/sh -c <command>` with the following environment variables:

| Variable | Value |
|---|---|
| `NLPILOT_HOOK_TOOL` | Tool name (for `preToolUse` / `postToolUse`) |
| `NLPILOT_HOOK_SESSION` | Session ID |
| `NLPILOT_HOOK_CWD` | Working directory |

The hook context is also written to the child process's `stdin` as JSON.

### HTTP Hooks

Sends a `POST` request with `Content-Type: application/json` and a body like:

```json
{
  "event": "postToolUse",
  "toolName": "bash",
  "input": { "command": "npm test" },
  "output": { "stdout": "...", "stderr": "", "exitCode": 0 },
  "sessionId": "...",
  "cwd": "/home/user/project"
}
```

HTTP hooks silently swallow network errors so they cannot crash the REPL.

---

## Filtering with `match`

For `preToolUse` and `postToolUse`, you can filter by tool name using a regex:

```json
{
  "event": "preToolUse",
  "match": "^(bash|edit)$",
  "type": "command",
  "command": "echo 'Mutating tool used'"
}
```

If `match` is omitted, the hook fires for every tool use.

---

## Best Practices

- **Keep hooks fast**: Slow hooks block the REPL loop. Use `&` to background shell commands if needed.
- **Idempotency**: Hooks may fire multiple times per session. Design them to be safe to rerun.
- **No secrets in config**: Avoid putting API keys directly in `hooks.json`. Use environment variables instead (`command": "curl -H \"Authorization: Bearer $MY_TOKEN\" ..."`).
- **Failures are silent**: If your hook isn't working, run nlpilot with a wrapper script that logs stderr.
