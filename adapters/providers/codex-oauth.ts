// Native Codex Responses backend with Messages conversion and session replay.
import { readFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { homedir, release, arch, type } from "os";
import { join } from "path";
import type { EventSourceMessage } from "eventsource-parser";
import { createParser } from "eventsource-parser";
import { FastifyReply } from "fastify";
import { getCodexCredentials, CodexNativeAuthError } from "../openai-auth.js";
import { sendEvent } from "../sse.js";
import { captureCodexRateLimits } from "../codex-rate-limits.js";
import {
  conversationKey,
  rememberResponse,
  replayResponses,
  threadIdFor,
} from "../codex-reasoning-cache.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  ReasoningLevel,
} from "../types.js";

const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";

const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_CODEX_CLI_VERSION = "0.144.1";

// ── Header builders ──────────────────────────────────────────────────

function installationId(): string {
  try {
    return readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "installation_id"), "utf-8").trim();
  } catch {
    return "";
  }
}

/** Build the User-Agent string Codex CLI sends. Matches `get_codex_user_agent()`. */
function codexUserAgent(): string {
  const version = process.env.CODEX_CLI_VERSION || DEFAULT_CODEX_CLI_VERSION;
  return `${DEFAULT_ORIGINATOR}/${version} (${type()} ${release()}; ${arch()})`;
}

// ── Tool conversion (Anthropic → Responses API) ──────────────────────

type ResponsesTool =
  | {
      type: "function";
      name: string;
      description: string;
      strict: false;
      parameters: unknown;
    }
  | {
      type: "web_search";
      search_context_size?: "low" | "medium" | "high";
    };

export function toResponsesTools(tools: AnthropicTool[] | undefined): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  if (tools) {
    for (const t of tools) {
      out.push({
        type: "function",
        name: t.name,
        description: t.description ?? "",
        strict: false,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      });
    }
  }
  // Codex CLI registers native web_search; Claude Code's WebSearch/WebFetch are stripped
  // upstream in anthropic-gateway.ts before they reach us.
  out.push({ type: "web_search" });
  return out;
}

export function toResponsesToolChoice(c?: AnthropicToolChoice): string | { type: string; name?: string } {
  if (!c || c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "none") return "none";
  if (c.type === "tool") {
    if (c.name === "WebSearch" || c.name === "WebFetch") return { type: "web_search" };
    return { type: "function", name: c.name };
  }
  return "auto";
}

// ── Input conversion (Anthropic messages → Responses ResponseItem[]) ──

type ResponseMessageContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
  | { type: "output_text"; text: string };

export type ReasoningResponseItem = {
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
};

export type ResponseItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: ResponseMessageContent[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReasoningResponseItem;

export function textFromResponsesMessageItem(item: {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .map((part) => (part.type === "output_text" || part.type === "text" ? part.text || "" : ""))
    .filter(Boolean)
    .join("");
}

function flattenSystem(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text || ""))
    .filter(Boolean)
    .join("\n");
}

const CLAUDE_COMPACTION_PROMPT_MARKERS = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of",
];

/** Detect Claude Code's generated compaction turn without affecting user prompts about summaries. */
export function isClaudeCompactionRequest(body: AnthropicRequest): boolean {
  let message: AnthropicMessage | undefined;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i].role === "user") {
      message = body.messages[i];
      break;
    }
  }
  if (!message) return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  return CLAUDE_COMPACTION_PROMPT_MARKERS.every((marker) => text.includes(marker));
}

function previewText(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function responseItemSummary(item: ResponseItem | undefined): string {
  if (!item) return "none";
  if (item.type === "message") {
    const text = item.content
      .map((part) => ("text" in part ? part.text : part.image_url ? "[image]" : ""))
      .filter(Boolean)
      .join(" ");
    return `message:${item.role}:${previewText(text)}`;
  }
  if (item.type === "function_call") {
    return `function_call:${item.name}:${item.call_id}`;
  }
  if (item.type === "function_call_output") {
    return `function_call_output:${item.call_id}:${previewText(item.output)}`;
  }
  return `reasoning:encrypted=${item.encrypted_content ? "yes" : "no"} summaries=${item.summary.length}`;
}

function imageUrlForBlock(block: Extract<AnthropicContentBlock, { type: "image" }>): string {
  const s = block.source;
  if (s.type === "base64") return `data:${s.media_type};base64,${s.data}`;
  if (s.type === "url") return s.url;
  return "";
}

function stringifyToolResult(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  // Anthropic allows tool_result content to be a list of blocks. Codex/OpenAI
  // function_call_output.output is a plain string, so flatten text + JSON-encode the rest.
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return `[image: ${(b as { source: { media_type?: string } }).source.media_type || "unknown"}]`;
      return JSON.stringify(b);
    })
    .join("\n");
}

