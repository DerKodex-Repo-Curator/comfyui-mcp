import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../utils/errors.js";

export type ConceptImageProvider = "grok" | "google";

function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || homedir();
}

interface GrokAuthEntry {
  key?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

interface GeminiOAuthCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
}

/** Resolve an xAI API key for Grok Imagine (env wins, then ~/.grok/auth.json `key`). */
export async function resolveGrokApiKey(home = homedir()): Promise<string> {
  const fromEnv = process.env.XAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const authPath = join(home, ".grok", "auth.json");
  if (!existsSync(authPath)) {
    throw new ValidationError(
      "Grok image generation requires XAI_API_KEY or a signed-in Grok CLI (~/.grok/auth.json). " +
        "Set XAI_API_KEY or run `grok` once to sign in.",
    );
  }

  const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, GrokAuthEntry>;
  for (const entry of Object.values(raw)) {
    if (entry?.key?.trim()) return entry.key.trim();
  }
  throw new ValidationError(
    "No xAI API key in ~/.grok/auth.json. Set XAI_API_KEY or sign in with `grok`.",
  );
}

/** Resolve a Google API key (env) or a non-expired Gemini CLI OAuth access token. */
export async function resolveGoogleImageAuth(home = homedir()): Promise<
  | { kind: "api_key"; token: string }
  | { kind: "oauth"; accessToken: string }
> {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (apiKey) return { kind: "api_key", token: apiKey };

  const oauthPath = join(geminiHome(), ".gemini", "oauth_creds.json");
  if (!existsSync(oauthPath)) {
    throw new ValidationError(
      "Google image generation requires GEMINI_API_KEY (or GOOGLE_API_KEY) or a signed-in Gemini CLI " +
        "(~/.gemini/oauth_creds.json). Run `gemini` once or set GEMINI_API_KEY.",
    );
  }

  const creds = JSON.parse(await readFile(oauthPath, "utf8")) as GeminiOAuthCreds;
  const access = creds.access_token?.trim();
  if (!access) {
    throw new ValidationError("Gemini OAuth creds exist but access_token is missing. Re-run `gemini` to sign in.");
  }
  const expiry = creds.expiry_date;
  if (typeof expiry === "number" && expiry > 0 && Date.now() >= expiry - 60_000) {
    throw new ValidationError(
      "Gemini OAuth access token is expired. Re-run `gemini` to refresh, or set GEMINI_API_KEY.",
    );
  }
  return { kind: "oauth", accessToken: access };
}