// All fixtures, identifiers, tokens and conversations in this file are synthetic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { conversationKey, sessionIdFrom, rememberResponse, replayResponses } from "../adapters/codex-reasoning-cache.js";
import { toResponsesInput, normalizeMessagesForResponses, type ResponseItem } from "../adapters/providers/codex-oauth.js";
import type { AnthropicRequest } from "../adapters/types.js";
const body = (session: string): AnthropicRequest => ({ model: "codex", messages: [{ role: "user", content: "same shared brief" }],
  metadata: { user_id: JSON.stringify({ device_id: "same-device", session_id: session }) } });
const key = (session: string, account = "a", model = "gpt-6.1-sol") => conversationKey(body(session), account, model)!;
const output = (tag: string): ResponseItem[] => [
  { type: "reasoning", summary: [], encrypted_content: `encrypted-${tag}` },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: tag }] },
];
const user = (text: string) => toResponsesInput([{ role: "user", content: text }]);
afterEach(() => vi.useRealTimers());
describe("Responses replay isolation", () => {
  it("extracts modern JSON and legacy UUID session IDs, rejects arbitrary user IDs", () => {
    expect(sessionIdFrom(body("real-session"))).toBe("real-session");
    expect(sessionIdFrom({ ...body("x"), metadata: { user_id: "user_device_account_account_session_12345678-1234-1234-1234-123456789abc" } })).toBe("12345678-1234-1234-1234-123456789abc");
    expect(sessionIdFrom({ ...body("x"), metadata: { user_id: "shared-user" } })).toBeUndefined();
  });
  it("scopes both state and routing to session/account/model", () => {
    expect(new Set([key("s1"), key("s2"), key("s1", "b"), key("s1", "a", "other")]).size).toBe(4);
    expect(key("s1")).toBe(conversationKey({ ...body("s1"), messages: user("changed") as never }, "a", "gpt-6.1-sol"));
  });
  it("replays three interleaved sessions without transferring encrypted blocks", async () => {
    const input = user("same shared brief");
    await Promise.all(["one", "two", "three"].map(async (session) => {
      rememberResponse(key(session), input, output(session));
    }));
    for (const session of ["three", "one", "two"]) {
      const next = [...input, ...output(session).slice(1), ...user("next")];
      expect(replayResponses(key(session), next)).toEqual([...input, ...output(session), ...user("next")]);
      expect(replayResponses(key(session, "other-account"), next)).toEqual(next);
      expect(replayResponses(key(session, "a", "other-model"), next)).toEqual(next);
    }
  });
  it("keeps earlier output in place as new turns are appended", () => {
    const k = key("growing");
    const first = user("start");
    rememberResponse(k, first, output("A"));
    const second = [...first, ...output("A").slice(1), ...user("next")];
    const secondWire = replayResponses(k, second);
    rememberResponse(k, second, output("B"));
    const third = [...second, ...output("B").slice(1), ...user("third")];
    const thirdWire = replayResponses(k, third);
    expect(thirdWire.slice(0, secondWire.length)).toEqual(secondWire);
    expect(thirdWire).toEqual([...secondWire, ...output("B"), ...user("third")]);
    expect(thirdWire[0]).toEqual(first[0]);
  });
  it("does not attach stale output after compaction, edits or a different branch", () => {
    const k = key("branch");
    const input = user("start");
    rememberResponse(k, input, output("A"));
    for (const next of [[...user("summary"), ...output("A").slice(1)], [...input, ...output("other").slice(1)], input]) {
      expect(replayResponses(k, next)).toEqual(next);
    }
  });
  it("fails closed without a real session ID", () => {
    const b = { ...body("x"), metadata: undefined };
    expect(conversationKey(b, "a", "m")).toBeUndefined();
    rememberResponse(undefined, user("same shared brief"), output("secret"));
    expect(replayResponses(undefined, user("same shared brief"))).toEqual(user("same shared brief"));
  });
  it("retains original function-call arguments and native output at the matching tool turn", () => {
    const input = user("run a tool");
    const out = [...output("tool").slice(0, 1), { type: "function_call" as const, call_id: "call-unique", name: "Bash", arguments: '{ "command": "pwd" }', id: "fc-unique" }];
    rememberResponse(key("tool"), input, out);
    const next = toResponsesInput([{ role: "user", content: "run a tool" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-unique", name: "Bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-unique", content: "/tmp" }] }]);
    expect(replayResponses(key("tool"), next)).toEqual([...input, ...out, next.at(-1)]);
  });
  it("anchors interleaved tools and fails closed for every content/order/scope change", () => {
    const k = key("interleaved");
    const first = user("synthetic protocol fixture");
    const out: ResponseItem[] = [
      { type: "reasoning", id: "r", summary: [], encrypted_content: "synthetic-encrypted" },
      { type: "message", role: "assistant", id: "before", content: [{ type: "output_text", text: "before" }] },
      { type: "function_call", id: "fc", call_id: "call", name: "Bash", arguments: '{"command":"echo synthetic"}' },
      { type: "message", role: "assistant", id: "after", content: [{ type: "output_text", text: "after" }] },
    ];
    const content: any[] = [{ type: "text", text: "before" }, { type: "tool_use", id: "call", name: "Bash", input: { command: "echo synthetic" } }, { type: "text", text: "after" }];
    const next = (blocks: any[]) => toResponsesInput([{ role: "user", content: "synthetic protocol fixture" }, { role: "assistant", content: blocks }, { role: "user", content: "next" }]);
    rememberResponse(k, first, out);
    expect(replayResponses(k, next(content))).toEqual([...first, ...out, ...user("next")]);
    for (const blocks of [content.slice().reverse(), [content[0], content[2], content[1]], [content[0], content[2]], [{ type: "text", text: "changed" }, ...content.slice(1)], [content[0], { ...content[1], input: { command: "changed" } }, content[2]]]) {
      const input = next(blocks);
      expect(replayResponses(k, input)).toEqual(input);
    }
    for (const other of [key("other-session"), key("interleaved", "other-account"), key("interleaved", "a", "other-model"), undefined]) expect(replayResponses(other, next(content))).toEqual(next(content));
    const unrelated = [...user("unrelated"), ...next(content).slice(1)];
    expect(replayResponses(k, unrelated)).toEqual(unrelated);
  });
  it("does not replace already anchored output on identical retries", () => {
    const k = key("retry"); const input = user("start");
    rememberResponse(k, input, output("same"));
    rememberResponse(k, input, [{ type: "reasoning", summary: [], encrypted_content: "replacement" }, ...output("same").slice(1)]);
    expect(replayResponses(k, [...input, ...output("same").slice(1)])).toEqual([...input, ...output("same")]);
  });
  it("expires inactive reasoning state", () => {
    vi.useFakeTimers(); const k = key("expiry"); const input = user("start");
    rememberResponse(k, input, output("A")); vi.advanceTimersByTime(31 * 60 * 1000);
    const next = [...input, ...output("A").slice(1)]; expect(replayResponses(k, next)).toEqual(next);
  });
  it("preserves the sent prefix when developer messages were originally at the tail", () => {
    const messages = [{ role: "user" as const, content: "prompt" }, { role: "developer" as const, content: "context" }];
    const first = toResponsesInput(normalizeMessagesForResponses(messages));
    const next = toResponsesInput(normalizeMessagesForResponses([...messages, { role: "assistant", content: "ok" }, { role: "user", content: "next" }]));
    expect(next.slice(0, first.length)).toEqual(first);
  });
});