// Codex's ChatGPT backend rejects input items with role "system"
// ({"detail":"System messages are not allowed"}). Claude Code 2.1.156+ sends
// MCP/skill instructions as a role:"system" message inside `messages`, so map any
// non-user/assistant role to "developer" — the Responses API's system-level role.
function toInputRole(role: AnthropicMessage["role"]): "user" | "assistant" | "developer" {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "developer";
}

function trailingDeveloperMessageCount(messages: AnthropicMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (toInputRole(messages[i].role) !== "developer") break;
    count += 1;
  }
  return count;
}

export function normalizeMessagesForResponses(messages: AnthropicMessage[]): AnthropicMessage[] {
  // Reordering trailing instructions changes an already-sent prompt prefix.
  return messages;
}

export function toResponsesInput(messages: AnthropicMessage[]): ResponseItem[] {
  const out: ResponseItem[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({
        type: "message",
        role: toInputRole(m.role),
        content: [
          m.role === "assistant"
            ? { type: "output_text", text: m.content }
            : { type: "input_text", text: m.content },
        ],
      });
      continue;
    }

    const inlineContent: ResponseMessageContent[] = [];
    const trailingItems: ResponseItem[] = [];
    const flushInline = () => {
      if (inlineContent.length) {
        out.push({ type: "message", role: toInputRole(m.role), content: inlineContent.splice(0) });
      }
    };
    for (const block of m.content as AnthropicContentBlock[]) {
      switch (block.type) {
        case "text":
          if (m.role === "assistant" && inlineContent.at(-1)?.type === "output_text") {
            (inlineContent.at(-1) as { type: "output_text"; text: string }).text += block.text;
            break;
          }
          inlineContent.push(
            m.role === "assistant"
              ? { type: "output_text", text: block.text }
              : { type: "input_text", text: block.text },
          );
          break;
        case "image":
          inlineContent.push({ type: "input_image", image_url: imageUrlForBlock(block) });
          break;
        case "tool_use":
          flushInline();
          out.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments:
              typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          });
          break;
        case "tool_result":
          trailingItems.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: stringifyToolResult(block.content),
          });
          break;
        case "thinking":
        case "redacted_thinking":
          // Claude Code may replay historical Anthropic thinking blocks on every
          // turn. They are not reusable Codex reasoning state; the only reasoning
          // we should echo back is the encrypted_content returned by Responses
          // and stored in our cache. Re-sending thinking summaries here can make
          // long resumed sessions exceed the upstream context window.
          break;
      }
    }

    if (inlineContent.length) {
      out.push({ type: "message", role: toInputRole(m.role), content: inlineContent });
    }
    if (trailingItems.length) out.push(...trailingItems);
  }

  return out;
}

// ── Reasoning effort mapping ─────────────────────────────────────────

function reasoningEffort(level?: ReasoningLevel): "low" | "medium" | "high" | "xhigh" | "max" {
  // Optional server-side pin, independent of Claude Code's model suffix.
  const forced = process.env.CODEX_FORCE_REASONING_EFFORT?.toLowerCase();
  if (forced) {
    if (!["low", "medium", "high", "xhigh", "max"].includes(forced)) {
      throw new Error("Invalid CODEX_FORCE_REASONING_EFFORT");
    }
    return forced as "low" | "medium" | "high" | "xhigh" | "max";
  }
  if (level === "none" || level === "minimal") return "low"; // Codex has no thinking-off; floor to low
  if (level) return level; // low | medium | high | xhigh | max pass straight through
  // Codex maps its client-only "ultra" effort to "max" on the wire (multi-agent
  // orchestration is a CLI concern, not a Responses param), so "max" is the ceiling
  // the proxy ever sends. GPT-5.6 Sol/Terra/Luna accept it; older models cap at xhigh.
  const env = (process.env.CODEX_REASONING_EFFORT || "").toLowerCase();
  if (env === "low" || env === "medium" || env === "high" || env === "xhigh" || env === "max") return env;
  return "medium";
}

export function effectiveReasoningEffort(
  body: AnthropicRequest,
  level?: ReasoningLevel,
): "low" | "medium" | "high" | "xhigh" | "max" {
  const effort = reasoningEffort(level);
  if (!isClaudeCompactionRequest(body)) return effort;
  return effort === "low" || effort === "medium" ? effort : "medium";
}

