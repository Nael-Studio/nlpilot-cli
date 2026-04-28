import kleur from "kleur";
import { input, select } from "@inquirer/prompts";
import {
  loadEffectiveMcpConfig,
  loadMcpConfig,
  saveMcpConfig,
  getMcpConfigPath,
  getProjectMcpConfigPath,
  type MCPServer,
} from "../mcp.ts";

export async function mcpCommand(sub?: string, name?: string): Promise<void> {
  const action = sub ?? "list";
  switch (action) {
    case "list":
      await mcpList();
      return;
    case "get":
      if (!name) {
        console.log(kleur.yellow("Usage: nlpilot mcp get <name>"));
        return;
      }
      await mcpGet(name);
      return;
    case "add":
      await mcpAdd(name);
      return;
    case "remove":
      if (!name) {
        console.log(kleur.yellow("Usage: nlpilot mcp remove <name>"));
        return;
      }
      await mcpRemove(name);
      return;
    default:
      console.log(kleur.red("✗"), `Unknown subcommand: ${action}`);
      console.log(kleur.dim("Use: list | get <name> | add [name] | remove <name>"));
      process.exitCode = 1;
  }
}

async function mcpList(): Promise<void> {
  const cfg = await loadEffectiveMcpConfig();
  if (cfg.servers.length === 0) {
    console.log(kleur.dim("No MCP servers configured."));
    console.log(kleur.dim(`Global config: ${getMcpConfigPath()}`));
    console.log(kleur.dim(`Project config: ${getProjectMcpConfigPath()}`));
    return;
  }
  for (const s of cfg.servers) {
    const target = s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url;
    const enabled = s.enabled === false ? kleur.red("disabled") : kleur.green("enabled");
    const sourceLabel = s.source === "project" ? kleur.cyan("project") : kleur.dim("global");
    console.log(
      `  ${kleur.bold(s.name).padEnd(30)} ${kleur.dim(s.transport)}  ${target ?? ""}  ${enabled}  ${sourceLabel}`,
    );
  }
}

async function mcpGet(name: string): Promise<void> {
  const cfg = await loadEffectiveMcpConfig();
  const found = cfg.servers.find((s) => s.name === name);
  if (!found) {
    console.log(kleur.red("✗"), `No MCP server named ${name}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(found, null, 2));
}

async function mcpAdd(initialName?: string): Promise<void> {
  const name = initialName ?? (await input({ message: "Server name:" }));
  const transport = await select<MCPServer["transport"]>({
    message: "Transport:",
    choices: [
      { name: "stdio (local subprocess)", value: "stdio" },
      { name: "http", value: "http" },
      { name: "sse", value: "sse" },
    ],
  });

  const server: MCPServer = { name, transport, enabled: true };

  if (transport === "stdio") {
    server.command = await input({
      message: "Command:",
      validate: (v) => (v.trim() ? true : "Command required"),
    });
    const argsRaw = await input({
      message: "Args (space-separated, optional):",
      default: "",
    });
    if (argsRaw.trim()) server.args = argsRaw.trim().split(/\s+/);
  } else {
    server.url = await input({
      message: "URL:",
      validate: (v) => (v.trim() ? true : "URL required"),
    });
  }

  const cfg = await loadMcpConfig();
  const existing = cfg.servers.findIndex((s) => s.name === name);
  if (existing >= 0) cfg.servers[existing] = server;
  else cfg.servers.push(server);

  const path = await saveMcpConfig(cfg);
  console.log(kleur.green("✓"), `Saved server ${kleur.bold(name)} to ${path}`);
}

async function mcpRemove(name: string): Promise<void> {
  const cfg = await loadMcpConfig();
  const before = cfg.servers.length;
  cfg.servers = cfg.servers.filter((s) => s.name !== name);
  if (cfg.servers.length === before) {
    console.log(kleur.yellow("⚠"), `No server named ${name}`);
    return;
  }
  await saveMcpConfig(cfg);
  console.log(kleur.green("✓"), `Removed server ${kleur.bold(name)}`);
}
