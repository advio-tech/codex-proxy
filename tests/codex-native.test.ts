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