function reasoningSummary(): "auto" | "concise" | "detailed" | null {
  const env = (process.env.CODEX_REASONING_SUMMARY || "").toLowerCase();
  if (env === "concise" || env === "detailed" || env === "auto") return env;
  if (env === "none") return null;
  return "auto";
}

function textVerbosity(): "low" | "medium" | "high" | undefined {
  const env = (process.env.CODEX_TEXT_VERBOSITY || "").toLowerCase();
  if (env === "low" || env === "medium" || env === "high") return env;
  return undefined;
}

// ── Main adapter ─────────────────────────────────────────────────────

export async function chatCodexOAuth(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  reasoning?: ReasoningLevel,
) {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.raw.once?.("close", onClose);
  const diagnostic: CodexDiagnostic = { id: res.request?.id || randomUUID(), started: Date.now(),
    phase: "credentials", signal: controller.signal };
  // Keep the Claude connection alive while VPN reconnects. No content is sent
  // until the whole model response succeeds, so retrying cannot duplicate tools.
  const heartbeat = body.stream === true ? setInterval(() => {
    if (!res.raw.destroyed && !res.raw.writableEnded) sendEvent(res, "ping", { type: "ping" });
  }, 15000) : undefined;
  const retries = process.env.CCX_NETWORK_RETRIES === undefined ? Infinity
    : Math.max(0, Number(process.env.CCX_NETWORK_RETRIES) || 0);
  let attempt = 0;
  try {
    while (!controller.signal.aborted && !res.raw.destroyed && !res.raw.writableEnded) {
      const chunks: string[] = [];
      const buffered = { request: res.request, raw: {
        writableEnded: false,
        setHeader: () => {}, flushHeaders: () => {},
        write: (chunk: string) => { chunks.push(chunk); return true; },
        end: () => {},
      } } as unknown as FastifyReply;
      try {
        diagnostic.phase = "credentials";
        delete diagnostic.upstreamRequestId;
        await chatCodexOAuthInner(buffered, body, model, reasoning, diagnostic);
        if (!controller.signal.aborted && !res.raw.destroyed) {
          for (const chunk of chunks) res.raw.write(chunk);
          res.raw.end();
        }
        return;
      } catch (err) {
        if (controller.signal.aborted || res.raw.destroyed) return;
        if (retryableCodexError(err) && attempt < retries) {
          logCodexDiagnostic(diagnostic, "retry", err, ++attempt);
          await delay(Math.max(0, Number(process.env.CCX_NETWORK_RETRY_DELAY_MS || 5000)), undefined, { signal: controller.signal });
          continue;
        }
        logCodexDiagnostic(diagnostic, "failed", err);
        emitErrorAsSse(res, err);
        return;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted && !res.raw.destroyed) {
      logCodexDiagnostic(diagnostic, "failed", err);
      emitErrorAsSse(res, err);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    res.raw.removeListener?.("close", onClose);
  }
}

function retryableCodexError(err: unknown): boolean {
  if (err instanceof CodexBackendError) {
    return [500, 502, 503, 504, 529].includes(err.status)
      || (err.event === "response.failed" && ["server_error", "internal_error", "overloaded_error"].includes(err.backendCode || ""));
  }
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
    "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(e?.cause?.code || e?.code || "");
}

class CodexBackendError extends Error {
  constructor(readonly status: number, readonly backendCode?: string, readonly event?: string) {
    super(`Codex backend HTTP ${status}. Check the existing Codex CLI login and model access; proxy does not refresh native tokens.`);
  }
}

type CodexDiagnostic = {
  id: string;
  started: number;
  phase: "credentials" | "connect" | "http" | "stream";
  upstreamRequestId?: string;
  signal?: AbortSignal;
};

// Only known technical identifiers are logged. Never serialize Error.message,
// backend bodies, prompts, headers, credentials or account identifiers.
const diagnosticCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "rate_limit_exceeded", "usage_limit_reached", "insufficient_quota",
  "invalid_api_key", "invalid_request_error", "authentication_error",
  "permission_denied", "model_not_found", "server_error", "internal_error",
  "context_length_exceeded", "invalid_encrypted_content", "token_expired",
  "max_output_tokens", "content_filter", "overloaded_error",
]);
function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && diagnosticCodes.has(value) ? value : undefined;
}
function logCodexDiagnostic(d: CodexDiagnostic, outcome: "retry" | "failed", err: unknown, attempt?: number) {
  const e = err as { code?: unknown; cause?: { code?: unknown }; name?: string } | undefined;
  const code = err instanceof CodexBackendError ? err.backendCode
    : diagnosticCode(e?.cause?.code) || diagnosticCode(e?.code);
  const category = err instanceof CodexNativeAuthError ? "native_auth"
    : err instanceof CodexBackendError ? "backend"
    : e?.name === "AbortError" ? "aborted"
    : e?.name === "SyntaxError" ? "parse"
    : code ? "network" : "unknown";

  console.error("[codex-diagnostic] " + JSON.stringify({
    timestamp: new Date().toISOString(), requestId: d.id, phase: d.phase,
    outcome, category, code: code || "unrecognized", elapsedMs: Date.now() - d.started,
    ...(attempt ? { attempt } : {}),
    ...(err instanceof CodexBackendError ? { status: err.status, event: err.event } : {}),
    ...(d.upstreamRequestId ? { upstreamRequestId: d.upstreamRequestId } : {}),
  }));
}

