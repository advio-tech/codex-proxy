// All fixtures, identifiers, tokens and conversations in this file are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { FastifyReply } from "fastify";
import type { AnthropicRequest } from "../adapters/types.js";
const auth = vi.hoisted(() => ({ account: "synthetic-account-a" }));
vi.mock("../adapters/openai-auth.js", () => ({
  getCodexCredentials: async () => ({ access_token: "synthetic-token", account_id: auth.account }),
  CodexNativeAuthError: class extends Error {},
}));
import { chatCodexOAuth, toResponsesInput, toResponsesTools } from "../adapters/providers/codex-oauth.js";
import { conversationKey, threadIdFor } from "../adapters/codex-reasoning-cache.js";
import { withAggregatedReply } from "../adapters/sse-aggregator.js";
let fetchMock: ReturnType<typeof vi.fn>;
function completed() {
  const output = [{ type: "function_call", id: "fc-affinity", call_id: "call-affinity", name: "Bash", arguments: '{"command":"echo synthetic"}' }];
  return new Response([
    { type: "response.output_item.added", item: output[0] },
    { type: "response.function_call_arguments.delta", item_id: "fc-affinity", delta: output[0].arguments },
    { type: "response.output_item.done", item: output[0] },
    { type: "response.completed", response: { output, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
}
function body(session?: string): AnthropicRequest {
  return { model: "synthetic-model", messages: [{ role: "user", content: "start" }],
    ...(session ? { metadata: { session_id: session } } : {}),
    tools: [{ name: "Bash", input_schema: { type: "object" } }] };
}
async function send(payload: AnthropicRequest, model = "synthetic-model") {
  let result = "";
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    setHeader() {}, flushHeaders() {}, write(chunk: string) { result += chunk; return true; },
    end(chunk = "") { result += chunk; },
  });
  const reply = { raw, request: { id: "affinity-test" } } as unknown as FastifyReply;
  await withAggregatedReply(reply, buffered => chatCodexOAuth(buffered, payload, model, "medium"));
  return JSON.parse(result);
}
function record(index = -1) {
  const init = fetchMock.mock.calls.at(index)![1] as RequestInit;
  return { headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}
beforeEach(() => {
  auth.account = "synthetic-account-a";
  vi.stubEnv("CCX_NETWORK_RETRIES", "0");
  vi.stubEnv("CCX_NETWORK_RETRY_DELAY_MS", "0");
  vi.stubEnv("CCX_DISABLE_REASONING_CACHE", "0");
  vi.stubEnv("CODEX_FORCE_REASONING_EFFORT", "");
  vi.stubEnv("CODEX_TEXT_VERBOSITY", "");
  vi.stubEnv("CODEX_REASONING_SUMMARY", "");
  fetchMock = vi.fn(async () => completed());
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("session affinity: actual upstream headers", () => {
  it("preserves identity, payload and usage across tools and connection retry", async () => {
    const payload = body("affinity-append");
    const firstResponse = await send(payload);
    const first = record();
    const expected = threadIdFor(conversationKey(payload, "oauth:synthetic-account-a", "synthetic-model")!);
    expect(first.headers.session_id).toBe(expected);
    expect(first.headers["session-id"]).toBe(expected);
    expect(first.body.prompt_cache_key).toBe(expected);
    expect(first.body).toEqual({ model: "synthetic-model", instructions: "", input: toResponsesInput(payload.messages),
      tools: toResponsesTools(payload.tools), tool_choice: "auto", parallel_tool_calls: false,
      reasoning: { effort: "medium", summary: "auto" }, store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: expected });
    expect(firstResponse.content).toEqual([{ type: "tool_use", id: "call-affinity", name: "Bash", input: { command: "echo synthetic" } }]);
    expect(firstResponse.usage).toMatchObject({ input_tokens: 7, cache_read_input_tokens: 5, output_tokens: 4 });
    payload.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "call-affinity", name: "Bash", input: { command: "echo synthetic" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-affinity", content: "synthetic" }] });
    fetchMock.mockRejectedValueOnce(new TypeError("synthetic connection", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }));
    await send(payload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const index of [1, 2]) {
      expect(record(index).headers.session_id).toBe(expected);
      expect(record(index).headers["session-id"]).toBe(expected);
      expect(record(index).body.prompt_cache_key).toBe(expected);
    }
    expect(record(1)).toEqual(record(2));
    expect(record().body.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call-affinity")).toBe(true);
  });
  it("preserves identity across recovery retry", async () => {
      vi.stubEnv("CCX_NETWORK_RETRIES", "1");
    fetchMock.mockResolvedValueOnce(new Response("synthetic unavailable", { status: 503 }));
    await send(body("affinity-outer"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(record(0)).toEqual(record(1));
  });
  it("separates sessions, accounts and models", async () => {
    await send(body("affinity-scope-a")); const a = record();
    await send(body("affinity-scope-b")); const b = record();
    auth.account = "synthetic-account-b";
    await send(body("affinity-scope-a")); const c = record();
    await send(body("affinity-scope-a"), "synthetic-other-model"); const d = record();
    expect(new Set([a,b,c,d].map(r => r.headers.session_id)).size).toBe(4);
    for (const r of [a,b,c,d]) expect(r.headers["session-id"]).toBe(r.body.prompt_cache_key);
  });
  it.each([undefined, { session_id: " " }, { user_id: "unrecognized" }])("anonymous requests do not share session headers or body identity: %j", async metadata => {
    const payload = { ...body(), metadata };
    await send(payload); const first = record();
    await send(payload); const second = record();
    for (const r of [first,second]) {
      expect(r.headers).not.toHaveProperty("session_id"); expect(r.headers).not.toHaveProperty("session-id");
      expect(r.body.prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.input).toEqual(toResponsesInput(payload.messages));
    }
    expect(first.body.prompt_cache_key).not.toBe(second.body.prompt_cache_key);
  });
  it.each([
    { user_id: JSON.stringify({ session_id: "affinity-json" }) },
    { user_id: "user_account_session_12345678-1234-1234-1234-123456789abc" },
  ])("uses cache identity recognition: %j", async metadata => {
    const payload = { ...body(), metadata }; await send(payload);
    const expected = threadIdFor(conversationKey(payload, "oauth:synthetic-account-a", "synthetic-model")!);
    expect(record().headers.session_id).toBe(expected); expect(record().headers["session-id"]).toBe(expected);
  });
});
