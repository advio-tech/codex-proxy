// Aggregates the SSE stream a provider adapter writes back into a single
// Anthropic Messages-API JSON response. Used to serve `stream: false` requests
// (e.g. Claude Code's /model validation probe) through the same adapter code
// path as streaming requests.

import type { FastifyReply } from "fastify";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type Aggregated = {
  id: string;
  model: string;
  content: Block[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

/** Run `inner` with a buffered reply, then send the aggregated JSON on `realRes`. */
export async function withAggregatedReply(
  realRes: FastifyReply,
  inner: (bufRes: FastifyReply) => Promise<unknown>,
): Promise<void> {
  const chunks: string[] = [];
  const ended = { value: false };

  const fakeRaw = {
    writableEnded: false,
    headersSent: false,
    get destroyed() { return realRes.raw.destroyed; },
    once: realRes.raw.once?.bind(realRes.raw),
    removeListener: realRes.raw.removeListener?.bind(realRes.raw),
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      ended.value = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fakeRaw as any).writableEnded = true;
    },
  };

  // Build a FastifyReply-shaped object. We only use `.raw` and a couple of helpers.
  const bufRes = { raw: fakeRaw, request: realRes.request } as unknown as FastifyReply;

  await inner(bufRes);

  const stream = chunks.join("");
  for (const block of stream.split("\n\n")) {
    const data = block.split("\n").find(line => line.startsWith("data: "));
    if (!data) continue;
    const event = JSON.parse(data.slice(6));
    if (event.type === "error") {
      realRes.raw.statusCode = event.status >= 400 ? event.status : 502;
      realRes.raw.setHeader("Content-Type", "application/json");
      realRes.raw.end(JSON.stringify({ type: "error", error: event.error }));
      return;
    }
  }
  const aggregated = parseSseStream(stream);

  realRes.raw.setHeader("Content-Type", "application/json");
  realRes.raw.setHeader("Cache-Control", "no-cache, no-transform");
  realRes.raw.end(
    JSON.stringify({
      id: aggregated.id,
      type: "message",
      role: "assistant",
      model: aggregated.model,
      content: aggregated.content,
      stop_reason: aggregated.stop_reason ?? "end_turn",
      stop_sequence: aggregated.stop_sequence,
      usage: aggregated.usage,
    }),
  );
}

function parseSseStream(buffer: string): Aggregated {
  const events = buffer
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      try {
        return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);

  const agg: Aggregated = {
    id: `msg_${Date.now()}`,
    model: "",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const openBlocks: Map<number, Block> = new Map();
  const completedBlocks = new Map<number, Block>();

  for (const ev of events) {
    const type = ev.type as string | undefined;
    if (!type) continue;

    if (type === "message_start") {
      const msg = ev.message as
        | {
            id?: string;
            model?: string;
            usage?: Aggregated["usage"];
          }
        | undefined;
      if (msg?.id) agg.id = msg.id;
      if (msg?.model) agg.model = msg.model;
      if (msg?.usage) agg.usage = { ...agg.usage, ...msg.usage };
    } else if (type === "content_block_start") {
      const index = ev.index as number;
      const block = ev.content_block as {
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      if (block?.type === "text") {
        openBlocks.set(index, { type: "text", text: block.text ?? "" });
      } else if (block?.type === "thinking") {
        openBlocks.set(index, { type: "thinking", thinking: block.thinking ?? "" });
      } else if (block?.type === "tool_use") {
        openBlocks.set(index, {
          type: "tool_use",
          id: block.id ?? "",
          name: block.name ?? "",
          input: "", // accumulated as a string of partial_json, parsed on close
        });
      }
    } else if (type === "content_block_delta") {
      const index = ev.index as number;
      const delta = ev.delta as {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
      };
      const blk = openBlocks.get(index);
      if (!blk) continue;
      if (delta.type === "text_delta" && blk.type === "text") {
        blk.text += delta.text ?? "";
      } else if (delta.type === "thinking_delta" && blk.type === "thinking") {
        blk.thinking += delta.thinking ?? "";
      } else if (delta.type === "input_json_delta" && blk.type === "tool_use") {
        blk.input = `${blk.input as string}${delta.partial_json ?? ""}`;
      }
    } else if (type === "content_block_stop") {
      const index = ev.index as number;
      const blk = openBlocks.get(index);
      if (!blk) continue;
      if (blk.type === "tool_use" && typeof blk.input === "string") {
        try {
          blk.input = JSON.parse(blk.input || "{}");
        } catch {
          blk.input = {};
        }
      }
      completedBlocks.set(index, blk);
      openBlocks.delete(index);
    } else if (type === "message_delta") {
      const delta = ev.delta as { stop_reason?: string | null; stop_sequence?: string | null };
      const usage = ev.usage as Aggregated["usage"] | undefined;
      if (delta?.stop_reason !== undefined) agg.stop_reason = delta.stop_reason ?? null;
      if (delta?.stop_sequence !== undefined) agg.stop_sequence = delta.stop_sequence ?? null;
      if (usage) agg.usage = { ...agg.usage, ...usage };
    }
  }

  // Close any block left open (defensive — shouldn't happen if adapter is well-behaved).
  for (const [index, blk] of openBlocks) {
    if (blk.type === "tool_use" && typeof blk.input === "string") {
      try {
        blk.input = JSON.parse(blk.input || "{}");
      } catch {
        blk.input = {};
      }
    }
    completedBlocks.set(index, blk);
  }

  // A pending tool can close after later text; retain the SSE block order.
  agg.content = [...completedBlocks].sort(([a], [b]) => a - b).map(([, block]) => block);
  return agg;
}