function safeCodexError(err: unknown): string {
  if (err instanceof CodexBackendError) return err.event
    ? `Codex backend ${err.event} (${err.backendCode || "unknown"}). Retry the request.`
    : err.message;
  if (err instanceof CodexNativeAuthError) return err.message;
  return "Codex backend error. Check native credentials, model access and connection; proxy does not refresh tokens.";
}

function emitErrorAsSse(res: FastifyReply, err: unknown) {
  if (res.raw.writableEnded || res.raw.destroyed) return;
  const status = err instanceof CodexBackendError ? err.status : err instanceof CodexNativeAuthError ? 401 : 503;
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error"
    : status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : "api_error";
  sendEvent(res, "error", { type: "error", error: { type, message: safeCodexError(err) }, status });
  res.raw.end();
}

// `fetch()` only throws on connection-level failures — an HTTP error status comes
// back as a resolved Response — so a throw means the request never reached the
// server and re-POSTing the identical body is safe (Codex requests use store:false).
// The dominant cause is a pooled keep-alive socket the backend already closed;
// the failing attempt errors instantly and the retry gets a fresh connection.
async function fetchCodexWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
  diagnostic?: CodexDiagnostic,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {

      return await fetch(url, { ...init, signal: diagnostic?.signal, redirect: "error" as const });
    } catch (err) {
      lastErr = err;
      if (diagnostic?.signal?.aborted) throw err;
      if (attempt < attempts) {
        if (diagnostic) logCodexDiagnostic(diagnostic, "retry", err, attempt);
        const backoffMs = 250 * attempt;

        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

async function chatCodexOAuthInner(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  reasoning?: ReasoningLevel,
  diagnostic?: CodexDiagnostic,
) {
  const credentials = await getCodexCredentials();
  const accessToken = credentials.access_token;
  const url = `${CHATGPT_CODEX_BASE}/responses`;

  const messages = normalizeMessagesForResponses(body.messages);
  const accountScope = `oauth:${credentials.account_id || createHash("sha256").update(accessToken).digest("hex")}`;
  const convoKey = conversationKey(body, accountScope, model);
  const reasoningCacheDisabled = process.env.CCX_DISABLE_REASONING_CACHE === "1";
  const plainInput = toResponsesInput(messages);
  const input = reasoningCacheDisabled ? plainInput : replayResponses(convoKey, plainInput);
  const promptCacheKey = convoKey ? threadIdFor(convoKey) : randomUUID();

  const tools = toResponsesTools(body.tools);
  const verbosity = textVerbosity();
  const summary = reasoningSummary();
  const instructions = flattenSystem(body.system);
  const effectiveEffort = effectiveReasoningEffort(body, reasoning);

  // ── Build request body (matches ResponsesApiRequest in codex-rs/codex-api/src/common.rs) ──
  const reqBody: Record<string, unknown> = {
    model,
    instructions,
    input,
    tools,
    tool_choice: toResponsesToolChoice(body.tool_choice),
    parallel_tool_calls: false,
    reasoning: { effort: effectiveEffort, ...(summary ? { summary } : {}) },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey,
  };
  if (verbosity) reqBody.text = { verbosity };

  const installId = installationId();
  if (installId) {
    reqBody.client_metadata = { "x-codex-installation-id": installId };
  }

  // ── Headers ──
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: DEFAULT_ORIGINATOR,
    "User-Agent": codexUserAgent(),
    "OpenAI-Beta": "responses=experimental",
  };
  if (installId) headers["x-codex-installation-id"] = installId;
  if (convoKey) {
    headers.session_id = promptCacheKey;
    headers["session-id"] = promptCacheKey;
  }
  if (credentials.account_id) headers["ChatGPT-Account-ID"] = credentials.account_id;

  const reqJson = JSON.stringify(reqBody);
  if (diagnostic) diagnostic.phase = "connect";
  const upstream = await fetchCodexWithRetry(url, {
    method: "POST",
    headers,
    body: reqJson,
  }, 3, diagnostic);

  await captureCodexRateLimits(upstream.headers);

  if (diagnostic) {
    diagnostic.phase = "http";
    const rid = upstream.headers.get("x-request-id");
    if (rid && /^[a-zA-Z0-9_-]{1,100}$/.test(rid)) diagnostic.upstreamRequestId = rid;
  }

  if (!upstream.ok || !upstream.body) {
    let backendCode: string | undefined;
    try {
      const payload = await upstream.json() as { error?: { code?: unknown; type?: unknown } };
      backendCode = diagnosticCode(payload?.error?.code) || diagnosticCode(payload?.error?.type);
    } catch { /* Backend text is never logged. */ }
    throw new CodexBackendError(upstream.status, backendCode);
  }

  if (diagnostic) diagnostic.phase = "stream";
  await pumpResponsesStream(res, upstream.body, model, reasoningCacheDisabled ? undefined : convoKey, plainInput, diagnostic);
}

// ── SSE pump: Responses API events → Anthropic SSE events ────────────

type StreamState = {
  msgId: string;
  messageStarted: boolean;
  thinkingOpen: boolean;
  textOpen: boolean;
  blockIndex: number;
  funcCallByItemId: Map<string, { blockIndex: number; name: string; callId: string; arguments: string; initialArguments?: string; finalArguments?: string }>;
  completedToolIds: Set<string>;
  emittedText: string;
  responseOutput: ResponseItem[];
  textChars: number;
  thinkingChars: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
};

/**
 * OpenAI reports cached input tokens as a subset of input_tokens, while the
 * Anthropic usage schema uses separate, additive input/cache-read buckets.
 * Split the overlapping OpenAI counts so Anthropic clients do not count the
 * cached portion twice when estimating context usage.
 */
export function splitInputTokenUsage(
  totalInputTokens: number,
  cachedInputTokens: number,
): { inputTokens: number; cacheReadInputTokens: number } {
  const total = Math.max(0, totalInputTokens);
  const cached = Math.min(total, Math.max(0, cachedInputTokens));
  return {
    inputTokens: total - cached,
    cacheReadInputTokens: cached,
  };
}

function makeState(): StreamState {
  return {
    msgId: `msg_${Date.now()}`,
    messageStarted: false,
    thinkingOpen: false,
    textOpen: false,
    blockIndex: 0,
    funcCallByItemId: new Map(),
    completedToolIds: new Set(),
    emittedText: "",
    responseOutput: [],
    textChars: 0,
    thinkingChars: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    stopReason: "end_turn",
  };
}

function ensureMessageStarted(res: FastifyReply, s: StreamState, model: string) {
  if (s.messageStarted) return;
  s.messageStarted = true;
  sendEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: s.msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function openThinking(res: FastifyReply, s: StreamState, model: string) {
  if (s.thinkingOpen) return;
  ensureMessageStarted(res, s, model);
  closeText(res, s);
  s.thinkingOpen = true;
  sendEvent(res, "content_block_start", {
    type: "content_block_start",
    index: s.blockIndex,
    content_block: { type: "thinking", thinking: "" },
  });
}

function closeThinking(res: FastifyReply, s: StreamState) {
  if (!s.thinkingOpen) return;
  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: s.blockIndex });
  s.thinkingOpen = false;
  s.blockIndex += 1;
}

