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
| `/compact` | | Summarise conversation history to save context tokens (resets cumulative token count) |
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
- Cumulative token counts (tracked across session resumption)

```bash
nlpilot --continue    # resume the last session in the current directory
```

### Context Optimization

nlpilot automatically manages context window usage through several techniques:

#### Message Trimming
Large tool outputs (like verbose file reads or bash results) are automatically compressed in the conversation history:
- Kept in full: Last 3 assistant turns (to preserve recent context)
- Trimmed: Older outputs larger than 800 characters are replaced with `[output trimmed — X chars]`
- Benefit: Preserves context window space while retaining relevant recent interactions

#### Output Limits
To prevent single tool calls from consuming too much context:
- **Bash output** limited to 8,000 characters
- **File viewing** limited to 80 default lines or 6,000 bytes
- **Automatic abbreviation**: Tool outputs exceeding limits are truncated with a note

#### Auto-Compaction
When the conversation history grows very large, use `/compact` to summarize the entire conversation:
- Creates a compressed summary of the discussion (counted toward cumulative tokens)
- Resets cumulative token tracking to reflect the new baseline
- Useful for long-running sessions to free up context window

#### Cumulative Token Tracking
Sessions track cumulative input and output tokens across all turns:
- `cumulativeInputTokens`: Total tokens sent to the model
- `cumulativeOutputTokens`: Total tokens received from the model
- Reset only after `/compact` to reflect the summarization
- Accessible in session metadata for cost estimation

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

## Model Catalog Configuration

nlpilot uses a flexible model catalog system that combines built-in defaults with user customization.

### Catalog Location

The model catalog is loaded from (in priority order):
1. **User catalog**: `~/.nlpilot/models.json` (if exists)
2. **Fallback**: Built-in embedded catalog (automatically used if file missing or invalid)

### Catalog File Format

Create or edit `~/.nlpilot/models.json` to customize available models:

```json
{
  "anthropic": [
    {
      "id": "claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "description": "Balanced flagship model",
      "contextSize": 1000000,
      "inputCost": 0.003,
      "outputCost": 0.015
    }
  ],
  "openai": [
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "description": "Balanced model",
      "contextSize": 1100000,
      "inputCost": 0.005,
      "outputCost": 0.020
    }
  ],
  "google": [
    {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "description": "Advanced reasoning model",
      "contextSize": 1000000,
      "inputCost": 0.0025,
      "outputCost": 0.01
    }
  ]
}
```

### Catalog Schema

Each model entry supports:
- **id** (required): Unique model identifier
- **name**: Display name
- **description**: Brief description
- **contextSize**: Maximum context window in tokens (used for planning and message trimming)
- **inputCost**: Cost per 1M input tokens (optional, for future billing features)
- **outputCost**: Cost per 1M output tokens (optional, for future billing features)

### Default Model Selection

During `nlpilot login`, you'll select a default model from the available catalog. This default is used whenever no `--model` flag is provided.

To change your default model later:
```bash
nlpilot login          # Re-run the wizard to select a different model
nlpilot --model <id>   # Override for a single run
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

## Changelog

### v0.x (Latest)

#### Context Management & Optimization
- **Automatic message trimming**: Large tool outputs in conversation history are now automatically compressed to preserve context window. Recent assistant turns retain full context, while older verbose outputs are replaced with `[output trimmed — X chars]` notation.
- **Output limits**: Reduced default output sizes to optimize context usage:
  - Bash command output capped at 8,000 characters
  - File viewing limited to 80 lines or 6,000 bytes (configurable via `VIEW_DEFAULT_LINES` and `VIEW_MAX_BYTES`)
- **Cumulative token tracking**: Sessions now track total input/output tokens across all turns and resumptions
- **Auto-compaction token reset**: When `/compact` summarizes a conversation, cumulative token counts reset to reflect the new baseline

#### Model Catalog System
- **Dynamic model loading**: Model catalog now loads from `~/.nlpilot/models.json` with automatic fallback to embedded defaults
- **User customization**: Create or modify `~/.nlpilot/models.json` to add custom models, adjust costs, and override model configurations
- **Context size awareness**: Models now include `contextSize` property for better context planning and message trimming decisions
- **Dynamic default selection**: Default models are determined from the loaded catalog rather than hardcoded

#### Tool & Approval System
- **Fixed readline deadlock**: Improved REPL approval prompt handling with separate readline instances and mutex-based serialization
- **Better tool logging**: New `toolInputSummary()` function provides cleaner display of tool execution details (bash commands, file paths with line ranges, grep patterns)
- **Concurrent prompt protection**: Mutex-based `_promptLock` prevents concurrent approval dialogs from interfering

#### Configuration & Startup
- **Auto-initialization**: Config directory is now automatically initialized on first run
- **Early catalog loading**: Model catalog pre-loaded during app startup for better initialization flow
- **Separation of concerns**: Config file handles credentials; model catalog handles model definitions

---

## License

MIT
