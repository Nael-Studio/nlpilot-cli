import kleur from "kleur";

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ApprovalState {
  alwaysAllow: Set<string>;
  autopilot: boolean;
  /** Tools always allowed (no prompt). */
  allowList: Set<string>;
  /** Tools that are denied outright. */
  denyList: Set<string>;
  /** When true, no interactive prompt is available; deny anything not pre-allowed. */
  nonInteractive: boolean;
}

export type PromptFn = (question: string) => Promise<string>;

export interface CreateApprovalOptions {
  autopilot?: boolean;
  allow?: string[];
  deny?: string[];
  nonInteractive?: boolean;
}

export function createApprovalState(
  options: CreateApprovalOptions = {},
): ApprovalState {
  return {
    alwaysAllow: new Set<string>(),
    autopilot: options.autopilot ?? false,
    allowList: new Set(options.allow ?? []),
    denyList: new Set(options.deny ?? []),
    nonInteractive: options.nonInteractive ?? false,
  };
}

export interface ApprovalRequest {
  toolName: string;
  summary: string;
  details?: string;
}

export async function requestApproval(
  state: ApprovalState,
  prompt: PromptFn,
  req: ApprovalRequest,
): Promise<ApprovalDecision> {
  if (state.denyList.has(req.toolName)) return "deny";
  if (state.allowList.has(req.toolName)) return "allow-session";
  if (state.autopilot) return "allow-session";
  if (state.alwaysAllow.has(req.toolName)) return "allow-session";
  if (state.nonInteractive) return "deny";

  console.log();
  console.log(kleur.yellow("⚠"), kleur.bold(`Tool request: ${req.toolName}`));
  console.log(`  ${req.summary}`);
  if (req.details) {
    for (const line of req.details.split("\n")) {
      console.log(kleur.dim(`  │ ${line}`));
    }
  }

  const answer = (
    await prompt(
      kleur.cyan("Allow? ") +
        kleur.dim("[y]es / [!] always this session / [n]o ") +
        "› ",
    )
  )
    .trim()
    .toLowerCase();

  if (answer === "!" || answer === "always" || answer === "a") {
    state.alwaysAllow.add(req.toolName);
    return "allow-session";
  }
  if (answer === "y" || answer === "yes" || answer === "") {
    return "allow-once";
  }
  return "deny";
}
