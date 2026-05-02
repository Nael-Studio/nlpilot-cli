import kleur from "kleur";

const HELP_TOPICS: Record<string, string> = {
  config: `${kleur.bold("Configuration")}

Credentials are stored at ${kleur.cyan("~/.nlpilot/credentials")} (mode 0600).

Environment variables (override stored values):
  ${kleur.cyan("NLPILOT_API_KEY")}    API key for the active provider
  ${kleur.cyan("NLPILOT_PROVIDER")}   openai | anthropic | google
  ${kleur.cyan("NLPILOT_MODEL")}      Default model name`,

  commands: `${kleur.bold("Commands")}

  ${kleur.cyan("nlpilot")}                     Start interactive REPL
  ${kleur.cyan("nlpilot login")}               Store an API key
  ${kleur.cyan("nlpilot logout")}              Clear stored API key
  ${kleur.cyan("nlpilot models [provider]")}   List known models
  ${kleur.cyan("nlpilot version")}             Print version
  ${kleur.cyan("nlpilot help [TOPIC]")}        Show help (config | commands | environment | permissions)

Useful cost controls:
  ${kleur.cyan("--max-steps <n>")}             Cap model/tool loop steps per prompt
  ${kleur.cyan("--max-output-tokens <n>")}     Cap assistant output tokens
  ${kleur.cyan("--no-mcp")}                    Disable all MCP servers for this run
  ${kleur.cyan("--no-model-routing")}          Use the configured model instead of auto-routing
  ${kleur.cyan("--no-auto-compact")}           Disable rolling REPL compaction after each turn
  ${kleur.cyan("--compact-threshold <pct>")}   REPL auto-compaction threshold

In the REPL: ${kleur.cyan("/model")} lists models, ${kleur.cyan("/model <id>")} switches, ${kleur.cyan("/exit")} quits.`,

  environment: `${kleur.bold("Environment")}

  ${kleur.cyan("NLPILOT_API_KEY")}    API key, takes precedence over stored credentials
  ${kleur.cyan("NLPILOT_PROVIDER")}   openai | anthropic | google
  ${kleur.cyan("NLPILOT_MODEL")}      Default model name`,

  permissions: `${kleur.bold("Permissions")}

Tools that mutate state (bash, edit, create, web_fetch) prompt for approval:

  ${kleur.cyan("y")}    allow once (default if you just press Enter)
  ${kleur.cyan("!")}    always allow this tool for the rest of the session
  ${kleur.cyan("n")}    deny

Modes (toggle with ${kleur.cyan("/mode <name>")} in the REPL):

  ${kleur.cyan("ask")}        default — approve every mutating tool call
  ${kleur.cyan("plan")}       agent must produce a plan before mutating tools
  ${kleur.cyan("autopilot")}  skip all approvals (use carefully)`,
};

export function helpCommand(topic?: string): void {
  if (!topic) {
    console.log(HELP_TOPICS.commands);
    console.log();
    console.log(
      kleur.dim("Run"),
      kleur.cyan("nlpilot help <topic>"),
      kleur.dim("for: config, environment, permissions"),
    );
    return;
  }

  const body = HELP_TOPICS[topic.toLowerCase()];
  if (!body) {
    console.log(kleur.red(`Unknown help topic: ${topic}`));
    console.log(
      kleur.dim("Available topics:"),
      Object.keys(HELP_TOPICS).join(", "),
    );
    process.exitCode = 1;
    return;
  }
  console.log(body);
}
