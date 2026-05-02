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
/**
 * Load `.mcp.json` from the given working directory.
 *
 * Supports both Claude Code / Cursor style (`mcpServers`) and nlpilot native style (`servers`).
 *
 * @param cwd - Directory to look for `.mcp.json` in. Defaults to `process.cwd()`.
 * @returns The parsed project-level MCP config, or an empty config if the file is missing.
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
 * Merge global and project MCP configs. Project entries override global entries with the same name.
 *
 * @param cwd - Project directory. Defaults to `process.cwd()`.
 * @param options.includeProject - Whether to include project `.mcp.json` servers.
 * @returns A merged MCP config containing both global and project servers.
 */
export async function loadEffectiveMcpConfig(
  cwd: string = process.cwd(),
  options: { includeProject?: boolean } = {},
): Promise<MCPConfig> {
  const includeProject = options.includeProject ?? true;
  const [global, project] = await Promise.all([
    loadMcpConfig(),
    includeProject ? loadProjectMcpConfig(cwd) : Promise.resolve({ servers: [] }),
  ]);
  const byName = new Map<string, MCPServer>();
  for (const s of global.servers) byName.set(s.name, s);
  for (const s of project.servers) byName.set(s.name, s); // project wins
  return { servers: [...byName.values()] };
}

/**
 * Load an MCP config from an arbitrary file path.
 * Supports both `{ mcpServers: {...} }` and `{ servers: [...] }` formats.
 */
/**
 * Load an MCP configuration from an arbitrary file path.
 *
 * Supports both `{ mcpServers: {...} }` and `{ servers: [...] }` formats.
 *
 * @param filePath - Absolute or relative path to the MCP JSON file.
 * @returns The parsed MCP config.
 * @throws If the file does not exist or cannot be parsed.
 */
export async function loadAdditionalMcpConfig(filePath: string): Promise<MCPConfig> {
  if (!(await exists(filePath))) {
    throw new Error(`MCP config file not found: ${filePath}`);
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
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
  } catch (err) {
    throw new Error(`Failed to parse MCP config from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Merge effective config with additional config. Additional entries override existing ones.
 */
/**
 * Overlay an additional MCP config file on top of the effective config.
 *
 * Additional entries override existing ones with the same server name.
 *
 * @param effectiveConfig - The base effective config (global + project).
 * @param additionalConfigPath - Path to an extra MCP JSON file, or `undefined`.
 * @returns The merged config, or the original effective config if no additional file is provided.
 */
export async function mergeAdditionalMcpConfig(
  effectiveConfig: MCPConfig,
  additionalConfigPath: string | undefined,
): Promise<MCPConfig> {
  if (!additionalConfigPath) return effectiveConfig;

  const additional = await loadAdditionalMcpConfig(additionalConfigPath);
  const byName = new Map<string, MCPServer>();

  for (const s of effectiveConfig.servers) byName.set(s.name, s);
  for (const s of additional.servers) byName.set(s.name, s); // additional wins

  return { servers: [...byName.values()] };
}
