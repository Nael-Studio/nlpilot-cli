import { mkdir, writeFile, readdir, stat, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import kleur from "kleur";
import { generateText } from "ai";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel } from "../providers.ts";
import { startLoader, stopLoader } from "../ui/loader.ts";

const NLPILOT_DIR = ".nlpilot";
const INSTRUCTIONS_FILE = "instructions.md";

interface RepoSummary {
  files: string[];
  packageJson?: Record<string, unknown>;
  readme?: string;
}

async function summarizeRepo(cwd: string): Promise<RepoSummary> {
  const collected: string[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".nlpilot",
    "coverage",
  ]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && depth === 0 && e.name !== ".github") continue;
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        collected.push(full.replace(cwd + "/", ""));
        if (collected.length > 500) return;
      }
    }
  }
  await walk(cwd, 0);

  let packageJson: Record<string, unknown> | undefined;
  try {
    packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch {
    /* none */
  }

  let readme: string | undefined;
  for (const candidate of ["README.md", "Readme.md", "readme.md"]) {
    try {
      readme = await readFile(join(cwd, candidate), "utf8");
      break;
    } catch {
      /* none */
    }
  }

  return { files: collected, packageJson, readme };
}

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  const dir = join(cwd, NLPILOT_DIR);
  const out = join(dir, INSTRUCTIONS_FILE);
  try {
    const s = await stat(out);
    if (s.isFile()) {
      console.log(kleur.yellow("⚠"), `${out} already exists.`);
      console.log(kleur.dim("Delete or move it before running `nlpilot init` again."));
      return;
    }
  } catch {
    /* not present – continue */
  }

  console.log(kleur.dim("Analyzing repository…"));
  const summary = await summarizeRepo(cwd);

  const creds = await resolveCredentials();
  if (!creds) {
    console.log(
      kleur.red("✗"),
      "No credentials. Run",
      kleur.bold("nlpilot login"),
      "first.",
    );
    process.exitCode = 1;
    return;
  }
  const modelName = creds.model ?? DEFAULT_MODELS[creds.provider];
  const model = getModel(creds, modelName);

  const pkgInfo = summary.packageJson
    ? JSON.stringify(
        {
          name: summary.packageJson.name,
          scripts: summary.packageJson.scripts,
          dependencies: Object.keys(
            (summary.packageJson.dependencies as Record<string, string>) ?? {},
          ),
          devDependencies: Object.keys(
            (summary.packageJson.devDependencies as Record<string, string>) ?? {},
          ),
        },
        null,
        2,
      )
    : "(no package.json)";

  const prompt = `You are bootstrapping a project instructions file for the nlpilot CLI agent.
Produce a concise Markdown document the agent will load on every startup.

Include:
1. One-paragraph summary of what this project is.
2. Build / test / lint / dev commands (from package.json scripts when relevant).
3. High-level architecture / important folders.
4. Conventions worth knowing (testing, code style hints, naming).

Be terse. Use bullet points. Avoid filler.

--- package.json ---
${pkgInfo}

--- README excerpt ---
${(summary.readme ?? "(no README)").slice(0, 4000)}

--- File listing (truncated) ---
${summary.files.slice(0, 200).join("\n")}`;

  console.log(kleur.dim(`Generating with ${modelName}…`));
  const result = await generateText({ model, prompt });

  await mkdir(dir, { recursive: true });
  await writeFile(out, result.text.trim() + "\n", "utf8");

  console.log(kleur.green("✓"), `Wrote ${out}`);
}
