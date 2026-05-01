import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FrontmatterDoc {
  meta: Record<string, string>;
  body: string;
}

/**
 * Parse a markdown file that may begin with YAML-style frontmatter.
 *
 * Frontmatter must be delimited by `---` lines at the start of the file.
 * Values are treated as plain strings; surrounding quotes are stripped.
 *
 * @param text - Raw file content.
 * @returns An object containing the parsed `meta` record and the remaining `body`.
 */
export function parseFrontmatter(text: string): FrontmatterDoc {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

export interface CustomAgent {
  name: string;
  path: string;
  description?: string;
  model?: string;
  tools?: string[];
  body: string;
}

export interface Skill {
  name: string;
  path: string;
  description?: string;
  body: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load custom agent definitions from `.nlpilot/agents/*.md`.
 *
 * Each markdown file may include frontmatter with `name`, `description`, `model`, and `tools`.
 *
 * @param cwd - Project root to search for the `.nlpilot/agents/` directory. Defaults to `process.cwd()`.
 * @returns An array of parsed custom agents.
 */
export async function loadCustomAgents(cwd: string = process.cwd()): Promise<CustomAgent[]> {
  const dir = join(cwd, ".nlpilot", "agents");
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  const out: CustomAgent[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    const path = join(dir, e);
    const content = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(content);
    out.push({
      name: meta.name ?? e.replace(/\.md$/, ""),
      path,
      description: meta.description,
      model: meta.model,
      tools: meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      body,
    });
  }
  return out;
}

/**
 * Load skill definitions from `.nlpilot/skills/<name>/SKILL.md`.
 *
 * Each skill lives in its own directory and may include frontmatter with `name` and `description`.
 *
 * @param cwd - Project root to search for the `.nlpilot/skills/` directory. Defaults to `process.cwd()`.
 * @returns An array of parsed skills.
 */
export async function loadSkills(cwd: string = process.cwd()): Promise<Skill[]> {
  const dir = join(cwd, ".nlpilot", "skills");
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(dir, e.name, "SKILL.md");
    if (!(await exists(path))) continue;
    const content = await readFile(path, "utf8");
    const { meta, body } = parseFrontmatter(content);
    out.push({
      name: meta.name ?? e.name,
      path,
      description: meta.description,
      body,
    });
  }
  return out;
}
