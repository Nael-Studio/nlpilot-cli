#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = {
  name: string;
  version: string;
};

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const otpArg = process.argv.find((arg) => arg.startsWith("--otp="));
const otp = otpArg?.slice("--otp=".length) || process.env.NPM_CONFIG_OTP || process.env.NPM_OTP;

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): void {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

if (!output("npm", ["whoami"])) {
  console.error("Not logged in to npm. Run `npm login` first.");
  process.exit(1);
}

console.log(`Publishing ${pkg.name}@${pkg.version} to npm...`);

run("bun", ["run", "typecheck"]);
run("bun", ["run", "build"]);

const binPath = join(root, "dist", "nlpilot.js");
if (!existsSync(binPath)) {
  console.error("Build did not create dist/nlpilot.js.");
  process.exit(1);
}
chmodSync(binPath, 0o755);

run("npm", ["pack", "--dry-run"]);

const publishArgs = ["publish", "--access", "public"];
if (otp) publishArgs.push("--otp", otp);
run("npm", publishArgs);
