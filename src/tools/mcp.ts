import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import kleur from "kleur";
import pkg from "../../package.json" with { type: "json" };
import type { MCPServer } from "../mcp.ts";
import {
  requestApproval,
  type ApprovalState,
  type PromptFn,
} from "./approval.ts";

interface ConnectedMCP {
  name: string;
  client: Client;
  close: () => Promise<void>;
}

export interface MCPRuntime {
  tools: ToolSet;
  servers: ConnectedMCP[];
  /** Map AI-SDK tool name → originating MCP server name (for display + hooks). */
  toolOrigins: Record<string, string>;
  shutdown: () => Promise<void>;
}

interface MCPRuntimeOptions {
  approvals: ApprovalState;
  prompt: PromptFn;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_MCP_DESCRIPTION_CHARS = 300;
const MAX_SCHEMA_DESCRIPTION_CHARS = 160;
const DROPPED_SCHEMA_KEYS = new Set(["$schema", "examples", "example"]);

function sanitizeToolName(serverName: string, toolName: string): string {
  const raw = `${serverName}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return TOOL_NAME_RE.test(raw) ? raw : `mcp_${raw.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function compactDescription(description: string): string {
  const compact = description.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= MAX_MCP_DESCRIPTION_CHARS) return compact;
  return `${compact.slice(0, MAX_MCP_DESCRIPTION_CHARS)}...`;
}

function compactSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchemaValue);
  if (typeof value !== "object" || value === null) return value;

  const compact: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "description" && typeof nested === "string") {
      const normalized = nested.replaceAll(/\s+/g, " ").trim();
      compact[key] =
        normalized.length > MAX_SCHEMA_DESCRIPTION_CHARS
          ? `${normalized.slice(0, MAX_SCHEMA_DESCRIPTION_CHARS)}...`
          : normalized;
      continue;
    }
    compact[key] = compactSchemaValue(nested);
  }
  return compact;
}

async function connectServer(server: MCPServer): Promise<ConnectedMCP | undefined> {
  if (server.enabled === false) return undefined;
  const client = new Client(
    { name: "nlpilot", version: pkg.version },
    { capabilities: {} },
  );

  try {
    if (server.transport === "stdio") {
      if (!server.command) {
        console.error(kleur.red("✗"), `MCP ${server.name}: stdio transport missing 'command'`);
        return undefined;
      }
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
        stderr: "pipe",
      });
      await client.connect(transport);
    } else if (server.transport === "http") {
      if (!server.url) {
        console.error(kleur.red("✗"), `MCP ${server.name}: http transport missing 'url'`);
        return undefined;
      }
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      await client.connect(transport);
    } else if (server.transport === "sse") {
      if (!server.url) {
        console.error(kleur.red("✗"), `MCP ${server.name}: sse transport missing 'url'`);
        return undefined;
      }
      const transport = new SSEClientTransport(new URL(server.url));
      await client.connect(transport);
    } else {
      console.error(kleur.red("✗"), `MCP ${server.name}: unknown transport`);
      return undefined;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(kleur.red("✗"), `MCP ${server.name}: connect failed → ${message}`);
    return undefined;
  }

  return {
    name: server.name,
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

interface MCPCallContent {
  type?: string;
  text?: string;
  data?: unknown;
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = (content as MCPCallContent[]).map((part) => {
    if (typeof part?.text === "string") return part.text;
    return JSON.stringify(part);
  });
  return parts.join("\n");
}

function formatToolInput(input: unknown): string {
  const text = JSON.stringify(input ?? {}, null, 2);
  const max = 2_000;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

async function buildToolsForServer(
  conn: ConnectedMCP,
  options: MCPRuntimeOptions,
): Promise<{ tools: ToolSet; origins: Record<string, string> }> {
  const tools: ToolSet = {};
  const origins: Record<string, string> = {};
  let listed: Awaited<ReturnType<Client["listTools"]>>;
  try {
    listed = await conn.client.listTools();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(kleur.red("✗"), `MCP ${conn.name}: listTools failed → ${message}`);
    return { tools, origins };
  }

  for (const t of listed.tools) {
    const safeName = sanitizeToolName(conn.name, t.name);
    origins[safeName] = conn.name;
    const schema = jsonSchema(
      (compactSchemaValue(t.inputSchema) as Record<string, unknown> | undefined) ?? {
        type: "object",
        properties: {},
      },
    );
    tools[safeName] = dynamicTool({
      description: compactDescription(t.description ?? `${conn.name}.${t.name}`),
      inputSchema: schema,
      execute: async (input) => {
        const decision = await requestApproval(options.approvals, options.prompt, {
          toolName: safeName,
          summary: `Run MCP tool ${conn.name}.${t.name}`,
          details: formatToolInput(input),
        });
        if (decision === "deny") {
          return { denied: true, message: "User denied MCP tool execution" };
        }

        try {
          const result = await conn.client.callTool({
            name: t.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          });
          if (result.isError) {
            return `Error: ${flattenContent(result.content)}`;
          }
          return flattenContent(result.content);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `Error: ${message}`;
        }
      },
    });
  }
  return { tools, origins };
}

export async function startMcpRuntime(
  servers: MCPServer[],
  options: MCPRuntimeOptions,
): Promise<MCPRuntime> {
  const connected: ConnectedMCP[] = [];
  for (const server of servers) {
    const conn = await connectServer(server);
    if (conn) connected.push(conn);
  }

  const tools: ToolSet = {};
  const toolOrigins: Record<string, string> = {};
  for (const conn of connected) {
    const { tools: serverTools, origins } = await buildToolsForServer(conn, options);
    Object.assign(tools, serverTools);
    Object.assign(toolOrigins, origins);
  }

  return {
    tools,
    servers: connected,
    toolOrigins,
    shutdown: async () => {
      await Promise.all(connected.map((c) => c.close()));
    },
  };
}
