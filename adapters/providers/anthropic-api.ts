// Direct Messages API transport. The calling Claude Code process owns the agent loop.
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

const API_ORIGIN = "https://api.anthropic.com";
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const LOCAL_HEADERS = new Set([
  "host", "authorization", "x-api-key", "cookie", "content-length",
  "accept-encoding", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
]);

function connectionHeaders(value: string | undefined): Set<string> {
  return new Set(value?.toLowerCase().split(",").map(name => name.trim()) ?? []);
}

function requestHeaders(request: FastifyRequest, apiKey: string): Headers {
  const headers = new Headers();
  const connection = connectionHeaders(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || LOCAL_HEADERS.has(name) || connection.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // Keep client attribution, API version, beta headers and body metadata intact.
  headers.set("x-api-key", apiKey);
  return headers;
}

async function* responseBody(response: Response) {
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } catch {
    throw new Error("Claude API response stream failed");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function forwardAnthropicApi(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return reply.code(503).send({ type: "error", error: {
      type: "api_error", message: "ANTHROPIC_API_KEY is not configured",
    } });
  }

  const controller = new AbortController();
  const onAborted = () => controller.abort();
  const cleanup = () => {
    request.raw.off("aborted", onAborted);
    reply.raw.off("close", onClose);
  };
  const onClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
    cleanup();
  };
  request.raw.once("aborted", onAborted);
  reply.raw.once("close", onClose);

  try {
    // Use a fixed origin: ANTHROPIC_BASE_URL belongs to the local client, and
    // following a redirect could send the server's API key to another host.
    const response = await fetch(`${API_ORIGIN}${request.raw.url}`, {
      method: "POST",
      headers: requestHeaders(request, apiKey),
      body: JSON.stringify(request.body),
      signal: controller.signal,
      redirect: "error",
    });
    reply.code(response.status);
    const connection = connectionHeaders(response.headers.get("connection") ?? undefined);
    for (const [name, value] of response.headers) {
      // Fetch decompresses the body, so its original encoding and length no
      // longer describe the bytes sent to the client.
      if (HOP_HEADERS.has(name) || connection.has(name)
        || ["content-encoding", "content-length", "set-cookie"].includes(name)) continue;
      reply.header(name, value);
    }
    // Forward JSON, errors and SSE without Codex conversion or aggregation.
    if (!response.body) return reply.send();
    return reply.send(Readable.from(responseBody(response)));
  } catch {
    cleanup();
    if (controller.signal.aborted) return reply;
    return reply.code(502).send({ type: "error", error: {
      type: "api_error", message: "Claude API request failed",
    } });
  }
}
