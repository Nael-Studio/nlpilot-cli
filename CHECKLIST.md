# nlpilot — Implementation Checklist

A clone of GitHub Copilot CLI powered by the Vercel AI SDK.

---

## Phase 1 — Core Setup (MVP)

- [x] `nlpilot login` — Prompt for Vercel AI SDK API key, store securely in `~/.nlpilot/credentials` (keychain or encrypted file)
- [x] `nlpilot logout` — Clear stored API key
- [x] `nlpilot version` — Print version info
- [x] `nlpilot help [TOPIC]` — Display help; topics: config, commands, environment, permissions
- [x] Basic interactive session (`nlpilot` with no args) — REPL loop with streaming AI responses via Vercel AI SDK
- [x] Model selection — Support `NLPILOT_MODEL` env var and `--model` flag; default to a sensible provider default

---

## Phase 2 — Agentic Tools

- [x] **Shell tool** (`bash`) — Execute shell commands with user approval prompt before each run
- [x] **File view tool** — Read file/directory contents
- [x] **File edit tool** — String-replace edits to files (with diff preview)
- [x] **File create tool** — Create new files
- [x] **Glob tool** — Find files by pattern
- [x] **Grep tool** — Search text in files
- [x] **Web fetch tool** (`web_fetch`) — Fetch and parse web page content

---

## Phase 3 — Interactive Interface

- [x] **Slash commands** in REPL:
  - [x] `/clear` `/new` `/reset` — Start new conversation
  - [x] `/exit` `/quit` — Exit
  - [x] `/help` — Show interactive help
  - [x] `/model [MODEL]` — List or change AI model
  - [x] `/compact` — Summarize conversation to reduce context
  - [x] `/context` — Show token window usage
  - [x] `/copy` — Copy last response to clipboard
  - [x] `/diff` — Show file changes made this session
  - [x] `/undo` `/rewind` — Revert last turn's file changes
  - [x] `/instructions` — View loaded custom instruction files
  - [x] `/theme` — Switch color theme (default, dim, high-contrast)
  - [x] `/version` — Print version
- [x] `@FILENAME` context attachment — Include file contents inline in the prompt
- [x] `!COMMAND` passthrough — Execute shell directly, bypassing the AI
- [x] `?` quick help — Open help on empty prompt
- [~] **Keyboard shortcuts** — `Ctrl+C` cancel, `Ctrl+L` clear screen, `Ctrl+D` exit, `↑/↓` history navigation _(Shift+Enter newline pending raw-mode rewrite)_
- [x] **Mode switching** via `/mode ask|plan|autopilot` _(Shift+Tab cycle pending raw-mode rewrite)_
- [x] **Permission approval prompts** — `y` once / `!` always this session / `n` deny

---

## Phase 4 — Programmatic & Scripting

- [x] `-p PROMPT` / `--prompt` — Execute a single prompt non-interactively, then exit
- [x] `--allow-all-tools` / `--allow-all` — Skip all approval prompts (autopilot/CI use)
- [x] `--allow-tool=TOOL` / `--deny-tool=TOOL` — Fine-grained tool permission flags
- [x] `--silent` / `-s` — Output only the agent response (no stats), for scripting
- [x] `--output-format=json` — JSONL output mode for programmatic consumption
- [x] `--continue` — Resume most recent session in cwd

---

## Phase 5 — Project Customization

- [x] `nlpilot init` — Analyze codebase and generate `.nlpilot/instructions.md` (build, test, lint commands, architecture summary)
- [x] Custom instructions loading — Auto-read `.nlpilot/instructions.md` and `AGENTS.md` on startup
- [x] `/init` slash command — Run project init from within interactive session
- [x] **Session persistence** — Save/resume conversation sessions with IDs and names
- [x] `/session` management — `info`, `rename`, `delete`, `list`

---

## Phase 6 — Advanced / Extensibility

- [x] **MCP server support** (`nlpilot mcp`) — `add`, `remove`, `list`, `get` subcommands; local stdio + remote HTTP/SSE; project-scoped `.mcp.json` auto-loaded
- [x] `nlpilot mcp add <name>` — Interactive MCP server config wizard
- [x] **Custom agents** — Load `.nlpilot/agents/*.md` with model, tools, and description frontmatter
- [x] **Skills system** — Load `.nlpilot/skills/*/SKILL.md`; invoke via `/skill <name>` or auto-delegation
- [x] **Hooks system** — `preToolUse`, `postToolUse`, `sessionStart`, `agentStop` lifecycle hooks from `.nlpilot/hooks/*.json` (command + HTTP types)
- [x] **Plan mode** — Analyze request, ask clarifying questions, generate structured plan before executing
- [x] `/plan` slash command — Explicit planning before coding
- [x] **Context auto-compaction** — Auto-compact at 95% token usage
- [x] `/compact` manual compaction

---

## `nlpilot login` — Design Spec

```
$ nlpilot login

? Enter your Vercel AI SDK API key: ••••••••••••••••
? Select default provider:
  ❯ OpenAI
    Anthropic
    Google
    Custom base URL

✓ Key stored securely in ~/.nlpilot/credentials
✓ Provider: openai  Model: gpt-4o
```

- Key stored in OS keychain via `keytar`, with plaintext fallback to `~/.nlpilot/credentials` (mode 600)
- Environment variable `NLPILOT_API_KEY` takes precedence at runtime

---

## Suggested Tech Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js / Bun |
| CLI framework | `commander` or `clipanion` |
| Interactive REPL | `ink` (React for terminal) or `@inquirer/prompts` |
| AI layer | Vercel AI SDK (`ai` package) with streaming |
| Secure storage | `keytar` |
| Config directory | `~/.nlpilot/` |