function openText(res: FastifyReply, s: StreamState, model: string) {
  if (s.textOpen) return;
  ensureMessageStarted(res, s, model);
  closeThinking(res, s);
  s.textOpen = true;
  sendEvent(res, "content_block_start", {
    type: "content_block_start",
    index: s.blockIndex,
    content_block: { type: "text", text: "" },
  });
}

function closeText(res: FastifyReply, s: StreamState) {
  if (!s.textOpen) return;
  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: s.blockIndex });
  s.textOpen = false;
  s.blockIndex += 1;
}

function emitTextDelta(res: FastifyReply, s: StreamState, model: string, text: string) {
  if (!text) return;
  openText(res, s, model);
  s.textChars += text.length;
  s.emittedText += text;
  sendEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: s.blockIndex,
    delta: { type: "text_delta", text },
  });
}

// Reconcile cumulative final text with the prefix already sent by delta/done events.
function emitFinalText(res: FastifyReply, s: StreamState, model: string, text: string) {
  if (text.startsWith(s.emittedText)) emitTextDelta(res, s, model, text.slice(s.emittedText.length));
}

type FunctionCallItem = { id?: string; call_id?: string; name?: string; arguments?: string };

function openFunctionCall(res: FastifyReply, s: StreamState, model: string, item: FunctionCallItem) {
  const itemId = item.id || item.call_id || `call_${s.blockIndex}`;
  if (s.completedToolIds.has(itemId) || s.funcCallByItemId.has(itemId)) return;
  ensureMessageStarted(res, s, model);
  closeText(res, s);
  closeThinking(res, s);
  const callId = item.call_id || item.id || itemId;
  s.funcCallByItemId.set(itemId, {
    blockIndex: s.blockIndex, name: item.name || "", callId, arguments: "", initialArguments: item.arguments,
  });
  s.toolCalls += 1;
  sendEvent(res, "content_block_start", {
    type: "content_block_start", index: s.blockIndex,
    content_block: { type: "tool_use", id: callId, name: item.name || "", input: {} },
  });
  s.blockIndex += 1;
  s.stopReason = "tool_use";
}

