import { stdout } from "node:process";
import * as readline from "node:readline/promises";
import { streamText, generateText, stepCountIs } from "ai";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel } from "../providers.ts";
import { resolveRoutedModel } from "../model-router.ts";
import { getModelContextSize } from "../models.ts";
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
import { startLoader, stopLoader, stopLoaderWithMessage } from "../ui/loader.ts";
import { buildCompactTranscript } from "./compact.ts";

export type OutputFormat = "text" | "json";

export interface OneShotOptions {
  prompt: string;
  compact?: boolean;
  model?: string;
  silent?: boolean;
  outputFormat?: OutputFormat;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
  continueSession?: boolean;
  enableReasoningSummaries?: boolean;
  additionalMcpConfig?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  mcp?: boolean;
  modelRouting?: boolean;
  interactiveApprovals?: boolean;
}

interface JsonEvent {
  type:
    | "message"
    | "tool-call"
    | "tool-result"
    | "approval-request"
    | "text"
    | "usage"
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

  // ── Compact mode ─────────────────────────────────────────────────────────────
  // Load the most recent session, stream a summarization, then rewrite the
  // session messages on disk so the next --continue uses the compact context.
  if (opts.compact) {
    const prior = await loadMostRecentSession();
    if (!prior || prior.messages.length === 0) {
      if (opts.outputFormat === "json") {
        emitJson({ type: "text", data: "Nothing to compact." });
        emitJson({ type: "done" });
      } else {
        console.log("Nothing to compact.");
      }
      return 0;
    }

    const modelName = opts.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];
    const languageModel = getModel(creds, modelName);
    const isJson = opts.outputFormat === "json";
    const isSilent = opts.silent ?? false;
    const transcript = buildCompactTranscript(prior.messages);

    if (!isJson && !isSilent) startLoader("Compacting...");
    const result = await generateText({
      model: languageModel,
      system: "You are a conversation summarizer. Produce a concise but information-dense summary of the prior assistant/user turns. Preserve decisions, file paths touched, code changes made, and open TODOs. Do not invent details. Reply with only the summary text.",
      messages: [{ role: "user", content: `Summarize the following conversation:\n\n${transcript}` }],
    });
    if (!isJson && !isSilent) stopLoader();

    const summaryText = result.text.trim();
    if (summaryText) {
      await saveSession({
        ...prior,
        messages: [
          { role: "user", content: `Summary of prior conversation:\n${summaryText}` },
          { role: "assistant", content: "Acknowledged. Continuing from this summary." },
        ],
        updatedAt: Date.now(),
      });
    }

