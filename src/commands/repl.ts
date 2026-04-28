import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { streamText, stepCountIs } from "ai";
import kleur from "kleur";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel, PROVIDER_LABELS } from "../providers.ts";
import { buildTools } from "../tools/index.ts";
import { createApprovalState } from "../tools/approval.ts";
import {
  buildSystemPrompt,
  loadCustomization,
  type Session,
} from "../session.ts";
import { buildHelpPrinter, runSlashCommand } from "./slash.ts";
import {
  loadMostRecentSession,
  newSessionId,
  saveSession,
} from "../persistence.ts";
import { runHooks } from "../hooks.ts";
import { runAutoCompact, estimateTokens } from "./compact.ts";
import { loadEffectiveMcpConfig, loadProjectMcpConfig, getProjectMcpConfigPath } from "../mcp.ts";
import { startMcpRuntime } from "../tools/mcp.ts";

interface ReplOptions {
  model?: string;
  continueSession?: boolean;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const creds = await resolveCredentials();
  if (!creds) {
    console.log(
      kleur.red("✗"),
      "No credentials found. Run",
      kleur.bold("nlpilot login"),
      "first.",
    );
    process.exitCode = 1;
    return;
  }

  const modelName = options.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  let priorMessages: Session["messages"] = [];
  let priorId: string | undefined;
  let priorName: string | undefined;
  let priorCreatedAt: number | undefined;
  if (options.continueSession) {
    const prior = await loadMostRecentSession();
    if (prior) {
      priorMessages = prior.messages;
      priorId = prior.id;
      priorName = prior.name;
      priorCreatedAt = prior.createdAt;
      console.log(
        kleur.dim(`Restored ${prior.messages.length} messages from session ${prior.name ?? prior.id}.`),
      );
    }
  }

  const customization = await loadCustomization();
  const session: Session = {
    id: priorId ?? newSessionId(),
    name: priorName,
    createdAt: priorCreatedAt ?? Date.now(),
    creds,
    modelName,
    languageModel: getModel(creds, modelName),
    messages: priorMessages,
    mode: options.allowAll ? "autopilot" : "ask",
    theme: "default",
    turn: 0,
    fileChanges: [],
    lastAssistantText: "",
    instructions: customization.instructions,
    agents: customization.agents,
    skills: customization.skills,
    hooks: customization.hooks,
  };

  await runHooks(session.hooks, "sessionStart", { sessionId: session.id, cwd: process.cwd() });

  printBanner(session);
  await announceProjectMcp();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const approvals = createApprovalState({
    autopilot: options.allowAll,
    allow: options.allow,
    deny: options.deny,
  });
  const promptFn = (q: string): Promise<string> => rl.question(q);
  const tools = buildTools({
    approvals,
    prompt: promptFn,
    recorder: {
      record: (change) => {
        session.fileChanges.push({
          ...change,
          turn: session.turn,
          timestamp: Date.now(),
        });
      },
    },
  });

  // Bring up MCP runtime (global + project .mcp.json) and merge its tools.
  const mcpConfig = await loadEffectiveMcpConfig();
  const mcp = await startMcpRuntime(mcpConfig.servers);
  Object.assign(tools, mcp.tools);
  const mcpToolNames = Object.keys(mcp.tools);
  if (mcpToolNames.length > 0) {
    console.log(
      kleur.dim(
        `MCP tools available: ${mcpToolNames.join(", ")}`,
      ),
    );
  }

  const printHelp = buildHelpPrinter();

  let shouldExit = false;
  const slashCtx = {
    session,
    approvals,
    printHelp,
    setShouldExit: () => {
      shouldExit = true;
    },
  };

  const cleanup = (): void => {
    rl.close();
    console.log();
    console.log(kleur.dim("bye 👋"));
  };

  rl.on("SIGINT", () => {
    void mcp.shutdown().finally(() => {
      cleanup();
      process.exit(0);
    });
  });

  // Ctrl+L → clear screen
  if (stdin.isTTY) {
    stdin.on("keypress", (_str, key) => {
      if (key?.ctrl && key.name === "l") {
        stdout.write("\x1Bc");
      }
    });
  }

