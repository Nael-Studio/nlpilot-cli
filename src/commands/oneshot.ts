import { stdout } from "node:process";
import { streamText, stepCountIs } from "ai";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel } from "../providers.ts";
import { buildTools } from "../tools/index.ts";
import {
  createApprovalState,
  type ApprovalState,
} from "../tools/approval.ts";
import {
  buildSystemPrompt,
  trimMessagesForSending,
  loadCustomization,
  type Session,
} from "../session.ts";
import {
  loadMostRecentSession,
  newSessionId,
  saveSession,
} from "../persistence.ts";
import { loadEffectiveMcpConfig, mergeAdditionalMcpConfig } from "../mcp.ts";
import { startMcpRuntime } from "../tools/mcp.ts";

export type OutputFormat = "text" | "json";

export interface OneShotOptions {
  prompt: string;
  model?: string;
  silent?: boolean;
  outputFormat?: OutputFormat;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
  continueSession?: boolean;
  enableReasoningSummaries?: boolean;
  additionalMcpConfig?: string;
}

interface JsonEvent {
  type:
    | "message"
    | "tool-call"
    | "tool-result"
    | "text"
    | "error"
    | "done";
  data?: unknown;
}

function emitJson(event: JsonEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const creds = await resolveCredentials();
  if (!creds) {
    if (opts.outputFormat === "json") {
      emitJson({ type: "error", data: { message: "No credentials. Run nlpilot login." } });
    } else {
      console.error("✗ No credentials. Run `nlpilot login` first.");
    }
    return 1;
  }

  const modelName = opts.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  // Restore prior conversation if --continue
  let priorMessages: Session["messages"] = [];
  let priorId: string | undefined;
  let priorCreatedAt: number | undefined;
  if (opts.continueSession) {
    const prior = await loadMostRecentSession();
    if (prior) {
      priorMessages = prior.messages;
      priorId = prior.id;
      priorCreatedAt = prior.createdAt;
    }
  }

  const customization = await loadCustomization();
  const session: Session = {
    id: priorId ?? newSessionId(),
    createdAt: priorCreatedAt ?? Date.now(),
    creds,
    modelName,
    languageModel: getModel(creds, modelName),
    messages: priorMessages,
    mode: opts.allowAll ? "autopilot" : "ask",
    theme: "default",
    turn: 0,
    fileChanges: [],
    lastAssistantText: "",
    instructions: customization.instructions,
    agents: customization.agents,
    skills: customization.skills,
    hooks: customization.hooks,
    enableReasoningSummaries: opts.enableReasoningSummaries,
    additionalMcpConfig: opts.additionalMcpConfig,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
  };

  const approvals: ApprovalState = createApprovalState({
    autopilot: opts.allowAll,
    allow: opts.allow,
    deny: opts.deny,
    nonInteractive: true, // no readline in one-shot
  });

  // Non-interactive prompt: any tool that would prompt gets denied unless pre-allowed.
  const promptFn = async (): Promise<string> => "n";

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

  // Bring up MCP runtime (global + project .mcp.json + additional) and merge its tools.
  let mcpConfig = await loadEffectiveMcpConfig();
  mcpConfig = await mergeAdditionalMcpConfig(mcpConfig, opts.additionalMcpConfig);
  const mcp = await startMcpRuntime(mcpConfig.servers);
  Object.assign(tools, mcp.tools);

  session.turn += 1;
  session.messages.push({ role: "user", content: opts.prompt });

  const isJson = opts.outputFormat === "json";
  const isSilent = opts.silent ?? false;

  try {
    const result = streamText({
      model: session.languageModel,
      system: buildSystemPrompt(session),
      messages: trimMessagesForSending(session.messages),
      tools,
      stopWhen: stepCountIs(20),
    });

    let assistantText = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        assistantText += part.text;
        if (isJson) {
          emitJson({ type: "text", data: part.text });
        } else {
          stdout.write(part.text);
        }
      } else if (part.type === "tool-call") {
        if (isJson) {
          emitJson({
            type: "tool-call",
            data: { toolName: part.toolName, input: part.input },
          });
        } else if (!isSilent) {
          process.stderr.write(`\n  → ${part.toolName}\n`);
        }
      } else if (part.type === "tool-result") {
        if (isJson) {
          emitJson({
            type: "tool-result",
            data: { toolName: part.toolName, output: part.output },
          });
        }
      } else if (part.type === "error") {
        let message: string;
        if (part.error instanceof Error) message = part.error.message;
        else if (typeof part.error === "object" && part.error !== null)
          message = JSON.stringify(part.error);
        else message = String(part.error);
        if (isJson) emitJson({ type: "error", data: { message } });
        else process.stderr.write(`\n✗ ${message}\n`);
      }
    }

    if (!isJson) stdout.write("\n");
    session.lastAssistantText = assistantText;
    const responseMessages = (await result.response).messages;
    session.messages.push(...responseMessages);

    await saveSession({
      id: session.id,
      cwd: process.cwd(),
      modelName,
      provider: creds.provider,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      messages: session.messages,
    });

    if (isJson) emitJson({ type: "done" });
    await mcp.shutdown();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) emitJson({ type: "error", data: { message } });
    else console.error("✗ Error:", message);
    await mcp.shutdown();
    return 1;
  }
}
