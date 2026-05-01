# Adding a New Command

This guide walks you through adding a new top-level or slash command to nlpilot.

---

## Top-Level CLI Commands

Top-level commands are registered in `src/index.ts` via Commander (e.g., `nlpilot deploy`, `nlpilot status`).

### 1. Create the command file

Add `src/commands/<name>.ts`:

```typescript
import kleur from "kleur";

export interface MyCommandOptions {
  verbose?: boolean;
}

export async function myCommand(options: MyCommandOptions = {}): Promise<void> {
  if (options.verbose) {
    console.log(kleur.dim("Running in verbose mode..."));
  }
  console.log("Hello from my command!");
}
```

### 2. Register it in `src/index.ts`

```typescript
import { myCommand } from "./commands/myCommand.ts";

program
  .command("my-cmd")
  .description("What this command does")
  .option("-v, --verbose", "Enable verbose output")
  .action(async (opts) => {
    await myCommand(opts);
  });
```

### 3. Guidelines

- Keep side effects minimal. If the command needs a model, accept `Credentials` as a parameter rather than reading config directly.
- Return a numeric exit code from one-shot style commands; REPL-style commands should not call `process.exit()`.
- Use `kleur` for colors, but respect a `--silent` flag if you add one.

---

## REPL Slash Commands

Slash commands run inside an active session (e.g., `/my-cmd`).

### 1. Add the handler in `src/commands/slash.ts`

Find the `runSlashCommand` function and add a new branch:

```typescript
case "/my-cmd": {
  const arg = args[0];
  console.log("Running /my-cmd with arg:", arg);
  // Mutate session if needed
  return true; // true = continue REPL, false = exit
}
```

### 2. Register help text

In the same file, add an entry to the help map so `/help` shows it:

```typescript
const SLASH_HELP = [
  // ... existing entries
  { cmd: "/my-cmd [arg]", desc: "Description of what it does" },
];
```

### 3. Accessing session state

`runSlashCommand` receives the full `Session` object. You can read or mutate:
- `session.messages` — conversation history.
- `session.mode` — approval mode.
- `session.fileChanges` — tracked mutations.

If you mutate `session.messages`, the next model turn will see the new state automatically.

---

## Testing

1. Run `bun run typecheck`.
2. Test the command: `bun run src/index.ts my-cmd`.
3. For slash commands, start the REPL and type `/my-cmd`.

---

## Example: Adding `/stats`

```typescript
// In src/commands/slash.ts
case "/stats": {
  console.log(`Messages: ${session.messages.length}`);
  console.log(`Turns: ${session.turn}`);
  console.log(`File changes: ${session.fileChanges.length}`);
  console.log(`Input tokens: ${session.cumulativeInputTokens}`);
  return true;
}
```

Add to help:
```typescript
{ cmd: "/stats", desc: "Show session statistics" },
```
