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

describe("gateway Responses history replay", () => {
  it.each([false, true])("keeps complete output across three concurrent sessions (missing completed output: %s)", async (emptyCompletedOutput) => {
    await credentials();
    app = createGateway();
    const rounds = new Map<string, number>();
    const sent = new Map<string, any[]>();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      const id = req.prompt_cache_key;
      const round = (rounds.get(id) || 0) + 1;
      rounds.set(id, round);
      const records = sent.get(id) || []; records.push(req); sent.set(id, records);
      const out = [
        { type: "reasoning", id: `rs-${id}-${round}`, summary: [], encrypted_content: `${id}-${round}` },
        { type: "message", id: `msg-${id}-${round}`, role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: `answer ${round}`, annotations: [] }] },
      ];
      return sse([
        ...out.map((item) => ({ type: "response.output_item.done", item })),
        { type: "response.completed", response: { output: emptyCompletedOutput ? undefined : out, usage: { input_tokens: 20, output_tokens: 4 } } },
      ]);
    });
    const histories = new Map<string, any[]>(["a", "b", "c"].map((id) => [id, [{ role: "user", content: "same shared brief" }]]));
    for (let round = 1; round <= 3; round++) {
      await Promise.all([...histories].map(async ([id, messages]) => {
        const response = await app!.inject({ method: "POST", url: "/v1/messages", payload: {
          model: "codex-oauth:gpt-6.1-sol@medium", stream: false, messages,
          metadata: { user_id: JSON.stringify({ session_id: `integration-${id}` }) },
        } });
        expect(response.statusCode).toBe(200);
        expect(response.json().content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")).toBe(`answer ${round}`);
        messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${round}` }] }, { role: "user", content: `next ${round}` });
      }));
    }
    expect(sent.size).toBe(3);
    for (const [id, records] of sent) {
      expect(records).toHaveLength(3);
      for (let i = 0; i < records.length; i++) {
        expect(records[i].reasoning.effort).toBe("medium");
        expect(records[i].input.filter((item: any) => item.type === "reasoning").map((item: any) => item.encrypted_content))
          .toEqual(Array.from({ length: i }, (_, r) => `${id}-${r + 1}`));
        if (i) expect(records[i].input.slice(0, records[i - 1].input.length)).toEqual(records[i - 1].input);
      }
    }
  });
  it("does not save reasoning from an interrupted response", async () => {
    await credentials(); app = createGateway();
    vi.stubEnv("CCX_NETWORK_RETRIES", "0");
    const payload = { model: "codex-oauth:gpt-6.1-sol@medium", stream: false,
      metadata: { user_id: JSON.stringify({ session_id: "interrupted-integration" }) },
      messages: [{ role: "user", content: "start" }] };
    fetchMock.mockResolvedValue(sse([{ type: "response.output_item.done", item: {
      type: "reasoning", summary: [], encrypted_content: "incomplete-secret" } }]));
    await app.inject({ method: "POST", url: "/v1/messages", payload });
    fetchMock.mockResolvedValue(sse([{ type: "response.completed", response: { output: [], usage: {} } }]));
    await app.inject({ method: "POST", url: "/v1/messages", payload: { ...payload,
      messages: [...payload.messages, { role: "assistant", content: "partial" }, { role: "user", content: "continue" }] } });
    const last = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(last.input.some((item: any) => item.type === "reasoning")).toBe(false);
  });
});

// Protocol regressions recreated from the independent Flow review and local event handlers.
describe("completed output protocol regressions", () => {
  function eventsFrom(body: string) {
    return body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  }
  async function run(events: object[], stream: boolean, extra: object = {}, status = 200) {
    await credentials();
    app ||= createGateway();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(init.redirect).toBe("error");
      return sse(events);
    });
    const response = await app.inject({ method: "POST", url: "/v1/messages", payload: {
      model: "codex-oauth:gpt-6.1-sol@medium", stream,
      messages: [{ role: "user", content: "synthetic protocol fixture" }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }], ...extra,
    } });
    expect(response.statusCode).toBe(status);
    return response;
  }
  const call = { type: "function_call", id: "fc-regression", call_id: "call-regression", name: "Bash",
    arguments: '{"command":"echo synthetic","nested":{"count":2},"enabled":false}' };
  const expectedInput = { command: "echo synthetic", nested: { count: 2 }, enabled: false };
  const toolVariants = ["no-delta", "initial-only", "initial-partial", "arguments-done", "partial-delta", "full-deltas", "item-done-only", "added-completed-only", "completed-only"] as const;
  for (const stream of [false, true]) {
    it.each(toolVariants)(`tool arguments fallback preserves exact input once (stream=${stream}, %s)`, async variant => {
      const events: object[] = [];
      if (variant !== "completed-only") {
        if (variant !== "item-done-only") events.push({ type: "response.output_item.added", item: { ...call,
          arguments: variant === "initial-only" || variant === "initial-partial" || variant === "full-deltas" ? call.arguments : "" } });
        if (variant === "partial-delta" || variant === "initial-partial" || variant === "full-deltas") {
          events.push({ type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments.slice(0, 18) });
          if (variant === "full-deltas") events.push({ type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments.slice(18) });
        }
        if (variant === "arguments-done") events.push({ type: "response.function_call_arguments.done", item_id: call.id, arguments: call.arguments });
        if (variant !== "added-completed-only") events.push({ type: "response.output_item.done", item: variant === "initial-only" || variant === "initial-partial" || variant === "arguments-done"
          ? { type: call.type, id: call.id } : call });
      }
      events.push({ type: "response.completed", response: { output: [call] } });
      const response = await run(events, stream);
      if (!stream) {
        expect(response.json().content).toEqual([{ type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }]);
        expect(response.json().stop_reason).toBe("tool_use");
      } else {
        const out = eventsFrom(response.body);
        const starts = out.filter(e => e.content_block?.type === "tool_use");
        expect(starts).toHaveLength(1);
        expect(starts[0].content_block).toEqual({ type: "tool_use", id: call.call_id, name: call.name, input: {} });
        expect(out.filter(e => e.type === "content_block_stop" && e.index === starts[0].index)).toHaveLength(1);
        const args = out.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("");
        expect(args).toBe(call.arguments);
        expect(JSON.parse(args)).toEqual(expectedInput);
        expect(out.filter(e => e.type === "message_stop")).toHaveLength(1);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["items", "completed-only", "partial-stream", "full-stream", "part-done"])(`all message blocks survive fallback (stream=${stream}, %s)`, async variant => {
      const messages = [
        { type: "message", id: "msg-one", role: "assistant", content: [{ type: "output_text", text: "first " }, { type: "output_text", text: "block; " }] },
        { type: "message", id: "msg-two", role: "assistant", content: [{ type: "output_text", text: "second " }, { type: "output_text", text: "block" }] },
      ];
      const expected = "first block; second block";
      const events: object[] = [];
      if (variant === "partial-stream" || variant === "full-stream") events.push({ type: "response.output_text.delta", delta: variant === "partial-stream" ? "fir" : expected });
      if (variant === "part-done") events.push({ type: "response.content_part.done", part: messages[0].content[0] });
      if (variant !== "completed-only") events.push(...messages.map(item => ({ type: "response.output_item.done", item })));
      events.push({ type: "response.completed", response: { output: messages } });
      const response = await run(events, stream);
      const actual = stream ? eventsFrom(response.body).filter(e => e.delta?.type === "text_delta").map(e => e.delta.text).join("")
        : response.json().content.map((b: any) => b.text).join("");
      expect(actual).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["second-partial", "first-partial", "both-partial", "interleaved-tool", "missing-completed-output"])(`canonical completed output recovers missing item text (stream=${stream}, %s)`, async variant => {
      const first = { type: "message", id: "first", role: "assistant", content: [{ type: "output_text", text: "first;" }] };
      const second = { type: "message", id: "second", role: "assistant", content: [{ type: "output_text", text: "second" }] };
      const events: object[] = [];
      if (variant !== "second-partial") events.push({ type: "response.output_text.delta", item_id: "first", output_index: 0, delta: "fir" });
      if (variant === "interleaved-tool") events.push({ type: "response.output_item.added", output_index: 1, item: call }, { type: "response.output_item.done", output_index: 1, item: call });
      if (variant !== "first-partial") events.push({ type: "response.output_text.delta", item_id: "second", output_index: variant === "interleaved-tool" ? 2 : 1, delta: "sec" });
      if (variant === "missing-completed-output") events.push({ type: "response.output_item.done", output_index: 0, item: first }, { type: "response.output_item.done", output_index: 1, item: second });
      events.push({ type: "response.completed", response: variant === "missing-completed-output" ? {} : { output: variant === "interleaved-tool" ? [first, call, second] : [first, second] } });
      const response = await run(events, stream);
      const content = stream ? clientContent(response.body) : response.json().content;
      expect(content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")).toBe("first;second");
      if (variant === "interleaved-tool") expect(content).toEqual([{ type: "text", text: "first;" }, { type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }, { type: "text", text: "second" }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["initial", "delta", "arguments-done", "delta-done", "tool-done", "trailing-text", "empty-output"])(`missing output retains observed tool coverage (stream=${stream}, %s)`, async variant => {
      const first = { type: "message", id: "coverage-first", role: "assistant", content: [{ type: "output_text", text: "first;" }] };
      const exactCall = { ...call, arguments: '{ "command": "echo synthetic", "nested": { "count": 2 }, "enabled": false }' };
      const events: object[] = [
        { type: "response.output_item.done", output_index: 0, item: first },
        { type: "response.output_item.added", output_index: 1, item: { ...exactCall, arguments: variant === "initial" || variant === "trailing-text" || variant === "empty-output" ? exactCall.arguments : "" } },
      ];
      if (variant === "delta" || variant === "delta-done") events.push({ type: "response.function_call_arguments.delta", item_id: call.id, delta: exactCall.arguments });
      if (variant === "arguments-done" || variant === "delta-done") events.push({ type: "response.function_call_arguments.done", item_id: call.id, arguments: exactCall.arguments });
      if (variant === "tool-done") events.push({ type: "response.output_item.done", output_index: 1, item: exactCall });
      if (variant === "trailing-text") events.push({ type: "response.output_text.delta", output_index: 2, item_id: "coverage-after", delta: "after" });
      events.push({ type: "response.completed", response: variant === "empty-output" ? { output: [] } : {} });
      const response = await run(events, stream);
      const content = stream ? clientContent(response.body) : response.json().content;
      expect(content).toEqual([
        { type: "text", text: "first;" },
        { type: "tool_use", id: call.call_id, name: call.name, input: expectedInput },
        ...(variant === "trailing-text" ? [{ type: "text", text: "after" }] : []),
      ]);
      const stop = stream ? eventsFrom(response.body).find(e => e.type === "message_delta").delta.stop_reason : response.json().stop_reason;
      expect(stop).toBe("tool_use");
      if (stream) {
        const out = eventsFrom(response.body);
        expect(out.filter(e => e.content_block?.type === "tool_use")).toHaveLength(1);
        expect(out.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("")).toBe(exactCall.arguments);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`retains observed text around a tool when canonical item order cannot represent it (stream=${stream})`, async () => {
      const message = { type: "message", id: "coverage-split", role: "assistant", content: [{ type: "output_text", text: "beforeafter" }] };
      const response = await run([
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, delta: "before" },
        { type: "response.output_item.added", output_index: 1, item: call },
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, delta: "after" },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.completed", response: {} },
      ], stream);
      expect(stream ? clientContent(response.body) : response.json().content).toEqual([
        { type: "text", text: "before" }, { type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }, { type: "text", text: "after" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["delta-only", "empty-output", "missing-output"])(`completed text boundary remains explicit (stream=${stream}, %s)`, async variant => {
      const events: object[] = [{ type: "response.output_text.delta", item_id: "second", output_index: 1, delta: "sec" }];
      if (variant === "missing-output") events.push({ type: "response.output_text.delta", item_id: "second", output_index: 1, delta: "ond" });
      events.push({ type: "response.completed", response: variant === "empty-output" ? { output: [] } : {} });
      const response = await run(events, stream);
      const content = stream ? clientContent(response.body) : response.json().content;
      expect(content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")).toBe(variant === "missing-output" ? "second" : "sec");
    });

    it.each(["deltas-and-items", "items-only", "deltas-only", "with-tool"])(`preserves native output when completed output is empty (stream=${stream}, %s)`, async variant => {
      const reasoning = { type: "reasoning", id: "rs-empty-terminal", summary: [], encrypted_content: "synthetic-empty-terminal-reasoning" };
      const message = { type: "message", id: "msg-empty-terminal", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
      const events: object[] = [
        { type: "response.created", response: { output: [] } },
        { type: "response.reasoning_summary_text.delta", delta: "Synthetic reasoning" },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
      ];
      if (variant !== "items-only") events.push(
        { type: "response.output_text.delta", item_id: message.id, output_index: 1, delta: "ok" },
        { type: "response.output_text.done", item_id: message.id, output_index: 1, text: "ok" });
      if (variant !== "deltas-only") events.push({ type: "response.output_item.done", output_index: 1, item: message });
      if (variant === "with-tool") events.push({ type: "response.output_item.done", output_index: 2, item: call });
      events.push({ type: "response.completed", response: { output: [], usage: {
        input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 },
      } } });
      const response = await run(events, stream);
      const content = stream ? clientContent(response.body) : response.json().content;
      expect(content).toEqual([
        { type: "thinking", thinking: "Synthetic reasoning" }, { type: "text", text: "ok" },
        ...(variant === "with-tool" ? [{ type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }] : []),
      ]);
      const outputEvents = stream ? eventsFrom(response.body) : [];
      const usage = stream ? outputEvents.find(e => e.type === "message_delta").usage : response.json().usage;
      expect(usage).toMatchObject({ input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3 });
      if (stream) expect(outputEvents.filter(e => e.type === "message_stop")).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`discards an incomplete attempt before canonical text/tool reconstruction (stream=${stream})`, async () => {
      await credentials(); app = createGateway();
      vi.stubEnv("CCX_NETWORK_RETRIES", "1");
      vi.stubEnv("CCX_NETWORK_RETRY_DELAY_MS", "1");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const first = { type: "message", id: "first", role: "assistant", content: [{ type: "output_text", text: "first;" }] };
      const second = { type: "message", id: "second", role: "assistant", content: [{ type: "output_text", text: "second" }] };
      fetchMock.mockResolvedValueOnce(sse([{ type: "response.output_text.delta", item_id: "second", output_index: 2, delta: "discarded" },
        { type: "response.output_item.added", item: call }, { type: "response.output_item.done", item: call }]));
      fetchMock.mockResolvedValueOnce(sse([{ type: "response.output_text.delta", item_id: "second", output_index: 2, delta: "sec" },
        { type: "response.output_item.added", item: call }, { type: "response.output_item.done", item: call },
        { type: "response.completed", response: { output: [first, call, second], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } } }]));
      const response = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "codex", stream, messages: [] } });
      expect(response.statusCode).toBe(200);
      const content = stream ? clientContent(response.body) : response.json().content;
      expect(content).toEqual([{ type: "text", text: "first;" }, { type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }, { type: "text", text: "second" }]);
      expect(response.body).not.toContain("discarded");
      const usage = stream ? eventsFrom(response.body).find(e => e.type === "message_delta").usage : response.json().usage;
      expect(usage).toMatchObject({ input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(["WebSearch", "WebFetch", "Bash", "auto", "none", "any"])(`native search reconciles exact upstream choice (stream=${stream}, %s)`, async choice => {
      const toolChoice = ["auto", "none", "any"].includes(choice) ? { type: choice } : { type: "tool", name: choice };
      await run([{ type: "response.completed", response: { output: [] } }], stream, {
        tools: [{ name: "WebSearch" }, { name: "Bash", input_schema: { type: "object" } }, { name: "WebFetch" }], tool_choice: toolChoice,
      });
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.tools).toEqual([{ type: "function", name: "Bash", description: "", strict: false, parameters: { type: "object" } }, { type: "web_search" }]);
      expect(sent.tool_choice).toEqual(choice === "WebSearch" || choice === "WebFetch" ? { type: "web_search" }
        : choice === "Bash" ? { type: "function", name: "Bash" } : choice === "any" ? "required" : choice);
      expect(sent.instructions).toContain("Use native server-side web search when needed.");
      if (sent.tool_choice.type === "function") expect(sent.tools.some((t: any) => t.type === "function" && t.name === sent.tool_choice.name)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`rejects missing forced functions locally (stream=${stream})`, async () => {
      await credentials(); app = createGateway();
      const response = await app.inject({ method: "POST", url: "/v1/messages", payload: {
        model: "codex", stream, messages: [], tools: [{ name: "Bash" }], tool_choice: { type: "tool", name: "Missing" },
      } });
      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it.each([false, true])("keeps original reasoning and actual client text/tool output in replay (stream=%s)", async stream => {
    const output = [
      { type: "reasoning", id: "reasoning-protocol", summary: [], encrypted_content: "synthetic-encrypted" },
      { type: "message", role: "assistant", id: "before-tool", content: [{ type: "output_text", text: "before" }] },
      call,
      { type: "message", role: "assistant", id: "after-tool", content: [{ type: "output_text", text: "after" }] },
    ];
    const metadata = { user_id: JSON.stringify({ session_id: "protocol-original-output" }) };
    const response = await run([{ type: "response.completed", response: { output } }], stream, { metadata });
    const content = stream ? clientContent(response.body) : response.json().content;
    expect(content).toEqual([
      { type: "text", text: "before" }, { type: "tool_use", id: call.call_id, name: call.name, input: expectedInput }, { type: "text", text: "after" },
    ]);
    await app!.inject({ method: "POST", url: "/v1/messages", payload: { model: "claude-sonnet-4-6@medium", stream: false, metadata,
      messages: [{ role: "user", content: "synthetic protocol fixture" },
        { role: "assistant", content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.call_id, content: "synthetic result" }] }] } });
    const replay = JSON.parse(fetchMock.mock.calls[1][1].body).input;
    expect(replay.slice(1, 1 + output.length)).toEqual(output);
  });

  it.each([false, true])("serves native forced search on an owned dynamic loopback port (stream=%s)", async stream => {
    await credentials(); app = createGateway();
    fetchMock.mockImplementation(async () => sse([{ type: "response.completed", response: { output: [] } }]));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected an owned loopback port");
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = loopbackRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json" } }, res => {
        let body = "";
        res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "codex", stream, messages: [], tools: [{ name: "WebSearch" }], tool_choice: { type: "tool", name: "WebSearch" } }));
    });
    expect(result.status).toBe(200);
    expect(stream ? eventsFrom(result.body).at(-1).type : JSON.parse(result.body).stop_reason).toBe(stream ? "message_stop" : "end_turn");
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.tools).toEqual([{ type: "web_search" }]);
    expect(sent.tool_choice).toEqual({ type: "web_search" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves call-id fallback and ordered distinct calls (stream=%s)", async stream => {
    const output = [call, { ...call, id: undefined, call_id: "call-second", name: "Read", arguments: '{"path":"synthetic.txt"}' }];
    const response = await run([{ type: "response.completed", response: { output } }], stream);
    if (stream) {
      const starts = eventsFrom(response.body).filter(e => e.content_block?.type === "tool_use");
      expect(starts.map(e => [e.content_block.id, e.content_block.name, e.index])).toEqual([[call.call_id, "Bash", 0], ["call-second", "Read", 1]]);
    } else expect(response.json().content).toEqual([
      { type: "tool_use", id: call.call_id, name: "Bash", input: expectedInput },
      { type: "tool_use", id: "call-second", name: "Read", input: { path: "synthetic.txt" } },
    ]);
  });

  it.each(['{"synthetic-private-argument":', '[]', 'null', '"synthetic-private-argument"'])("invalid completed-only arguments return nonstream error safely (%s)", async argumentsText => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await run([{ type: "response.completed", response: { output: [{ ...call, arguments: argumentsText }] } }], false, {}, 503);
    expect(response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(response.body).not.toContain("synthetic-private-argument");
    expect(response.body).not.toContain("tool_use");
    expect(JSON.stringify(error.mock.calls)).not.toContain("synthetic-private-argument");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['{"synthetic-private-argument":', '[]', 'null', '"synthetic-private-argument"'])("invalid serialized arguments fail safely (%s)", async argumentsText => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await run([{ type: "response.output_item.added", item: { ...call, arguments: "" } },
      { type: "response.output_item.done", item: { ...call, arguments: argumentsText } },
      { type: "response.completed", response: {} }], true);
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("synthetic-private-argument");
    expect(response.body).not.toContain("event: message_stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("synthetic-private-argument");
  });
});
