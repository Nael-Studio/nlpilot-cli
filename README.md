# nlpilot CLI

A GitHub Copilot-style AI coding assistant for the terminal, powered by the [Vercel AI SDK](https://sdk.vercel.ai). Supports OpenAI, Anthropic, Google, and any custom endpoint (including Azure AI Foundry).

---

## Requirements

- [Bun](https://bun.sh) v1.x or later

---

## Installation

```bash
# Clone and install dependencies
git clone <repo>
cd nlpilot-cli
bun install

# Run from source
bun run src/index.ts

# Or build a single-file binary and link it globally
bun run build
bun link
```

After linking, the `nlpilot` command is available system-wide.

---

## Authentication

### Standard providers (OpenAI / Anthropic / Google)

```bash
nlpilot login
```

The interactive wizard will ask you to:
1. Select a provider (`openai`, `anthropic`, or `google`)
2. Enter your API key (hidden input)
3. Optionally enter a custom endpoint base URL (see Azure Foundry below)
4. Pick a default model from the curated catalog, or enter a custom model ID

Credentials are saved to `~/.nlpilot/credentials` with `0600` permissions.

### Azure AI Foundry (custom endpoint)

When prompted "Use custom endpoint?", choose **Yes** and enter your Foundry endpoint, e.g.:

```
https://<your-instance>.services.ai.azure.com/anthropic/v1
```

The API key and base URL are stored together in the credentials file. When a `baseUrl` is present the `@ai-sdk/anthropic` provider is used directly (bypassing the AI Gateway).

### Environment variable overrides

| Variable | Description |
|---|---|
| `NLPILOT_API_KEY` | Override stored API key |
| `NLPILOT_PROVIDER` | Override stored provider |
| `NLPILOT_MODEL` | Override stored model for this run |

---

## Usage

### Interactive REPL

```bash
nlpilot                     # start a fresh session
nlpilot --continue          # resume the most recent session
nlpilot --model claude-sonnet-4.6
```

### One-shot (non-interactive)

```bash
nlpilot -p "Explain this codebase"
nlpilot --prompt "Write unit tests for src/utils.ts" --output-format json
```

---

## Global Flags

| Flag | Short | Description |
|---|---|---|
| `--model <id>` | `-m` | Override the default model for this run |
| `--prompt <text>` | `-p` | Run one prompt non-interactively, then exit |
| `--silent` | `-s` | Suppress banners and tool logs; print only the response |
| `--output-format <fmt>` | | `text` (default) or `json` — controls stdout format in one-shot mode |
| `--allow-all-tools` | | Skip tool approval prompts (autopilot mode) |
| `--allow-all` | | Alias for `--allow-all-tools` |
| `--no-ask-user` | | GitHub Copilot CLI alias — same as `--allow-all-tools` |
| `--enable-reasoning-summaries` | | Show reasoning/thinking summaries from models that support extended thinking |
| `--allow-tool <name>` | | Always allow a specific tool (repeatable, comma-separated) |
| `--deny-tool <name>` | | Always deny a specific tool (repeatable, comma-separated) |
| `--additional-mcp-config <path>` | | Load extra MCP servers from a config file |
| `--continue` | | Resume the most recent session in the current directory |
| `--version` | `-v` | Print version |

---

## REPL Slash Commands

Inside an interactive session, type `/` to access built-in commands:

| Command | Aliases | Description |
|---|---|---|
| `/help` | | Show all available commands |
| `/exit` | `/quit` | Exit nlpilot |
| `/clear` | `/new`, `/reset` | Start a new conversation (clears history) |
| `/model [id]` | `/models` | List available models, or switch to a specific model |
| `/mode [ask\|plan\|autopilot]` | | Show or change the tool approval mode |
| `/compact` | | Summarise conversation history to save context tokens |
| `/save [name]` | | Save the current session with an optional name |
| `/sessions` | `/history` | List all saved sessions |
| `/load <id>` | | Load a session by ID |
| `/delete <id>` | `/rm` | Delete a session |
| `/undo` | | Revert the most recent file change made by the agent |
| `/diff` | | Show a diff of all file changes in this session |
| `/theme [name]` | | Change the display theme (`default`, `dim`, `high-contrast`) |
| `/init` | | Scaffold `.nlpilot/` customization directory |
| `/version` | | Print version |

---

## Built-in Tools

The agent has access to these built-in tools. Each tool that modifies the filesystem asks for approval unless `--allow-all-tools` / `--no-ask-user` is set.

| Tool | Description |
|---|---|
| `bash` | Execute shell commands via `/bin/sh -c` |
| `read_file` | Read a file (up to 16 KB, or the first N lines) |
| `write_file` | Write or overwrite a file (tracks changes for `/undo`) |
| `edit_file` | Apply a targeted string-replace patch to an existing file |
| `list_dir` | List directory contents with optional glob pattern |
| `glob` | Glob search across the workspace |
| `grep` | Search file contents with a regex pattern |

---

## MCP Servers

nlpilot supports the [Model Context Protocol](https://modelcontextprotocol.io) for extending the agent with external tools.

### Config file locations

| Priority | Path | Description |
|---|---|---|
| Lowest | `~/.nlpilot/mcp.json` | Global user config |
| Middle | `.mcp.json` in project root | Project-level config (overrides global) |
| Highest | `--additional-mcp-config <path>` | Per-run extra config file (overrides both) |

### Config file format

Both Claude Code / Cursor style and nlpilot internal style are supported:

**`mcpServers` style (Claude Code / Cursor):**
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "type": "stdio",
      "env": { "MY_KEY": "value" }
    },
    "remote-server": {
      "url": "https://my-mcp.example.com",
      "type": "http"
    }
  }
}
```

**`servers` style (nlpilot):**
```json
{
  "servers": [
    {
      "name": "my-server",
      "transport": "stdio",
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  ]
}
```

### Managing MCP servers via CLI

```bash
nlpilot mcp list              # list all configured servers
nlpilot mcp get <name>        # show a server's config
nlpilot mcp add [name]        # interactively add a server
nlpilot mcp remove <name>     # remove a server
```

---

## Session Management

Sessions are stored under `~/.nlpilot/sessions/<cwdHash>/` and are shared between the CLI and the VS Code extension. Each session records:

- Conversation messages
- Model and provider used
- File changes made by the agent during the session

```bash
nlpilot --continue    # resume the last session in the current directory
```

---

## Customization

Run `nlpilot init` to scaffold a `.nlpilot/` directory in your project with examples for all customization points.

### Instruction files

Loaded automatically from (in order):
- `.nlpilot/instructions.md` in the current directory
- `AGENTS.md` in the current directory

Supports YAML front-matter for metadata:
```markdown
---
name: Project Guidelines
---
Always use TypeScript strict mode. Prefer `bun` over `npm`.
```

### Custom agents

Place `.md` files in `.nlpilot/agents/`. Each file defines a specialized agent persona with its own system prompt, model override, and tool allowlist:

```markdown
---
name: Code Reviewer
description: Strict code review with security focus
model: claude-opus-4-6
tools: read_file,grep,list_dir
---

You are a strict code reviewer. Focus on security, performance, and maintainability...
```

Activate with `/agent <name>` in the REPL.

### Skills

Place `.md` files in `.nlpilot/skills/`. Skills inject additional context into the system prompt for specialized workflows (similar to GitHub Copilot skills).

### Hooks

Define lifecycle hooks in `.nlpilot/hooks.json` to run shell scripts before/after turns:

```json
{
  "preTurn": ["./scripts/lint.sh"],
  "postTurn": ["./scripts/format.sh"]
}
```

---

## Supported Models

### Anthropic
| Model ID | Description |
|---|---|
| `claude-sonnet-4.6` | Balanced flagship · 1M ctx |
| `claude-opus-4.7` | Top quality · 1M ctx |
| `claude-haiku-4.5` | Fast & cheap · 200K ctx |
| `claude-opus-4-6` | High quality · 1M ctx |
| `claude-sonnet-4.5` | Balanced · 1M ctx |
| `claude-3-haiku` | Cheapest · 200K ctx |

### OpenAI
| Model ID | Description |
|---|---|
| `gpt-5.5` | Flagship · 1M ctx |
| `gpt-5.5-pro` | Heavy reasoning |
| `gpt-5.4` | Balanced · 1.1M ctx |
| `gpt-5.4-mini` | Fast · 400K ctx |
| `gpt-5.4-nano` | Cheapest · 400K ctx |

### Google
| Model ID | Description |
|---|---|
| `gemini-2.5-pro` | Flagship reasoning |
| `gemini-2.5-flash` | Fast multimodal |
| `gemini-2.5-flash-lite` | Most affordable |

Any model ID not in the catalog can be entered as a custom ID during `nlpilot login` or by passing `--model <id>`.

---

## Project Structure

```
src/
├── index.ts              # CLI entry point, command definitions
├── config.ts             # Credentials load/save, env overrides
├── models.ts             # Model catalog per provider
├── providers.ts          # AI SDK provider factory (gateway + custom endpoint)
├── session.ts            # Session interface, system prompt builder
├── persistence.ts        # Session file I/O (~/.nlpilot/sessions/)
├── customization.ts      # Agents, skills, instruction file loader
├── mcp.ts                # MCP config load/save/merge
├── hooks.ts              # Pre/post-turn hook runner
├── commands/
│   ├── repl.ts           # Interactive REPL loop
│   ├── oneshot.ts        # Non-interactive single-prompt runner
│   ├── slash.ts          # /command handler registry
│   ├── compact.ts        # Context compaction (/compact)
│   ├── login.ts          # nlpilot login wizard
│   ├── logout.ts         # nlpilot logout
│   ├── models.ts         # nlpilot models list command
│   ├── mcp.ts            # nlpilot mcp subcommand
│   ├── init.ts           # nlpilot init scaffolding
│   └── help.ts           # nlpilot help
└── tools/
    ├── index.ts          # Built-in tool definitions (bash, file ops, glob, grep)
    ├── approval.ts       # Tool approval state machine
    └── mcp.ts            # MCP runtime (connect + expose as AI SDK tools)
```

---

## License

MIT
