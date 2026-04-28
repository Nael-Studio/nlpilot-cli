import kleur from "kleur";
import { clearCredentials, getCredentialsPath } from "../config.ts";

export async function logoutCommand(): Promise<void> {
  const removed = await clearCredentials();
  if (removed) {
    console.log(
      kleur.green("✓"),
      `Credentials removed (${kleur.dim(getCredentialsPath())}).`,
    );
  } else {
    console.log(kleur.yellow("No stored credentials found."));
  }
}
