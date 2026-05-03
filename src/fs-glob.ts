import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const REGEX_META = /[.+^${}()|[\]\\]/g;

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    const next = pattern[i + 1];
    if (char === "*") {
      if (next === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end > i) {
        const options = pattern
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(REGEX_META, "\\$&"));
        source += `(?:${options.join("|")})`;
        i = end;
      } else {
        source += "\\{";
      }
    } else {
      source += char.replace(REGEX_META, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function shouldSkipDir(path: string): boolean {
  return path === ".git" ||
    path === "node_modules" ||
    path === "dist" ||
    path.includes("/.git/") ||
    path.includes("/node_modules/") ||
    path.includes("/dist/");
}

export async function* scanFiles(pattern: string, cwd = process.cwd()): AsyncGenerator<string> {
  const matcher = globToRegExp(pattern);

  async function* walk(dir: string): AsyncGenerator<string> {
    const entries = await readdir(join(cwd, dir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!shouldSkipDir(rel)) yield* walk(rel);
        continue;
      }
      if (entry.isFile() && matcher.test(rel)) yield rel;
    }
  }

  yield* walk("");
}

export function relativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}
