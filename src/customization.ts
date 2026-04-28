import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FrontmatterDoc {
  meta: Record<string, string>;
  body: string;
}

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