  while (!shouldExit) {
    let userInput: string;
    try {
      userInput = await rl.question(promptString(session));
    } catch {
      cleanup();
      return;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // ? → quick help
    if (trimmed === "?") {
      printHelp();
      continue;
    }

    // /command
    if (trimmed.startsWith("/")) {
      await runSlashCommand(slashCtx, trimmed);
      continue;
    }

    // !command → shell passthrough
    if (trimmed.startsWith("!")) {
      await runShellPassthrough(trimmed.slice(1).trim());
      continue;
    }

    // @file expansion (any token starting with @)
    const expanded = await expandAttachments(trimmed);

    session.turn += 1;
    session.messages.push({ role: "user", content: expanded });

    try {
      const result = streamText({
        model: session.languageModel,
        system: buildSystemPrompt(session),
        messages: session.messages,
        tools,
        stopWhen: stepCountIs(20),
      });

      stdout.write(kleur.green("● "));
      let assistantText = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          assistantText += part.text;
          stdout.write(part.text);
        } else if (part.type === "tool-call") {
          stdout.write("\n" + kleur.dim(`  → ${part.toolName}`) + "\n");
          await runHooks(session.hooks, "preToolUse", {
            toolName: part.toolName,
            input: part.input,
            sessionId: session.id,
            cwd: process.cwd(),
          });
        } else if (part.type === "tool-result") {
          await runHooks(session.hooks, "postToolUse", {
            toolName: part.toolName,
            output: part.output,
            sessionId: session.id,
            cwd: process.cwd(),
          });
        } else if (part.type === "error") {
          const message =
            part.error instanceof Error ? part.error.message : String(part.error);
          console.error("\n" + kleur.red("✗ Stream error:"), message);
        }
      }
      stdout.write("\n\n");

      session.lastAssistantText = assistantText;
      const responseMessages = (await result.response).messages;
      session.messages.push(...responseMessages);

      await saveSession({
        id: session.id,
        name: session.name,
        cwd: process.cwd(),
        modelName: session.modelName,
        provider: session.creds.provider,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages,
      });

      // Auto-compact when approaching context window cap.
      if (estimateTokens(session.messages) > 180_000) {
        console.log(kleur.dim("Context approaching limit — auto-compacting…"));
        await runAutoCompact(session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(kleur.red("✗ Error:"), message);
      session.messages.pop();
    }
  }

  await runHooks(session.hooks, "agentStop", { sessionId: session.id, cwd: process.cwd() });
  await mcp.shutdown();
  cleanup();
}

function promptString(session: Session): string {
  let modeTag = "";
  if (session.mode === "autopilot") modeTag = kleur.red("[auto] ");
  else if (session.mode === "plan") modeTag = kleur.yellow("[plan] ");
  return modeTag + kleur.cyan("› ");
}

function printBanner(session: Session): void {
  console.log(
    kleur.bold().magenta("nlpilot"),
    kleur.dim("·"),
    `${PROVIDER_LABELS[session.creds.provider] ?? session.creds.provider}`,
    kleur.dim("·"),
    kleur.bold(session.modelName),
    kleur.dim("·"),
    `mode: ${session.mode}`,
  );
  console.log(
    kleur.dim(
      "Type /help for commands, ? for quick help, /exit to quit.",
    ),
  );
  if (session.instructions.files.length > 0) {
    console.log(
      kleur.dim(
        `Loaded instructions: ${session.instructions.files.map((f) => f.path).join(", ")}`,
      ),
    );
  }
  console.log();
}

async function announceProjectMcp(): Promise<void> {
  const cfg = await loadProjectMcpConfig();
  if (cfg.servers.length === 0) return;
  const names = cfg.servers.map((s) => s.name).join(", ");
  console.log(
    kleur.dim(
      `MCP project config: ${getProjectMcpConfigPath()} → ${names}`,
    ),
  );
  console.log();
}

async function runShellPassthrough(command: string): Promise<void> {
  if (!command) {
    console.log(kleur.yellow("Usage: !<shell command>"));
    return;
  }
  await new Promise<void>((resolveDone) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" });
    child.on("close", () => resolveDone());
    child.on("error", (err) => {
      console.error(kleur.red("✗"), err.message);
      resolveDone();
    });
  });
}

const ATTACHMENT_INLINE_BYTES = 8_000;

async function expandAttachments(input: string): Promise<string> {
  const tokens = input.match(/@\S+/g);
  if (!tokens) return input;

  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const tok of tokens) {
    const rel = tok.slice(1);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = pathResolve(process.cwd(), rel);
    try {
      const content = await readFile(abs, "utf8");
      if (content.length <= ATTACHMENT_INLINE_BYTES) {
        blocks.push(`# ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
        console.log(kleur.dim(`  ✎ attached ${rel} (${content.length} bytes)`));
      } else {
        const head = content.slice(0, ATTACHMENT_INLINE_BYTES);
        blocks.push(
          `# ${rel} (preview: first ${ATTACHMENT_INLINE_BYTES} of ${content.length} bytes — use the \`view\` tool on ${rel} for line ranges)\n\n\`\`\`\n${head}\n\`\`\``,
        );
        console.log(
          kleur.dim(
            `  ✎ attached ${rel} (preview ${ATTACHMENT_INLINE_BYTES}/${content.length} bytes)`,
          ),
        );
      }
    } catch (err) {
      console.log(
        kleur.yellow("  ⚠"),
        `couldn't read ${rel}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (blocks.length === 0) return input;
  return `${input}\n\n--- Attachments ---\n\n${blocks.join("\n\n")}`;
}
