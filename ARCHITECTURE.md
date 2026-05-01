# nlpilot Architecture

This document explains how nlpilot is organized, how data flows through the system, and where to look when you want to change something.

---

## Overview

nlpilot is a terminal-based AI coding assistant built on top of the [Vercel AI SDK](https://sdk.vercel.ai). It supports multiple LLM providers (OpenAI, Anthropic, Google, DeepSeek, Moonshot AI), extensible tools via MCP, and project-level customization through skills, agents, and hooks.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   CLI args  │────▶│   Command    │────▶│  REPL / OneShot │
│  (Commander)│     │   Router     │     │    Loop         │
└─────────────┘     └──────────────┘     └─────────────────┘
                                                  │
                           ┌──────────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   Session       │
                  │   (stateful)    │
                  └─────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
   │  Providers  │ │    Tools     │ │ Persistence  │
   │  (AI SDK)   │ │ (built-in +  │ │  (sessions)  │
   │             │ │   MCP)       │ │              │
   └─────────────┘ └──────────────┘ └──────────────┘
```

---

## Entry Point (`src/index.ts`)

- Parses CLI arguments with **Commander**.
- Registers sub-commands: `login`, `logout`, `models`, `init`, `mcp`, `help`.
- The default action starts either:
  - **`runOneShot()`** (if `--prompt` is passed) — single prompt, non-interactive.
  - **`startRepl()`** (default) — interactive read-eval-print loop.
- Ensures the config directory (`~/.nlpilot`) exists before any command runs.

---

## Session Lifecycle (`src/session.ts`)

A `Session` is the central state object that lives for the duration of a REPL run or one-shot invocation.

**Key fields:**
- `messages` — conversation history in Vercel AI SDK `ModelMessage` format.
- `creds` — resolved provider credentials (API key, model, optional baseUrl).
- `languageModel` — the instantiated AI SDK model client.
- `fileChanges` — tracked mutations for `/undo` and `/diff`.
- `instructions`, `agents`, `skills`, `hooks` — project customization loaded from disk.
- `mode` — `ask` | `plan` | `autopilot` (controls tool approval behavior).
- `cumulativeInputTokens` / `cumulativeOutputTokens` — token usage across the session.

**System Prompt Builder (`buildSystemPrompt`)**
- Injects the base assistant persona.
- Appends the **context-efficiency rules** (banned bash patterns, view/grep guidance).
- Appends the mode note (`ask` vs `plan` vs `autopilot`).
- Appends project `instructions` (from `.nlpilot/instructions.md`, `AGENTS.md`, etc.).
- Appends the `skills` index so the model knows what skills are available.

**Message Trimming (`trimMessagesForSending`)**
- Before each API call, old tool-result messages are compressed to prevent context-window bloat.
- Keeps the most recent assistant turn fully intact.
- Large outputs (>800 chars) are truncated with a stub message. Error outputs get a higher cap (1,500 chars).

---

## Provider Abstraction (`src/providers.ts`)

- **`getModel(creds, override?)`** returns a Vercel AI SDK `LanguageModel`.
- If `creds.baseUrl` is set (e.g., Azure Foundry), it instantiates a provider directly (`createAnthropic` or `createOpenAI`) with the custom base URL.
- Otherwise, it uses `@ai-sdk/gateway` and qualifies the model name as `<provider>/<model-id>`.
- Provider inference from model prefixes (e.g., `gpt-*` → OpenAI, `claude-*` → Anthropic) ensures correct routing even when the stored credential provider differs.

**Catalog (`src/models.ts`)**
- `models.json` in `~/.nlpilot` stores the curated model list.
- A fallback embedded catalog exists for first-run initialization.
- `getModelContextSize()` lets the UI warn when a conversation nears the context limit.

---

## Tool System (`src/tools/index.ts`)

Built-in tools are plain Vercel AI SDK `tool()` definitions:

| Tool | Purpose | Approval Required |
|---|---|---|
| `view` | Read file lines | No |
| `bash` | Execute shell commands | Yes |
| `edit` | String-replace patch | Yes |
| `create` | Write new file | Yes |
| `list_dir` | Directory listing | No |
| `glob` | File glob search | No |
| `grep` | Content regex search | No |

**Safety mechanisms:**
- `resolveInsideCwd()` rejects paths that escape the working directory.
- `view` tracks `viewedFiles` per turn to prevent redundant reads; `editedFiles` allows re-view after mutation.
- `bash` blocks commands that should use dedicated tools (`ls`, `cat`, `grep`, etc.).
- All mutating tools go through `requestApproval()`.

**MCP Integration (`src/tools/mcp.ts`, `src/mcp.ts`)**
- `loadEffectiveMcpConfig()` merges global `~/.nlpilot/mcp.json` + project `.mcp.json`.
- `startMcpRuntime()` spawns stdio-based MCP servers and exposes their tools as AI SDK `tool()` objects.
- MCP tool names are dynamically merged into the built-in tool set at REPL startup.

---

## REPL Loop (`src/commands/repl.ts`)

1. **Resolve credentials** — exit early if none.
2. **Restore session** — if `--continue`, load the most recent persisted messages.
3. **Load customization** — instructions, agents, skills, hooks.
4. **Pre-scan source files** — glob `**/*.{ts,tsx,js,jsx,json,md}` (max 300) and inject into the session so the model never needs discovery tool calls.
5. **Start MCP runtime** — merge external tools.
6. **Readline loop** — for each user input:
   - Detect slash commands (`/help`, `/model`, `/compact`, etc.) and handle via `runSlashCommand()`.
   - Otherwise stream the model response with `streamText()`.
   - As the model emits tool calls, execute them immediately (with approval checks) and stream the results back.
   - Record file changes, update token counters, and auto-compact if the context window is nearly full.
7. **Persist** — save the session to disk after each turn.

---

## Customization System (`src/customization.ts`)

**Skills**
- Loaded from `.nlpilot/skills/<name>/SKILL.md`.
- Frontmatter metadata (`name`, `description`) + markdown body.
- Injected into the system prompt as an index; invoked by the model via `/SKILL-NAME`.

**Custom Agents**
- Loaded from `.nlpilot/agents/*.md`.
- Frontmatter can specify `model`, `tools`, `description`.
- Agents are listed in the system prompt but not yet auto-invoked (extensibility point).

**Instructions**
- Loaded from `.nlpilot/instructions.md`, `AGENTS.md`, or `INSTRUCTIONS.md` in the project root.
- Large instruction files (>60k chars) are truncated with a warning.

---

## Hooks (`src/hooks.ts`)

Lifecycle hooks live in `.nlpilot/hooks/hooks.json` or `config.json`.

Supported events:
- `sessionStart`
- `preToolUse`
- `postToolUse`
- `agentStop`

Hook types:
- `command` — spawns a shell command with environment variables (`NLPILOT_HOOK_TOOL`, etc.).
- `http` — POSTs a JSON payload to a URL.

Hooks are fire-and-forget: failures are silently swallowed so they can never crash the REPL.

---

## Persistence (`src/persistence.ts`)

- Sessions are stored in `~/.nlpilot/sessions/<cwd-hash>/`.
- Each session is a JSON file containing messages, metadata, and token counts.
- `saveSession()` is called after every turn.
- `--continue` loads the most recent session for the current working directory.

---

## Token Management (`src/telemetry/TokenTracker.ts`)

- Tracks cumulative input/output tokens across the session.
- Provides `estimateTokens()` for local context-window heuristics.
- `/compact` summarizes old conversation history to free up context tokens.

---

## Common Extension Points

| Want to... | Look at... |
|---|---|
| Add a new CLI flag or sub-command | `src/index.ts`, `src/commands/*.ts` |
| Add a new built-in tool | `src/tools/index.ts` |
| Add a new LLM provider | `src/providers.ts`, `src/models.ts`, `src/config.ts` |
| Change the system prompt | `src/session.ts` → `buildSystemPrompt()` |
| Add a new slash command | `src/commands/slash.ts` |
| Customize per-project behavior | `.nlpilot/instructions.md`, `.nlpilot/skills/`, `.nlpilot/hooks/` |
| Integrate external tools | `.mcp.json` or `~/.nlpilot/mcp.json` |

---

## Data Flow Diagram (Single Turn)

```
User input
    │
    ▼
┌─────────────┐
│  Slash cmd? │──Yes──▶ runSlashCommand() ──▶ done
└─────────────┘
    │ No
    ▼
┌─────────────────────────────┐
│  trimMessagesForSending()   │
│  (compress old tool results)│
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  streamText({               │
│    model, system, messages, │
│    tools, maxSteps          │
│  })                         │
└─────────────────────────────┘
    │
    ▼
Model streams text / tool calls
    │
    ├─ Text ──────────────────────▶ stdout
    │
    └─ Tool call ─────────────────▶ execute tool
           │                          │
           │                          ▼
           │                   approval check
           │                          │
           │                          ▼
           │                   record file change
           │                          │
           └────────────────────── result back to model
    │
    ▼
Save session to disk
```
