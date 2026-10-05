// All fixtures, identifiers, tokens and conversations in this file are synthetic.
import { afterEach, expect, it, vi } from "vitest";
import { parseProviderModel } from "../adapters/map.js";
import { effectiveReasoningEffort } from "../adapters/providers/codex-oauth.js";
afterEach(() => vi.unstubAllEnvs());
it("routes Claude 1m model markers to Codex with proxy default xhigh", () => {
  vi.stubEnv("CCX_DEFAULT_MODEL", "gpt-6.1-sol@xhigh");
  for (const model of ["sonnet[1m]", "codex-oauth:gpt-6.1-sol[1m]", "codex-oauth:gpt-6.1-sol@xhigh[1m]"]) {
    expect(parseProviderModel(model)).toEqual({provider: "codex-oauth", model: "gpt-6.1-sol", reasoning: "xhigh"});
  }
  expect(() => parseProviderModel("codex-oauth:gpt-6.1-sol@invalid[1m]")).toThrow();
});

it("pins ordinary Codex requests to server-side xhigh despite a client medium suffix", () => {
  vi.stubEnv("CODEX_FORCE_REASONING_EFFORT", "xhigh");
  const body = {model: "codex-oauth:gpt-6.1-sol@medium[1m]", messages: [{role: "user" as const, content: "Hello"}]};
  expect(effectiveReasoningEffort(body, "medium")).toBe("xhigh");
  vi.stubEnv("CODEX_FORCE_REASONING_EFFORT", "");
  expect(effectiveReasoningEffort(body, "medium")).toBe("medium");
});
