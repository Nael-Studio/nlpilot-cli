import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MCP_CONFIG_DIR = join(homedir(), ".nlpilot");
const MCP_CONFIG_FILE = join(MCP_CONFIG_DIR, "mcp.json");
const PROJECT_MCP_FILENAME = ".mcp.json";

export type MCPTransport = "stdio" | "http" | "sse";
export type MCPSource = "global" | "project";

export interface MCPServer {
  name: string;
  transport: MCPTransport;
  /** stdio: command + args */
  command?: string;
  args?: string[];
  /** http/sse: url */
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  /** Where the entry came from. Not persisted to disk. */
  source?: MCPSource;
}

export interface MCPConfig {
  servers: MCPServer[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadMcpConfig(): Promise<MCPConfig> {
  if (!(await exists(MCP_CONFIG_FILE))) return { servers: [] };
  try {
    const parsed = JSON.parse(await readFile(MCP_CONFIG_FILE, "utf8"));
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    return { servers: servers.map((s: MCPServer) => ({ ...s, source: "global" })) };
  } catch {
    return { servers: [] };
  }
}

export async function saveMcpConfig(cfg: MCPConfig): Promise<string> {
  await mkdir(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Strip the in-memory `source` tag before persisting.
  const persistable = {
    servers: cfg.servers.map(({ source: _source, ...rest }) => rest),
  };
  await writeFile(MCP_CONFIG_FILE, JSON.stringify(persistable, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return MCP_CONFIG_FILE;
}

export function getMcpConfigPath(): string {
  return MCP_CONFIG_FILE;
}

export function getProjectMcpConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, PROJECT_MCP_FILENAME);
}

interface ProjectServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  type?: MCPTransport;
  transport?: MCPTransport;
  enabled?: boolean;
}

function inferTransport(entry: ProjectServerEntry): MCPTransport {
  if (entry.transport) return entry.transport;
  if (entry.type) return entry.type;
  if (entry.url) return "http";
  return "stdio";
}

function normalizeProjectEntry(name: string, entry: ProjectServerEntry): MCPServer {
  const transport = inferTransport(entry);
  return {
    name,
    transport,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    env: entry.env,
    enabled: entry.enabled,
    source: "project",
  };
}

/**
 * Load `.mcp.json` from the given cwd. Supports two shapes:
 *   { "mcpServers": { "<name>": { command, args, url, env, type } } }   // Claude Code / Cursor style
 *   { "servers": [ MCPServer, ... ] }                                    // nlpilot internal style
 */
export async function loadProjectMcpConfig(cwd: string = process.cwd()): Promise<MCPConfig> {
  const path = getProjectMcpConfigPath(cwd);
  if (!(await exists(path))) return { servers: [] };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers?: Record<string, ProjectServerEntry>;
      servers?: MCPServer[];
    };
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      const servers = Object.entries(parsed.mcpServers).map(([name, entry]) =>
        normalizeProjectEntry(name, entry),
      );
      return { servers };
    }
    if (Array.isArray(parsed.servers)) {
      return {
        servers: parsed.servers.map((s) => ({ ...s, source: "project" as const })),
      };
    }
    return { servers: [] };
  } catch {
    return { servers: [] };
  }
}

/**
 * Merged view of global + project servers. Project entries override global entries with the same name.
 */
export async function loadEffectiveMcpConfig(cwd: string = process.cwd()): Promise<MCPConfig> {
  const [global, project] = await Promise.all([loadMcpConfig(), loadProjectMcpConfig(cwd)]);
  const byName = new Map<string, MCPServer>();
  for (const s of global.servers) byName.set(s.name, s);
  for (const s of project.servers) byName.set(s.name, s); // project wins
  return { servers: [...byName.values()] };
}