    if (isJson) {
      emitJson({ type: "text", data: "Conversation compacted." });
      emitJson({
        type: "usage",
        data: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          cumulativeInputTokens: result.usage.inputTokens ?? 0,
          cumulativeOutputTokens: result.usage.outputTokens ?? 0,
          cumulativeTotalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          sessionId: prior.id,
          modelName,
          provider: creds.provider,
        },
      });
      emitJson({ type: "done" });
    } else {
      console.log("✓ Conversation compacted.");
    }
    return 0;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const explicitModel = Boolean(opts.model || process.env.NLPILOT_MODEL);
  const shouldRouteModel = opts.modelRouting !== false && !explicitModel && !creds.baseUrl;
  const modelName = shouldRouteModel
    ? resolveRoutedModel(creds, opts.prompt, opts.allowAll ? "autopilot" : "ask").modelName
    : opts.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  // Restore prior conversation if --continue
  let priorMessages: Session["messages"] = [];
  let priorId: string | undefined;
  let priorCreatedAt: number | undefined;
  let priorInputTokens = 0;
  let priorOutputTokens = 0;
  if (opts.continueSession) {
    const prior = await loadMostRecentSession();
    if (prior) {
      priorMessages = prior.messages;
      priorId = prior.id;
      priorCreatedAt = prior.createdAt;
      priorInputTokens = prior.cumulativeInputTokens ?? 0;
      priorOutputTokens = prior.cumulativeOutputTokens ?? 0;
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
    cumulativeInputTokens: priorInputTokens,
    cumulativeOutputTokens: priorOutputTokens,
  };

  const approvals: ApprovalState = createApprovalState({
    autopilot: opts.allowAll,
    allow: opts.allow,
    deny: opts.deny,
    nonInteractive: !opts.interactiveApprovals,
    silentPrompts: opts.outputFormat === "json",
  });

  let approvalReader: readline.Interface | undefined;
  const promptFn = async (
    _question: string,
    request?: { toolName: string; summary: string; details?: string },
  ): Promise<string> => {
    if (!opts.interactiveApprovals || !request) return "n";

    if (opts.outputFormat === "json") {
      emitJson({
        type: "approval-request",
        data: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          toolName: request.toolName,
          summary: request.summary,
          details: request.details,
        },
      });
    }

    approvalReader ??= readline.createInterface({
      input: process.stdin,
      output: undefined,
      terminal: false,
    });
    return await approvalReader.question("");
  };

  const tools = buildTools({
    approvals,
    prompt: promptFn,
    logToolCalls: opts.outputFormat !== "json" && opts.silent !== true,
    viewedFiles: new Set<string>(),
    editedFiles: new Set<string>(),
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

  let shutdownMcp = async (): Promise<void> => undefined;
  if (opts.mcp !== false) {
    // Bring up MCP runtime (global + project .mcp.json + additional) and merge its tools.
    let mcpConfig = await loadEffectiveMcpConfig();
    mcpConfig = await mergeAdditionalMcpConfig(mcpConfig, opts.additionalMcpConfig);
    const mcp = await startMcpRuntime(mcpConfig.servers, {
      approvals,
      prompt: promptFn,
    });
    Object.assign(tools, mcp.tools);
    shutdownMcp = mcp.shutdown;
  }

  session.turn += 1;
  session.messages.push({ role: "user", content: opts.prompt });

  const isJson = opts.outputFormat === "json";
  const isSilent = opts.silent ?? false;

  try {
    if (!isJson && !isSilent) {
      startLoader("Thinking...");
    }
    const result = streamText({
      model: session.languageModel,
      system: buildSystemPrompt(session, { latestUserMessage: opts.prompt }),
      messages: trimMessagesForSending(session.messages),
      tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 100),
      maxOutputTokens: opts.maxOutputTokens,
    });

    let assistantText = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        if (!isJson && !isSilent) stopLoader();
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
          stopLoader();
          process.stderr.write(`\n  → ${part.toolName}\n`);
          startLoader(`Running ${part.toolName}...`);
        }
      } else if (part.type === "tool-result") {
        if (!isJson && !isSilent) stopLoader();
        if (isJson) {
          emitJson({
            type: "tool-result",
            data: { toolName: part.toolName, output: part.output },
          });
        }
      } else if (part.type === "error") {
        stopLoader();
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
    const [response, usage] = await Promise.all([result.response, result.totalUsage]);
    const responseMessages = response.messages;
    session.messages.push(...responseMessages);
    session.cumulativeInputTokens += usage.inputTokens ?? 0;
    session.cumulativeOutputTokens += usage.outputTokens ?? 0;

    await saveSession({
      id: session.id,
      cwd: process.cwd(),
      modelName,
      provider: creds.provider,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      messages: session.messages,
      cumulativeInputTokens: session.cumulativeInputTokens,
      cumulativeOutputTokens: session.cumulativeOutputTokens,
    });

    if (isJson) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const contextSize = getModelContextSize(creds.provider, modelName);
      const cumulativeTotalTokens =
        session.cumulativeInputTokens + session.cumulativeOutputTokens;
      emitJson({
        type: "usage",
        data: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cumulativeInputTokens: session.cumulativeInputTokens,
          cumulativeOutputTokens: session.cumulativeOutputTokens,
          cumulativeTotalTokens,
          contextSize,
          contextPercentage: contextSize > 0
            ? (cumulativeTotalTokens / contextSize) * 100
            : undefined,
          modelName,
          provider: creds.provider,
          sessionId: session.id,
          isEstimate: false,
        },
      });
    }

    if (isJson) emitJson({ type: "done" });
    approvalReader?.close();
    await shutdownMcp();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) emitJson({ type: "error", data: { message } });
    else console.error("✗ Error:", message);
    approvalReader?.close();
    await shutdownMcp();
    return 1;
  }
}
