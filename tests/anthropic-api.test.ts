// Every key, identifier and conversation in this file is synthetic. No live API calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request as loopbackRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createGateway } from "../adapters/anthropic-gateway.js";

let root: string;
let app: FastifyInstance | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const clients = new Set<ClientRequest>();
const payload = () => ({ model: "claude-synthetic-model", max_tokens: 100,
  messages: [{ role: "user", content: "Synthetic question" }] });
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function post(body: unknown = payload(), url = "/v1/messages", headers: Record<string, string> = {}) {
  app ||= createGateway();
  return app.inject({ method: "POST", url, headers, payload: body as object });
}

async function liveRequest(onResponse?: (response: IncomingMessage) => void) {
  app ||= createGateway();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port");
  const client = loopbackRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/messages",
    method: "POST", headers: { "content-type": "application/json" } }, onResponse);
  clients.add(client);
  client.on("error", () => {});
  client.end(JSON.stringify({ ...payload(), stream: true }));
  return client;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-anthropic-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("CODEX_HOME", root);
  vi.stubEnv("CODEX_AUTH_FILE", join(root, "absent-auth.json"));
  vi.stubEnv("CLAUDE_PROXY_BACKEND", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-server-key");
  // Client settings must never become the upstream endpoint or credentials.
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-wrong-bearer");
  vi.stubEnv("CCX_DEFAULT_MODEL", "invalid-for-codex");
  fetchMock = vi.fn(async () => jsonResponse({ id: "msg_synthetic", content: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("direct Claude API backend", () => {
  it("starts and reports health without Codex credentials or a Codex model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    app = createGateway();
    expect((await app.inject({ url: "/healthz" })).json()).toEqual({ ok: true, active: { provider: "anthropic" } });
    expect((await app.inject({ url: "/_status" })).json()).toEqual({ provider: "anthropic" });
    expect((await app.inject({ url: "/codex/status" })).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown backend rather than falling back to another account", () => {
    vi.stubEnv("CLAUDE_PROXY_BACKEND", "unsupported");
    expect(() => createGateway()).toThrow("CLAUDE_PROXY_BACKEND must be codex-oauth or anthropic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards tools, history, metadata, thinking and unknown fields without Codex transformations", async () => {
    const body = { ...payload(), system: [{ type: "text", text: "Synthetic instructions", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "synthetic" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "Synthetic thought", signature: "synthetic-signature" },
          { type: "tool_use", id: "tool_synthetic", name: "Read", input: { file_path: "synthetic.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_synthetic", content: "Synthetic contents" }] },
      ],
      tools: [{ name: "WebSearch", input_schema: { type: "object" } },
        { name: "mcp__synthetic__read", defer_loading: true, input_schema: { type: "object" } }],
      tool_choice: { type: "auto" }, metadata: { user_id: "synthetic-client-session" },
      thinking: { type: "adaptive" }, output_config: { effort: "high" }, future_api_field: { preserved: true } };
    expect((await post(body)).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual(body);
    expect((await app!.inject({ url: "/_status" })).json()).toEqual({ provider: "anthropic", model: body.model });
  });

  it("uses the server API key and preserves client attribution, API version and beta headers", async () => {
    await post(payload(), "/v1/messages?beta=true", {
      authorization: "Bearer synthetic-client-token", "x-api-key": "synthetic-client-key",
      cookie: "synthetic-local-cookie", "proxy-authorization": "synthetic-proxy-token",
      connection: "keep-alive, x-private-hop", "x-private-hop": "must-not-forward",
      "user-agent": "synthetic-claude-code", "x-app": "cli", "x-stainless-package-version": "synthetic-version",
      "anthropic-version": "2023-06-01", "anthropic-beta": "synthetic-beta",
    });
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(headers.get("x-api-key") === "synthetic-server-key").toBe(true);
    for (const name of ["authorization", "cookie", "proxy-authorization", "connection", "x-private-hop", "host", "content-length"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.get("user-agent")).toBe("synthetic-claude-code");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("x-stainless-package-version")).toBe("synthetic-version");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe("synthetic-beta");
  });

  it("requires a configured server key even when the client supplies credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const response = await post(payload(), "/v1/messages", {
      authorization: "Bearer synthetic-client-token", "x-api-key": "synthetic-client-key",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toBe("ANTHROPIC_API_KEY is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rereads the configured key for each request without touching credential files", async () => {
    await post();
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-replacement-key");
    await post();
    const headers = fetchMock.mock.calls.map(([, init]) => new Headers(init.headers));
    expect(headers[0].get("x-api-key") === "synthetic-server-key").toBe(true);
    expect(headers[1].get("x-api-key") === "synthetic-replacement-key").toBe(true);
  });

  it("forwards token counting to its original endpoint with all options intact", async () => {
    const body = { ...payload(), thinking: { type: "adaptive" } };
    fetchMock.mockResolvedValue(jsonResponse({ input_tokens: 123 }));
    const response = await post(body, "/v1/messages/count_tokens?beta=true");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 123 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
  });

  it("preserves JSON bytes, tool calls, usage and request IDs without SSE aggregation", async () => {
    const body = '{ "id": "msg_synthetic", "content": [{"type":"tool_use","id":"tool_synthetic","name":"Read","input":{}}], "usage": {"input_tokens": 12, "output_tokens": 5, "cache_read_input_tokens": 8} }';
    fetchMock.mockResolvedValue(new Response(body, { headers: {
      "content-type": "application/json", "request-id": "req_synthetic", "anthropic-ratelimit-requests-remaining": "42",
      "content-encoding": "gzip", "content-length": "9999", "set-cookie": "synthetic-upstream-cookie",
      connection: "x-private-hop", "x-private-hop": "must-not-forward",
    } }));
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers["request-id"]).toBe("req_synthetic");
    expect(response.headers["anthropic-ratelimit-requests-remaining"]).toBe("42");
    for (const name of ["content-encoding", "set-cookie", "x-private-hop"]) expect(response.headers[name]).toBeUndefined();
    expect(response.headers["content-length"]).not.toBe("9999");
  });

  it.each([400, 401, 402, 429, 500, 503])("preserves upstream HTTP %i and error details without retries", async status => {
    const body = { type: "error", error: { type: "synthetic_api_error", message: "Synthetic upstream error" }, request_id: "req_synthetic" };
    fetchMock.mockResolvedValue(jsonResponse(body, status, { "retry-after": "7" }));
    const response = await post({ ...payload(), stream: true });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
    expect(response.headers["retry-after"]).toBe("7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves SSE error events and tool argument fragments byte for byte", async () => {
    const body = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Synthetic overload"}}\n\n';
    fetchMock.mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const response = await post({ ...payload(), stream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams the first event before the upstream response completes", async () => {
    const first = 'event: ping\ndata: {"type":"ping"}\n\n';
    const last = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockImplementation(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ start(stream) {
        controller = stream;
        stream.enqueue(Buffer.from(first));
        init.signal.addEventListener("abort", () => stream.error(new Error("Synthetic abort")), { once: true });
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    let text = "";
    let complete = false;
    await liveRequest(response => {
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => { complete = true; });
    });
    await vi.waitFor(() => expect(text).toBe(first));
    expect(complete).toBe(false);
    controller.enqueue(Buffer.from(last));
    controller.close();
    await vi.waitFor(() => expect(complete).toBe(true));
    expect(text).toBe(first + last);
  });

  it("aborts upstream fetch when the client disconnects before response headers", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener("abort", () => reject(new Error("Synthetic abort")), { once: true });
    }));
    const client = await liveRequest();
    await vi.waitFor(() => expect(signal).toBeDefined());
    client.destroy();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the upstream stream when the client disconnects after the first event", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n'));
        signal!.addEventListener("abort", () => stream.error(new Error("Synthetic abort")), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    await liveRequest(response => response.once("data", () => response.destroy()));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a sanitized transport error without exposing credentials or request details", async () => {
    fetchMock.mockRejectedValue(new Error("synthetic-server-key synthetic-private-prompt"));
    const response = await post();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ type: "error", error: { type: "api_error", message: "Claude API request failed" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose internal stream errors before the first response byte", async () => {
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(stream) {
      stream.error(new Error("synthetic-server-key synthetic-private-prompt"));
    } }), { headers: { "content-type": "text/event-stream" } }));
    const response = await post();
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("Claude API response stream failed");
    expect(response.body).not.toContain("synthetic-server-key");
    expect(response.body).not.toContain("synthetic-private-prompt");
  });
});
