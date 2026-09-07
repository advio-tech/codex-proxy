// All fixtures, identifiers, tokens and conversations in this file are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { request as loopbackRequest } from "http";
import type { FastifyReply } from "fastify";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, rename, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { FastifyInstance } from "fastify";

// Isolate the legacy proxy cache without using the real HOME.
const isolated = vi.hoisted(() => ({ home: `/tmp/ccx-native-home-${process.pid}` }));
vi.mock("os", async (original) => ({
  ...await original<typeof import("os")>(),
  homedir: () => isolated.home,
}));
import {
  codexAuthFile,
  getCodexAccessToken, getCodexAccountId, getCodexLoginStatus,
} from "../adapters/openai-auth.js";
import { createGateway } from "../adapters/anthropic-gateway.js";
import { parseProviderModel } from "../adapters/map.js";
import { chatCodexOAuth } from "../adapters/providers/codex-oauth.js";

let root: string;
let app: FastifyInstance | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const jwt = (claims: object) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const future = () => Math.floor(Date.now() / 1000) + 3600;
async function credentials(account = "synthetic-account", exp: number | undefined = future(), explicitAccount = true) {
  const token = jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } });
  const data = JSON.stringify({ tokens: { access_token: token, refresh_token: "synthetic-refresh",
    ...(explicitAccount ? { account_id: account } : {}) }, last_refresh: "untouched" });
  await writeFile(join(root, "new-auth.json"), data);
  await rename(join(root, "new-auth.json"), codexAuthFile());
  return { token, data };
}
function sse(events: object[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
function clientContent(body: string) {
  const blocks: any[] = [];
  for (const event of body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block };
    if (event.delta?.type === "text_delta") blocks[event.index].text += event.delta.text;
    if (event.delta?.type === "thinking_delta") blocks[event.index].thinking += event.delta.thinking;
    if (event.delta?.type === "input_json_delta") blocks[event.index].serialized = (blocks[event.index].serialized || "") + event.delta.partial_json;
  }
  return blocks.map(block => {
    if (block.type === "tool_use") { block.input = JSON.parse(block.serialized || "{}"); delete block.serialized; }
    return block;
  });
}
function fakeBackend() {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url !== "https://chatgpt.com/backend-api/codex/responses" || init.redirect !== "error") {
      throw new Error("Unexpected upstream in test");
    }
    return sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Bash" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"echo synthetic"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1" } },
      { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 4 } } },
    ]);
  });
}
async function request(model: string, stream = false) {
  app ||= createGateway();
  return app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "synthetic-client-secret" },
    payload: { model, stream, messages: [{ role: "user", content: "synthetic-private-prompt" }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }] } });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-native-"));
  await mkdir(isolated.home, { recursive: true });
  vi.stubEnv("CCX_NETWORK_RETRIES", "0");
  vi.stubEnv("CODEX_HOME", root);
  vi.stubEnv("CODEX_AUTH_FILE", "");
  vi.stubEnv("CCX_DEFAULT_MODEL", "gpt-6.1-sol");
  vi.stubEnv("CODEX_REASONING_EFFORT", "");
  vi.stubEnv("CCX_DIRECT_LOG", join(root, "requests.log"));
  fetchMock = vi.fn(() => { throw new Error("External fetch prohibited"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
  await rm(isolated.home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native Codex credentials", () => {
  it("proxy OAuth routes are absent by default", async () => {
      app = createGateway();
    expect((await app.inject({ url: "/codex/login/start" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/codex/logout" })).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rereads credentials per request without writes or proxy cache", async () => {
    fakeBackend();
    const first = await credentials("account-first");
    expect((await request("sonnet")).statusCode).toBe(200);
    expect(await readFile(codexAuthFile(), "utf-8") === first.data).toBe(true);
    const second = await credentials("account-second");
    expect((await request("claude-internal-model")).statusCode).toBe(200);
    const headers = fetchMock.mock.calls.map(([, init]) => init.headers);
    // Boolean checks never print credentials on failure.
    expect(headers[0].Authorization === `Bearer ${first.token}`).toBe(true);
    expect(headers[1].Authorization === `Bearer ${second.token}`).toBe(true);
    expect(headers[0]["ChatGPT-Account-ID"] === "account-first").toBe(true);
    expect(headers[1]["ChatGPT-Account-ID"] === "account-second").toBe(true);
    expect(await readFile(codexAuthFile(), "utf-8") === second.data).toBe(true);
    await expect(access(join(isolated.home, ".legacy-proxy", "codex-oauth.json"))).rejects.toThrow();
  });

  it("ignores existing legacy proxy cache", async () => {
    await mkdir(join(isolated.home, ".legacy-proxy"), { recursive: true });
    const cache = join(isolated.home, ".legacy-proxy", "codex-oauth.json");
    const legacy = JSON.stringify({ access_token: "synthetic-legacy", refresh_token: "synthetic-legacy-refresh", expires_at: Date.now() + 3600000 });
    await writeFile(cache, legacy);
    const native = await credentials();
    expect(await getCodexAccessToken() === native.token).toBe(true);
    expect(await readFile(cache, "utf-8") === legacy).toBe(true);
  });

  it.each([0, undefined])("expired or unknown expiry returns 401 without refresh or writes (%s)", async (expiry) => {
    const original = await credentials("synthetic-account", expiry === undefined ? 0 : expiry);
    if (expiry === undefined) {
      await writeFile(codexAuthFile(), JSON.stringify({ tokens: { access_token: jwt({}), refresh_token: "synthetic-refresh" } }));
    }
    const before = await readFile(codexAuthFile(), "utf-8");
    const response = await request("opus", true);
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain("Proxy does not refresh");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(codexAuthFile(), "utf-8") === before).toBe(true);
    expect(response.body.includes(original.token)).toBe(false);
    expect((await getCodexLoginStatus()).loggedIn).toBe(false);
  });

  it("does not rotate a valid token near expiry; updated cache restores access", async () => {
    await credentials("synthetic-account", 0);
    expect((await request("haiku")).statusCode).toBe(401);
    const renewed = await credentials("synthetic-account", Math.floor(Date.now() / 1000) + 60);
    fakeBackend();
    expect((await request("haiku")).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readFile(codexAuthFile(), "utf-8") === renewed.data).toBe(true);
  });

  it("reads account and token claims from an explicit auth path", async () => {
    await credentials("explicit-id");
    expect(getCodexAccountId() === "explicit-id").toBe(true);
    await credentials("claim-id", future(), false);
    expect(getCodexAccountId() === "claim-id").toBe(true);
    const override = join(root, "override.json");
    await writeFile(override, JSON.stringify({ tokens: { access_token: jwt({ exp: future() }),
      id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "id-claim" } }) } }));
    vi.stubEnv("CODEX_AUTH_FILE", override);
    expect(getCodexAccountId() === "id-claim").toBe(true);
    expect((await getCodexLoginStatus()).loggedIn).toBe(true);
  });

  it("missing or malformed auth never causes fallback or fetch", async () => {
    await expect(getCodexAccessToken()).rejects.toThrow("auth.json");
    await writeFile(codexAuthFile(), "malformed synthetic");
    expect((await request("codex")).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OAuth routes are absent; status does not expose account identity", async () => {
    await credentials();
    app = createGateway();
    for (const [method, url] of [["GET", "/codex/login"], ["GET", "/codex/login/start"],
      ["GET", "/codex/callback?code=synthetic&state=synthetic"], ["POST", "/codex/logout"],
      ["GET", "/google/login/start"], ["POST", "/google/logout/2"]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    const status = (await app.inject({ url: "/codex/status" })).json();
    expect(status).toEqual({ loggedIn: true, expiresAt: expect.any(Number), source: "codex-cli", backendAccepted: "not_checked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Native-only routing and Messages/SSE", () => {
  it.each(["opus", "sonnet", "haiku", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-internal-model", "opus[1m]", "sonnet[1m]"])("%s → configured gpt-6.1-sol@medium", (model) => {
    expect(parseProviderModel(model, { provider: "codex-oauth", model: "codex-another", reasoning: "high" }))
      .toEqual({ provider: "codex-oauth", model: "gpt-6.1-sol", reasoning: "medium" });
  });

  it("accepts Codex model families, effort and configured defaults", () => {
    expect(parseProviderModel("codex-future-model", { provider: "codex-oauth", model: "codex-previous", reasoning: "high" }).reasoning).toBe("medium");
    expect(() => parseProviderModel("gpt-6.1-sol@")).toThrow("@effort");
    expect(() => parseProviderModel("gpt-6.1-sol@unsupported")).toThrow("@effort");
    for (const model of ["gpt-6.1-sol", "codex-future-model", "codex-oauth:codex-future-model", "codex-oauth/codex-future-model"]) {
      expect(parseProviderModel(`${model}@xhigh`)).toEqual({ provider: "codex-oauth", model: model.replace(/^codex-oauth[:/]/, ""), reasoning: "xhigh" });
    }
    vi.stubEnv("CCX_DEFAULT_MODEL", "codex-future-model@low");
    expect(parseProviderModel("haiku")).toEqual({ provider: "codex-oauth", model: "codex-future-model", reasoning: "low" });
    expect(parseProviderModel("sonnet@max").reasoning).toBe("max");
  });

  it.each(["anthropic:claude-opus-4-8", "openrouter:anything", "openai:gpt-6.1-sol", "gemini:some-model",
    "gemini-oauth:anything", "glm:anything", "cline-pass:anything", "unknown:model", "unknown/model", "claude-unknown:external", "gemini", "glm-5.2", "anthropic", "openai", "openrouter"])("%s is rejected before fetch", async (model) => {
    expect((await request(model)).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("health and status reflect model and effort; legacy provider env is ignored", async () => {
    app = createGateway();
    const expected = { provider: "codex-oauth", model: "gpt-6.1-sol", reasoning: "medium" };
    expect((await app.inject({ url: "/_status" })).json()).toEqual(expected);
    expect((await app.inject({ url: "/healthz" })).json().active).toEqual(expected);
    await credentials();
    fakeBackend();
    await request("codex-oauth:codex-future-model@xhigh");
    expect((await app.inject({ url: "/_status" })).json()).toEqual({ ...expected, model: "codex-future-model", reasoning: "xhigh" });
    expect((await app.inject({ url: "/unknown-provider/route" })).statusCode).toBe(404);
    vi.stubEnv("CCX_DEFAULT_PROVIDER", "anthropic");
    expect((await request("sonnet")).statusCode).toBe(200);
  });

  it("legacy provider, auth and API key environment cannot activate another backend", async () => {
    for (const [name, value] of Object.entries({
      CODEX_ONLY: "0", CODEX_AUTH_SOURCE: "proxy", CCX_DEFAULT_PROVIDER: "external",
      OPENAI_API_KEY: "synthetic-key", OPENROUTER_API_KEY: "synthetic-key",
      GEMINI_API_KEY: "synthetic-key", ANTHROPIC_API_KEY: "synthetic-key",
      ANTHROPIC_UPSTREAM_URL: "https://synthetic.invalid", GLM_UPSTREAM_URL: "https://synthetic.invalid",
      ZAI_API_KEY: "synthetic-key", GLM_API_KEY: "synthetic-key",
    })) vi.stubEnv(name, value);
    await credentials();
    fakeBackend();
    expect((await request("sonnet")).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect((await request("unknown-model")).statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves stream tool calls and nonstream aggregation without request logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await credentials();
    fakeBackend();
    const streamed = await request("claude-internal-model", true);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    const events = streamed.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    expect(events.find((e) => e.type === "content_block_start").content_block).toEqual({ type: "tool_use", id: "call_1", name: "Bash", input: {} });
    expect(events.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join(""))
      .toBe('{"command":"echo synthetic"}');
    expect(events.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    const aggregated = (await request("sonnet")).json();
    expect(aggregated.content).toEqual([{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo synthetic" } }]);
    expect(aggregated.stop_reason).toBe("tool_use");
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.model).toBe("gpt-6.1-sol");
    expect(sent.reasoning.effort).toBe("medium");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await expect(access(join(root, "requests.log"))).rejects.toThrow();
  });

  it("hides backend errors and never exposes backend text", async () => {
    await credentials();
    fetchMock.mockResolvedValue(new Response("synthetic-backend-secret", { status: 401 }));
    const response = await request("codex", true);
    expect(response.body).toContain("Codex backend HTTP 401");
    expect(response.body.includes("synthetic-backend-secret")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("safe Codex failure diagnostics", () => {
  it("records HTTP status and known error code without credentials or backend text", async () => {
    const auth = await credentials();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "rate_limit_exceeded", message: "synthetic-private-prompt synthetic-refresh",
    } }), { status: 429, headers: { "x-request-id": "req_synthetic" } }));
    await request("gpt-6.1-sol");
    const log = error.mock.calls.map(c => c.join(" ")).join("\n");
    expect(log).toContain('"status":429');
    expect(log).toContain('"code":"rate_limit_exceeded"');
    expect(log).toContain('"upstreamRequestId":"req_synthetic"');
    expect(log).not.toContain(auth.token);
    expect(log).not.toContain("synthetic-private-prompt");
    expect(log).not.toContain("synthetic-refresh");
    expect(log).not.toContain("synthetic-account");
  });

  it("records network cause and retries, without printing Error.message", async () => {
    await credentials();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("synthetic-private-prompt", {
      cause: Object.assign(new Error("synthetic-refresh"), { code: "ECONNRESET" }),
    }));
    await request("gpt-6.1-sol");
    const logs = error.mock.calls.map(c => JSON.parse(String(c[0]).replace("[codex-diagnostic] ", "")));
    expect(logs.map(l => l.outcome)).toEqual(["retry", "retry", "failed"]);
    expect(new Set(logs.map(l => l.requestId)).size).toBe(1);
    expect(logs[2]).toMatchObject({ phase: "connect", code: "ECONNRESET", category: "network" });
    expect(JSON.stringify(logs)).not.toContain("synthetic-private-prompt");
    expect(JSON.stringify(logs)).not.toContain("synthetic-refresh");
  });

  it("records response.failed after streaming begins, even if tools are in progress", async () => {
    await credentials();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "Bash" } },
      { type: "response.failed", response: { error: { code: "server_error", message: "synthetic-private-prompt" } } },
    ]));
    await request("gpt-6.1-sol", true);
    expect(error).toHaveBeenCalledTimes(1);
    const log = String(error.mock.calls[0][0]);
    expect(log).toContain('"phase":"stream"');
    expect(log).toContain('"event":"response.failed"');
    expect(log).toContain('"code":"server_error"');
    expect(log).not.toContain("synthetic-private-prompt");
  });

  it("does not log unknown backend error identifiers", async () => {
    await credentials();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: {
      code: "synthetic-refresh", type: "synthetic-private-prompt",
    } }), { status: 400 }));
    await request("gpt-6.1-sol");
    const log = String(error.mock.calls[0][0]);
    expect(log).toContain('"code":"unrecognized"');
    expect(log).not.toContain("synthetic-refresh");
    expect(log).not.toContain("synthetic-private-prompt");
  });
});


describe("VPN recovery", () => {
  beforeEach(() => {
    vi.stubEnv("CCX_NETWORK_RETRIES", "2");
    vi.stubEnv("CCX_NETWORK_RETRY_DELAY_MS", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("continues retrying after connection attempts fail and resumes on recovery", async () => {
    await credentials();
    fakeBackend();
    const error = new TypeError("network down", { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    fetchMock.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    const response = await request("gpt-6.1-sol", true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(response.body).toContain('"stop_reason":"tool_use"');
    expect(response.body).not.toContain('event: error');
    expect(response.body).not.toContain('codex proxy error');
  });

  it("discards interrupted partial output and tools before replaying the request", async () => {
    await credentials();
    fakeBackend();
    let reads = 0;
    const chunk = new TextEncoder().encode([
      { type: "response.output_text.delta", delta: "discarded partial text" },
      { type: "response.output_item.added", item: { type: "function_call", id: "aborted-tool", call_id: "old-call", name: "Bash" } },
      { type: "response.function_call_arguments.delta", item_id: "aborted-tool", delta: '{"command":"discarded command"}' },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(chunk);
      else controller.error(new TypeError("terminated", { cause: Object.assign(new Error("read timeout"), { code: "ETIMEDOUT" }) }));
    } })));
    const response = await request("gpt-6.1-sol", true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain("discarded partial text");
    expect(response.body).not.toContain("discarded command");
    expect(response.body).not.toContain("old-call");
    expect(response.body.match(/event: message_start\n/g)).toHaveLength(1);
    expect(response.body.match(/event: message_stop\n/g)).toHaveLength(1);
    expect(response.body).toContain('"stop_reason":"tool_use"');
  });

  it("retries a clean EOF without response.completed", async () => {
    await credentials();
    fakeBackend();
    fetchMock.mockResolvedValueOnce(sse([{ type: "response.output_text.delta", delta: "truncated" }]));
    const response = await request("gpt-6.1-sol");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain("truncated");
    expect(response.json().stop_reason).toBe("tool_use");
  });

  it("returns a genuine API error rather than a successful end_turn on failure", async () => {
    await credentials();
    vi.stubEnv("CCX_NETWORK_RETRIES", "0");
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const response = await request("gpt-6.1-sol");
    expect(response.statusCode).toBe(503);
    expect(response.json().type).toBe("error");
    expect(response.json().error.type).toBe("api_error");
    expect(response.body).not.toContain("end_turn");
  });

  it("stops outstanding fetch and all retries when Claude disconnects", async () => {
    await credentials();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      started();
    }));
    const raw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
      write: vi.fn(), end: vi.fn() });
    const pending = chatCodexOAuth({ raw } as unknown as FastifyReply,
      { model: "gpt-6.1-sol", stream: true, messages: [{ role: "user", content: "synthetic prompt" }] }, "gpt-6.1-sol");
    await entered;
    raw.destroyed = true;
    raw.emit("close");
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raw.write).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