function finishFunctionCall(res: FastifyReply, s: StreamState, item: FunctionCallItem) {
  const itemId = item.id || item.call_id || "";
  const entry = s.funcCallByItemId.get(itemId);
  if (!entry) return;
  const full = item.arguments ?? entry.finalArguments ?? (entry.initialArguments || entry.arguments || "{}");
  // Never expose serialized arguments or parser errors in diagnostics or client errors.
  try {
    const parsed: unknown = JSON.parse(full);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !full.startsWith(entry.arguments)) throw new Error();
  } catch {
    throw new Error("Invalid Codex function arguments");
  }
  const suffix = full.slice(entry.arguments.length);
  if (suffix) sendEvent(res, "content_block_delta", {
    type: "content_block_delta", index: entry.blockIndex,
    delta: { type: "input_json_delta", partial_json: suffix },
  });
  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: entry.blockIndex });
  s.funcCallByItemId.delete(itemId);
  s.completedToolIds.add(itemId);
}

async function pumpResponsesStream(
  res: FastifyReply,
  body: ReadableStream<Uint8Array>,
  model: string,
  convoKey: string | undefined,
  plainInput: ResponseItem[],
  diagnostic?: CodexDiagnostic,
) {
  let s = makeState();
  const chunks: string[] = [];
  const target = res;
  res = { request: target.request, raw: {
    writableEnded: false,
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: () => {},
  } } as unknown as FastifyReply;
  const reasoningEvents: Record<string, unknown>[] = [];
  const doneItems: Array<{ index: number; item: ResponseItem }> = [];
  const observedEvents: Record<string, unknown>[] = [];
  let completed = false;

  const parser = createParser({
    onEvent: (ev: EventSourceMessage) => {
      if (!ev.data || ev.data === "[DONE]") return;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof json.type === "string" && (
        json.type.startsWith("response.output_text.") || json.type === "response.content_part.done"
        || json.type === "response.output_item.added" || json.type.startsWith("response.function_call_arguments.")
      )) observedEvents.push(json);
      if (json.type === "response.output_item.done" && json.item) {
        const item = json.item as ResponseItem;
        doneItems.push({ index: typeof json.output_index === "number" ? json.output_index : doneItems.length, item });
      }
      let terminalReasoning: ResponseItem[] | undefined;
      if (json.type === "response.completed") {
        const response = (json.response ?? {}) as { output?: ResponseItem[] };
        // Reasoning alone cannot replace text or tools already received.
        if (Array.isArray(response.output) && response.output.length > 0
          && response.output.every(item => item.type === "reasoning") && (s.textChars > 0 || s.toolCalls > 0)) {
          terminalReasoning = response.output;
          delete response.output;
        }
        // Native Codex can finish with output: [] after sending complete text
        // and tool items. Treat that empty terminal list like a missing list so
        // it cannot erase output already received during this successful attempt.
        if (Array.isArray(response.output) && response.output.length === 0) delete response.output;
        const ordered = doneItems.slice().sort((a, b) => a.index - b.index);
        // A missing output is not authoritative. Rebuild only if canonical done
        // items cover every observed text/tool identity, argument prefix and order.
        const textByItem = new Map<ResponseItem, string>();
        const argsByItem = new Map<ResponseItem, string>();
        let lastObservedIndex = -1;
        const covered = ordered.length > 0 && observedEvents.every(event => {
          const added = event.type === "response.output_item.added" ? event.item as ResponseItem & { id?: string } : undefined;
          if (added && added.type !== "function_call") return true;
          const id = added?.id ?? event.item_id ?? event.id;
          const found = ordered.find(({ index, item }) => id !== undefined
            ? ((item as ResponseItem & { id?: string }).id ?? (item.type === "function_call" ? item.call_id : undefined)) === id
            : typeof event.output_index === "number" && index === event.output_index);
          if (!found) return false;
          const { index, item } = found;
          if (typeof event.output_index === "number" && event.output_index !== index) return false;
          if (index < lastObservedIndex) return false;
          lastObservedIndex = index;
          if (added || String(event.type).startsWith("response.function_call_arguments.")) {
            if (item.type !== "function_call" || typeof item.arguments !== "string") return false;
            if (added) return (!added.name || added.name === item.name)
              && (!added.call_id || added.call_id === item.call_id)
              && (typeof added.arguments !== "string" || item.arguments.startsWith(added.arguments));
            if (event.type === "response.function_call_arguments.done") return event.arguments === item.arguments;
            const prefix = (argsByItem.get(item) || "") + String(event.delta ?? "");
            argsByItem.set(item, prefix);
            return item.arguments.startsWith(prefix);
          }
          if (item.type !== "message") return false;
          const full = textFromResponsesMessageItem(item);
          if (event.type === "response.output_text.delta") {
            const prefix = (textByItem.get(item) || "") + String(event.delta ?? "");
            textByItem.set(item, prefix);
            return full.startsWith(prefix);
          }
          const text = event.text ?? (event.part as { text?: string } | undefined)?.text;
          return typeof text === "string" && full.startsWith(text);
        }) && ordered.every(({ index, item }, position) =>
          (position === 0 || ordered[position - 1].index < index)
          && (item.type !== "function_call" || (typeof item.arguments === "string" && !!item.name && !!item.call_id)));
        if (!Array.isArray(response.output) && covered) json.response = { ...response, output: ordered.map(({ item }) => item) };
      }
      if (json.type === "response.completed" && Array.isArray((json.response as { output?: unknown })?.output)) {
        // This attempt has not reached the client. Canonical output can replace
        // partial or missing message deltas without duplicating tools or text.
        chunks.length = 0;
        const msgId = s.msgId;
        s = makeState();
        s.msgId = msgId;
        for (const event of reasoningEvents) handleEvent(res, s, model, event);
      }
      if (typeof json.type === "string" && json.type.startsWith("response.reasoning")) reasoningEvents.push(json);
      handleEvent(res, s, model, json);
      if (terminalReasoning) {
        // Preserve final encrypted reasoning for replay without re-emitting output.
        const additional: ResponseItem[] = [];
        for (const item of terminalReasoning) {
          const id = (item as { id?: string }).id;
          const index = s.responseOutput.findIndex(previous => previous.type === "reasoning"
            && (id ? (previous as { id?: string }).id === id : JSON.stringify(previous) === JSON.stringify(item)));
          if (index < 0) additional.push(item);
          else s.responseOutput[index] = item;
        }
        s.responseOutput.unshift(...additional);
      }
      if (json.type === "response.completed") completed = true;
    },
  });

  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      parser.feed(chunk);
      if (completed) break;
    }
    if (!completed) throw Object.assign(new Error("Codex stream ended before response.completed"), { code: "ECONNRESET" });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  rememberResponse(convoKey, plainInput, s.responseOutput);
  finalize(res, s, model);
  for (const chunk of chunks) target.raw.write(chunk);
  if (!target.raw.writableEnded) target.raw.end();
}

