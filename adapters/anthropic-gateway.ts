// Loopback Anthropic Messages gateway for native Codex subscriptions.
import Fastify from "fastify";
import { pathToFileURL } from "url";
import { codexDefaults, parseProviderModel } from "./map.js";
import type { AnthropicRequest } from "./types.js";
import { chatCodexOAuth } from "./providers/codex-oauth.js";
import { withAggregatedReply } from "./sse-aggregator.js";
import { getCodexAccessToken, getCodexLoginStatus, CodexNativeAuthError } from "./openai-auth.js";

// Importing this module never starts a listener or reads credentials.
export function createGateway() {
  let active = codexDefaults();
  const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
  fastify.get("/healthz", async () => ({ ok: true, active }));
  fastify.get("/_status", async () => active);
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
    try { await getCodexAccessToken(); }
    catch (error) {
      return res.code(401).send({ error: error instanceof CodexNativeAuthError ? error.message : "Native Codex credentials unavailable" });
    }
    active = route;
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
    console.log(`Codex proxy listening at ${address}`);
  }).catch(() => {
    console.error("Cannot start loopback proxy. Check the port and configuration.");
    process.exitCode = 1;
  });
}
