# Contributing to nlpilot

Thank you for your interest in making nlpilot better! This document covers how to set up your development environment, submit changes, and follow our coding standards.

---

## Development Setup

**Requirements**
- [Bun](https://bun.sh) v1.x or later
- Git

**Install dependencies**
```bash
git clone <repo>
cd nlpilot-cli
bun install
```

**Run from source**
```bash
bun run src/index.ts
# or
bun run dev
```

**Type-check**
```bash
bun run typecheck
```

**Build a single-file binary**
```bash
bun run build
```

---

## Project Structure

```
src/
├── index.ts              # CLI entry point (Commander setup)
├── commands/             # Sub-commands and REPL loop
├── session.ts            # Session state, system prompt builder
├── config.ts             # Credentials, provider defaults
├── providers.ts          # Vercel AI SDK provider factory
├── models.ts             # Model catalog loader
├── tools/                # Built-in agent tools (bash, view, edit, etc.)
├── mcp.ts                # MCP configuration loader
├── customization.ts      # Skills & custom agents loader
├── hooks.ts              # Lifecycle hooks
├── persistence.ts        # Session save/load on disk
└── ui/                   # Terminal UI helpers
```

---

## How to Contribute

1. **Open an issue first** for large changes (new commands, provider support, architecture shifts).
2. **Fork and branch**: `git checkout -b feature/your-feature-name`
3. **Write code** that matches the existing style (see below).
4. **Test your changes** manually in the REPL and one-shot mode.
5. **Commit**: use clear, imperative commit messages (`Add retry logic to provider calls`).
6. **Open a Pull Request** with a concise description and linked issue if applicable.

---

## Coding Standards

### TypeScript
- Use strict types; avoid `any`. Prefer `unknown` with runtime checks.
- Use `interface` for public shapes, `type` for unions/utility types.
- Prefer `async/await` over raw Promises.
- File paths: use `node:path` and `node:fs/promises`.

### Tool Implementations
If you add or modify a tool in `src/tools/index.ts`:
- Use `zod` for `inputSchema` validation.
- Cap output size (see `MAX_OUTPUT`, `MAX_GREP_OUTPUT` constants).
- Reject path-escaping inputs via `resolveInsideCwd()`.
- Log tool calls with `logToolCall()` so users see what's happening.
- Add approval gating for any destructive operation (write, edit, bash).

### Error Handling
- Never let a tool crash the REPL loop. Return `{ error: string }` instead.
- Hooks must never throw (they are fire-and-forget).
- Catch and surface file-system errors with human-readable messages.

### UI / Output
- Use `kleur` for colors. Respect the `--silent` flag.
- Keep output concise in non-interactive mode (`--prompt`).
- Approval prompts must use a dedicated `readline` interface (not the main REPL `rl`) to avoid deadlocks.

---

## Testing

We do not yet have an automated test suite. Until one is added, verify your changes with these manual checks:

- [ ] `bun run typecheck` passes with zero errors.
- [ ] `nlpilot login` works for your provider.
- [ ] `nlpilot -p "hello"` runs in one-shot mode.
- [ ] `nlpilot` starts the REPL and responds to prompts.
- [ ] Slash commands (`/help`, `/model`, `/compact`) work.
- [ ] Tool approvals appear for `bash`, `write_file`, and `edit_file`.
- [ ] `--allow-all-tools` skips approvals.
- [ ] `--continue` restores the previous session.

---

## Commit Message Format

```
<type>: <short summary>

<body — optional, describe what and why>
```

Types:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `refactor:` code change that neither fixes a bug nor adds a feature
- `chore:` build process, dependencies, tooling

---

## Questions?

Open a discussion issue or reach out in the project's issue tracker.
