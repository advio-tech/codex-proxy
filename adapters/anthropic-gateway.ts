// Loopback Messages gateway: native Codex by default, direct Claude API by opt-in.
import Fastify from "fastify";
import { pathToFileURL } from "url";
import { codexDefaults, parseProviderModel } from "./map.js";
import type { AnthropicRequest } from "./types.js";
import { chatCodexOAuth } from "./providers/codex-oauth.js";
import { withAggregatedReply } from "./sse-aggregator.js";
import { getCodexAccessToken, getCodexLoginStatus, CodexNativeAuthError } from "./openai-auth.js";
import { forwardAnthropicApi } from "./providers/anthropic-api.js";

// Importing this module never starts a listener or reads credentials.
export function createGateway() {
  const backend = process.env.CLAUDE_PROXY_BACKEND || "codex-oauth";
  if (backend !== "codex-oauth" && backend !== "anthropic") {
    throw new Error("CLAUDE_PROXY_BACKEND must be codex-oauth or anthropic");
  }
  let active: ReturnType<typeof codexDefaults> | { provider: "anthropic"; model?: string } =
    backend === "anthropic" ? { provider: "anthropic" } : codexDefaults();
  const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
  fastify.get("/healthz", async () => ({ ok: true, active }));
  fastify.get("/_status", async () => active);
  if (backend === "anthropic") {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      fastify.post(path, async (req, res) => {
        const body = req.body as { model?: unknown } | null;
        if (typeof body?.model === "string") active = { provider: "anthropic", model: body.model };
        return forwardAnthropicApi(req, res);
      });
    }
    return fastify;
  }
  fastify.get("/codex/status", async () => getCodexLoginStatus());

  fastify.post("/v1/messages", async (req, res) => {
    const body = req.body as AnthropicRequest;
    let route;
    try {
      route = parseProviderModel(body?.model);
      if (!Array.isArray(body.messages)) throw new Error("Messages must be an array");
    } catch {
      return res.code(400).send({ error: "Invalid model, @effort or messages" });
    }
    const choice = body.tool_choice;
    if (choice?.type === "tool" && choice.name !== "WebSearch" && choice.name !== "WebFetch"
      && !body.tools?.some(tool => tool.name === choice.name)) {
      return res.code(400).send({ error: "Forced tool is unavailable" });
    }
    try { await getCodexAccessToken(); }
    catch (error) {
      return res.code(401).send({ error: error instanceof CodexNativeAuthError ? error.message : "Native Codex credentials unavailable" });
    }
    active = route;
    // Claude's local search tools are replaced by Codex server-side web search.
    body.tools = body.tools?.filter(t => t.name !== "WebSearch" && t.name !== "WebFetch");
    const searchNote = "Use native server-side web search when needed.";
    body.system = Array.isArray(body.system) ? [...body.system, { type: "text", text: searchNote }]
      : [body.system, searchNote].filter(Boolean).join("\n\n");
    if (body.stream === true) {
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      res.raw.flushHeaders?.();
      return chatCodexOAuth(res, body, route.model, route.reasoning);
    }
    return withAggregatedReply(res, buffered => chatCodexOAuth(buffered as typeof res, body, route.model, route.reasoning));
  });
  return fastify;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fastify = createGateway();
  const port = Number(process.env.CLAUDE_PROXY_PORT || 17870);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void fastify.close(); });
  }
  fastify.listen({ port, host: "127.0.0.1" }).then(address => {
    console.log(`Messages proxy listening at ${address}`);
  }).catch(() => {
    console.error("Cannot start loopback proxy. Check the port and configuration.");
    process.exitCode = 1;
  });
}
