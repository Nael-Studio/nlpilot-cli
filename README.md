# nlpilot CLI

A GitHub Copilot-style AI coding assistant for the terminal, powered by the [Vercel AI SDK](https://sdk.vercel.ai). Supports OpenAI, Anthropic, Google, DeepSeek, Moonshot AI/Kimi, and custom OpenAI-compatible endpoints.

nlpilot is built for developers who want the Copilot workflow without being locked into one billing model or one model catalog. GitHub Copilot is moving from request-based billing to usage-based GitHub AI Credits on June 1, 2026, where chat and agent usage are priced by token consumption per model. nlpilot lets you bring your own API keys, choose smaller or cheaper models for routine work, and still keep familiar chat, tool use, sessions, code edits, and model switching.

Useful cost-focused model choices include:

- `kimi-k2.6` through Moonshot AI for agentic coding and long-context work
- `deepseek-v4-flash` for fast, low-cost everyday coding
- `deepseek-v4-pro` for harder reasoning and larger codebase analysis
- `claude-3-haiku`, Gemini Flash/Lite, and mini/nano models for low-latency tasks

References: [GitHub Copilot models and pricing](https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing), [GitHub usage-based billing](https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals), [Kimi model list](https://platform.kimi.ai/docs/models), and [DeepSeek V4 Pro API reference](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-pro).

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

### Standard providers

```bash
nlpilot login
```

The interactive wizard will ask you to:
1. Select a provider (`openai`, `anthropic`, `google`, `deepseek`, or `moonshotai`)
2. Enter your API key (hidden input)
3. Optionally enter a custom endpoint base URL
4. Pick a default model from the curated catalog, or enter a custom model ID

Credentials are saved to `~/.nlpilot/credentials` with `0600` permissions.

### Custom endpoint

When prompted "Use custom endpoint?", choose **Yes** and enter an OpenAI-compatible endpoint, e.g.:

```
https://<your-instance>.services.ai.azure.com/anthropic/v1
```

The API key and base URL are stored together in the credentials file. When a `baseUrl` is present, nlpilot calls the provider SDK directly instead of routing through the AI Gateway. Anthropic custom endpoints use `@ai-sdk/anthropic`; other custom endpoints use the OpenAI-compatible client.

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
| `--max-steps <n>` | | Maximum model/tool loop steps per prompt |
| `--max-output-tokens <n>` | | Maximum assistant output tokens |
| `--no-mcp` | | Disable all MCP servers for this run |
| `--no-model-routing` | | Disable automatic cheap/balanced/reasoning model routing |
| `--no-auto-compact` | | Disable rolling REPL compaction after each turn |
| `--compact-threshold <pct>` | | Auto-compact REPL context when estimated usage exceeds this percent |
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
| `view` | Read line ranges from a file |
| `edit` | Apply a targeted string replacement to an existing file |
| `create` | Create a new file (tracks changes for `/undo`) |
| `grep` | Search file contents, or list files with `filenamesOnly:true` |
| `web_fetch` | Fetch public HTTP/HTTPS URLs with approval and SSRF protections |

`grep` uses the FFF search backend when the native library is available, keeping
an indexed cache warm across repeated searches in the same CLI process. If FFF
is unavailable, or if `NLPILOT_SEARCH_BACKEND=native` is set, nlpilot falls back
to its built-in TypeScript scanner.

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
- Kept in full: Last assistant turn (to preserve recent context)
- Tool results: Older outputs are replaced with structured summaries such as `view(src/session.ts:1-160) -> read 160 lines`
- Duplicate tool results: Repeated large outputs are replaced with reference stubs
- Older text turns: Long user/assistant messages are compacted and repeated attachment/project-context blocks are removed
- Benefit: Preserves context window space while retaining paths, counts, statuses, and errors

#### Output Limits
To prevent single tool calls from consuming too much context:
- **Bash output** limited to 4,000 characters
- **Grep output** limited to 8,000 characters
- **File viewing** limited to 160 lines per call, with an 80-line minimum window
- **Web fetch body reads** limited to 100,000 bytes before final text truncation
- **Automatic abbreviation**: Tool outputs exceeding limits are truncated with a note

#### Prompt Context Selection
Repeated system prompt context is kept small by default:
- Project instructions and file snapshots are included only for project/code-related prompts
- Skills and agents are listed only when the prompt asks about them
- Source files are injected as a directory summary plus key files, not a full tree
- File snapshots appear on the first project-related turn or when the user asks about repo structure/files

#### Auto-Compaction
The REPL now performs rolling compaction after each turn:
- Older history is summarized into a compact working-memory note
- The latest exchange stays intact for immediate continuity
- The `--compact-threshold <pct>` guard remains as a backstop for unusually large turns
- Use `--no-auto-compact` to keep full persisted history until `/compact` or the threshold guard runs

Manual `/compact` still summarizes the full conversation and resets cumulative token tracking to the compacted baseline.

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
tools: view,grep
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
      "inputCost": 3.00,
      "outputCost": 15.00
    }
  ],
  "openai": [
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "description": "Balanced model",
      "contextSize": 1100000,
      "inputCost": 2.50,
      "outputCost": 15.00
    }
  ],
  "google": [
    {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "description": "Advanced reasoning model",
      "contextSize": 1000000,
      "inputCost": 2.50,
      "outputCost": 10.00
    }
  ],
  "deepseek": [
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "description": "Advanced reasoning and agentic coding",
      "contextSize": 1000000,
      "inputCost": 1.74,
      "outputCost": 3.48
    },
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "description": "Fast economical coding model",
      "contextSize": 1000000,
      "inputCost": 0.14,
      "outputCost": 0.28
    }
  ],
  "moonshotai": [
    {
      "id": "kimi-k2.6",
      "name": "Kimi K2.6",
      "description": "Agentic coding and multimodal long-context work",
      "contextSize": 256000,
      "inputCost": 0.95,
      "outputCost": 4.00
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

### Cost-Aware Model Routing

When no explicit model is provided, nlpilot classifies each prompt and routes to a cheaper capable model where possible:

| Task class | Typical prompts | Routing behavior |
|---|---|---|
| `cheap` | help-like questions, listings, repo structure, simple search/explain prompts | cheapest catalog model for the provider |
| `balanced` | normal coding edits and implementation work | balanced coding/general model |
| `reasoning` | debugging, security, architecture, complex analysis, plan mode | configured default model |

`--model <id>`, `NLPILOT_MODEL`, `/model <id>`, and agent model overrides pin the chosen model and bypass automatic routing. Custom `baseUrl` credentials also bypass routing because those endpoints may not support the built-in catalog names. Use `--no-model-routing` to disable this behavior for a run.

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

### DeepSeek
| Model ID | Description |
|---|---|
| `deepseek-v4-pro` | Advanced reasoning and agentic coding · 1M ctx |
| `deepseek-v4-flash` | Fast economical coding · 1M ctx |
| `deepseek-v3.2` | Previous generation |
| `deepseek-v3.2-thinking` | Previous generation with extended thinking |

### Moonshot AI / Kimi
| Model ID | Description |
|---|---|
| `kimi-k2.6` | Agentic coding, visual/text input, thinking and non-thinking modes · 256K ctx |

Any model ID not in the catalog can be entered as a custom ID during `nlpilot login` or by passing `--model <id>`.

---

## Project Structure

```
src/
├── index.ts              # CLI entry point, command definitions
├── config.ts             # Credentials load/save, env overrides
├── models.ts             # Model catalog per provider
├── model-router.ts       # Cheap/balanced/reasoning model selection
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
  - Bash command output capped at 4,000 characters
  - Grep output capped at 8,000 characters
  - File viewing limited to 160 lines per call
  - Web fetch body reads capped at 100,000 bytes before final text truncation
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

## Developer Documentation

- [Architecture Overview](ARCHITECTURE.md) — how the codebase fits together
- [Contributing Guide](CONTRIBUTING.md) — setup, style, and PR workflow
- [docs/](docs/) — detailed guides for extending commands, providers, MCP, skills, and hooks

## License

Licensed under the [Apache License 2.0](LICENSE).
