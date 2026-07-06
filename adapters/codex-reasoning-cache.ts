// Replay completed Responses output at its original position, scoped to a real
// client session, upstream account and model. Never infer identity from prompt text.
import { createHash } from "crypto";
import type { AnthropicRequest } from "./types.js";
import type { ResponseItem } from "./providers/codex-oauth.js";

type Turn = { start: number; prefix: string; visible: string; count: number; output: ResponseItem[] };
type Entry = { turns: Turn[]; lastAccess: number };
const TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
const cache = new Map<string, Entry>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function sessionIdFrom(body: AnthropicRequest): string | undefined {
  if (typeof body.metadata?.session_id === "string" && body.metadata.session_id.trim()) return body.metadata.session_id;
  const userId = body.metadata?.user_id;
  if (!userId) return undefined;
  try {
    const parsed = JSON.parse(userId);
    if (typeof parsed?.session_id === "string" && parsed.session_id.trim()) return parsed.session_id;
  } catch { /* Older Claude Code versions used a structured string. */ }
  return /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(userId)?.[1];
}

export function conversationKey(body: AnthropicRequest, account: string, model: string): string | undefined {
  const session = sessionIdFrom(body);
  return session ? hash(["codex-session-v2", account, model, session]) : undefined;
}

export function threadIdFor(key: string): string {
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
}

function reap() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of cache) if (entry.lastAccess < cutoff) cache.delete(key);
}

// Match adjacent client text blocks while retaining every tool position.
// Keep native IDs, reasoning and hidden items only in the original output.
export function visibleOutput(output: ResponseItem[]): ResponseItem[] {
  const visible: ResponseItem[] = [];
  let text = "";
  const flush = () => {
    if (text) visible.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    text = "";
  };
  for (const item of output) {
    if (item.type === "message" && item.role === "assistant") {
      for (const part of item.content) if (part.type === "output_text") text += part.text;
    } else if (item.type === "function_call") {
      flush();
      visible.push(item);
    }
  }
  flush();
  return visible;
}

function fingerprint(items: ResponseItem[]): string {
  return hash(items.map((item) => {
    if (item.type === "message") return { type: item.type, role: item.role, content: item.content };
    if (item.type === "function_call") {
      let args: unknown = item.arguments;
      try { args = JSON.parse(item.arguments); } catch { /* Preserve malformed JSON literally. */ }
      return { type: item.type, call_id: item.call_id, name: item.name, arguments: args };
    }
    return item;
  }));
}

export function rememberResponse(key: string | undefined, input: ResponseItem[], output: ResponseItem[]) {
  if (!key || !output.length) return;
  const visible = visibleOutput(output);
  // No assistant text/tool calls means there is no reliable client-side anchor.
  if (!visible.length) return;
  reap();
  const entry = cache.get(key) ?? { turns: [], lastAccess: Date.now() };
  const turn = { start: input.length, prefix: fingerprint(input), visible: fingerprint(visible),
    count: visible.length, output: structuredClone(output) };
  const existing = entry.turns.find((t) => t.start === turn.start && t.prefix === turn.prefix && t.visible === turn.visible);
  // Identical retries must not replace reasoning already replayed in a prefix.
  if (!existing) entry.turns.push(turn);
  entry.lastAccess = Date.now();
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_SESSIONS) cache.delete(cache.keys().next().value!);
}

export function replayResponses(key: string | undefined, input: ResponseItem[]): ResponseItem[] {
  if (!key) return input;
  reap();
  const entry = cache.get(key);
  if (!entry) return input;
  entry.lastAccess = Date.now();
  const out: ResponseItem[] = [];
  for (let i = 0; i < input.length;) {
    const turn = entry.turns.find((t) => t.start === i && t.count <= input.length - i
      && t.visible === fingerprint(input.slice(i, i + t.count))
      && t.prefix === fingerprint(input.slice(0, i)));
    if (turn) { out.push(...structuredClone(turn.output)); i += turn.count; }
    else { out.push(input[i]); i++; }
  }
  return out;
}
