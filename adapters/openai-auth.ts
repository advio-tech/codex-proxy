// Read native Codex credentials without refresh, login or filesystem writes.
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export function codexAuthFile(): string {
  return process.env.CODEX_AUTH_FILE || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

export class CodexNativeAuthError extends Error {
  readonly statusCode = 401;
}

export interface CodexTokens {
  access_token: string;
  expires_at: number;
  account_id?: string;
}

function decodeJwtPayload(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch { return null; }
}

function parseTokens(data: string): CodexTokens | null {
  try {
    const tokens = JSON.parse(data)?.tokens;
    if (typeof tokens?.access_token !== "string" || !tokens.access_token) return null;
    const payload = decodeJwtPayload(tokens.access_token);
    const idPayload = decodeJwtPayload(tokens.id_token);
    const account = tokens.account_id || payload?.["https://api.openai.com/auth"]?.chatgpt_account_id
      || idPayload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return { access_token: tokens.access_token,
      expires_at: typeof payload?.exp === "number" ? payload.exp * 1000 : 0,
      ...(typeof account === "string" && account ? { account_id: account } : {}) };
  } catch { return null; }
}

export async function loadTokens(): Promise<CodexTokens | null> {
  try { return parseTokens(await readFile(codexAuthFile(), "utf-8")); }
  catch { return null; }
}

export function getCodexAccountId(): string | null {
  try { return parseTokens(readFileSync(codexAuthFile(), "utf-8"))?.account_id || null; }
  catch { return null; }
}

// Token and account are read from one snapshot for each request.
export async function getCodexCredentials(): Promise<CodexTokens> {
  const tokens = await loadTokens();
  if (!tokens) throw new CodexNativeAuthError("Valid native Codex auth.json not found. Check the existing Codex CLI login.");
  if (!Number.isFinite(tokens.expires_at) || tokens.expires_at <= Date.now()) {
    throw new CodexNativeAuthError("Codex access token expired or expiry unknown. Proxy does not refresh tokens; update the native cache using Codex CLI and retry.");
  }
  return tokens;
}

export async function getCodexAccessToken(): Promise<string> {
  return (await getCodexCredentials()).access_token;
}

// Local validity does not imply that the backend accepted these credentials.
export async function getCodexLoginStatus() {
  const tokens = await loadTokens();
  return { loggedIn: !!tokens && Number.isFinite(tokens.expires_at) && tokens.expires_at > Date.now(),
    expiresAt: tokens?.expires_at, source: "codex-cli", backendAccepted: "not_checked" };
}