function finalize(res: FastifyReply, s: StreamState, model: string) {
  ensureMessageStarted(res, s, model);
  closeThinking(res, s);
  closeText(res, s);
  for (const id of s.funcCallByItemId.keys()) finishFunctionCall(res, s, { id });
  s.funcCallByItemId.clear();




  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: s.stopReason, stop_sequence: null },
    usage: {
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cache_creation_input_tokens: s.cacheCreationInputTokens,
      cache_read_input_tokens: s.cacheReadInputTokens,
    },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });
  if (!res.raw.writableEnded) res.raw.end();
}

function handleEvent(
  res: FastifyReply,
  s: StreamState,
  model: string,
  json: Record<string, unknown>,
) {
  const type = json.type as string | undefined;
  if (!type) return;

  switch (type) {
    case "response.created":
      return;

    case "response.output_text.delta": {
      const delta = json.delta as string | undefined;
      if (!delta) return;
      emitTextDelta(res, s, model, delta);
      return;
    }

    case "response.output_text.done": {
      // Some Responses streams only expose the full text in the done event.
      // Avoid duplicating normal delta streams by using this as a fallback.
      const text = json.text as string | undefined;
      if (text && s.textChars === 0) emitTextDelta(res, s, model, text);
      return;
    }

    case "response.content_part.done": {
      const part = json.part as { type?: string; text?: string } | undefined;
      const text = part?.type === "output_text" || part?.type === "text" ? part.text : "";
      if (text && s.textChars === 0) emitTextDelta(res, s, model, text);
      return;
    }

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const delta = json.delta as string | undefined;
      if (!delta) return;
      openThinking(res, s, model);
      s.thinkingChars += delta.length;
      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: s.blockIndex,
        delta: { type: "thinking_delta", thinking: delta },
      });
      return;
    }

    case "response.reasoning_summary_part.added":
      // Soft paragraph break between summary parts to keep them readable inside one thinking block.
      if (s.thinkingOpen) {
        sendEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: s.blockIndex,
          delta: { type: "thinking_delta", thinking: "\n\n" },
        });
      }
      return;

    case "response.output_item.added": {
      const item = json.item as (FunctionCallItem & { type?: string }) | undefined;
      if (item?.type === "function_call") openFunctionCall(res, s, model, item);
      return;
    }

    case "response.function_call_arguments.delta": {
      const itemId = (json.item_id || json.id) as string | undefined;
      const delta = json.delta as string | undefined;
      if (!itemId || !delta) return;
      const entry = s.funcCallByItemId.get(itemId);
      if (!entry) return;
      entry.arguments += delta;
      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: entry.blockIndex,
        delta: { type: "input_json_delta", partial_json: delta },
      });
      return;
    }

    case "response.function_call_arguments.done": {
      const entry = s.funcCallByItemId.get((json.item_id || json.id) as string);
      if (entry && typeof json.arguments === "string") entry.finalArguments = json.arguments;
      return;
    }

    case "response.output_item.done": {
      const item = json.item as
        | {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
            content?: Array<{ type?: string; text?: string }>;
            summary?: Array<{ type: string; text: string }>;
            encrypted_content?: string | null;
          }
        | undefined;
      if (!item) return;
      s.responseOutput.push(item as ResponseItem);

      if (item.type === "function_call") {
        openFunctionCall(res, s, model, item);
        finishFunctionCall(res, s, item);
      } else if (item.type === "message") {
        emitFinalText(res, s, model, s.responseOutput.map(textFromResponsesMessageItem).join(""));
      }
      return;
    }

    case "response.completed": {
      const resp = json.response as
        | {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
            };
            end_turn?: boolean;
            output?: ResponseItem[];
          }
        | undefined;
      if (Array.isArray(resp?.output)) s.responseOutput = resp.output;
      let finalText = "";
      for (const item of s.responseOutput) {
        if (item.type === "function_call") {
          openFunctionCall(res, s, model, item);
          finishFunctionCall(res, s, item);
        } else if (item.type === "message") {
          if (Array.isArray(resp?.output)) emitTextDelta(res, s, model, textFromResponsesMessageItem(item));
          else {
            finalText += textFromResponsesMessageItem(item);
            emitFinalText(res, s, model, finalText);
          }
        }
      }
      const u = resp?.usage;
      if (u) {
        const inputUsage = splitInputTokenUsage(
          u.input_tokens ?? 0,
          u.input_tokens_details?.cached_tokens ?? 0,
        );
        s.inputTokens = inputUsage.inputTokens;
        s.outputTokens = u.output_tokens ?? 0;
        s.cacheReadInputTokens = inputUsage.cacheReadInputTokens;
      }
      return;
    }

    case "response.failed":
    case "response.incomplete": {
      const resp = json.response as
        | { error?: { message?: string; code?: unknown; type?: unknown }; incomplete_details?: { reason?: string } }
        | undefined;
      throw new CodexBackendError(200,
        diagnosticCode(resp?.error?.code) || diagnosticCode(resp?.error?.type)
          || diagnosticCode(resp?.incomplete_details?.reason), type);
    }

    default:
      return;
  }
}
