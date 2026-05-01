# MCP Integration Guide

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io) lets you extend nlpilot with external tools (file systems, databases, APIs) without modifying nlpilot's source code.

---

## Configuration Files

nlpilot reads MCP servers from three sources, in order of priority (highest wins):

1. `--additional-mcp-config <path>` (per-run CLI flag)
2. `.mcp.json` in the project root
3. `~/.nlpilot/mcp.json` (global user config)

### Supported Formats

**Claude Code / Cursor style (`mcpServers`):**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "type": "stdio"
    }
  }
}
```

**nlpilot native style (`servers`):**
```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  ]
}
```

Supported transports: `stdio`, `http`, `sse`.

---

## Lifecycle

1. **Config loading** (`src/mcp.ts`)
   - `loadEffectiveMcpConfig()` merges global + project configs.
   - `mergeAdditionalMcpConfig()` overlays the CLI `--additional-mcp-config` file.

2. **Runtime startup** (`src/tools/mcp.ts`)
   - `startMcpRuntime(servers)` spawns stdio processes or connects to HTTP/SSE endpoints.
   - Each server exposes tools through the MCP SDK.
   - Tools are converted to Vercel AI SDK `tool()` objects with Zod schemas generated from the MCP tool definitions.

3. **Tool merging** (`src/commands/repl.ts`)
   - MCP tools are merged into the built-in tool set with `Object.assign(tools, mcp.tools)`.
   - Available MCP tool names are printed to the terminal at startup.

4. **Shutdown**
   - MCP transports are closed when the REPL exits (or when the one-shot run finishes).

---

## Writing an MCP Server for nlpilot

Any MCP-compliant server works. If you're building one specifically for nlpilot:

- Keep tool descriptions concise and actionable — they become part of the system prompt.
- Return plain text or JSON. Very large outputs are not automatically trimmed by MCP; cap them in your server if needed.
- Name tools clearly (e.g., `query_database`, `deploy_vercel`). The model sees these names when deciding which tool to call.

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `MCP tools available:` is empty | Server failed to start | Check that `command` is in `$PATH`; run it manually. |
| Tool calls timeout | Slow stdio startup | Ensure the server prints its initial handshake quickly. |
| `Transport not supported` | Unknown transport type | Use `stdio`, `http`, or `sse`. |
| Duplicate tool names | Global + project configs overlap | Rename one server, or remove the duplicate. |

---

## Security Considerations

- MCP servers run with the same privileges as nlpilot (your user shell).
- A malicious MCP server could expose sensitive data. Only add servers you trust.
- There is no sandboxing; `stdio` servers can read any file your user can read.
