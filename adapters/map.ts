// Codex model aliases and strict native-only routing.
import type { ProviderModel, ReasoningLevel } from "./types.js";

const VALID_REASONING: ReasoningLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_ALIASES: Record<string, string> = {
  terra: "gpt-5.6-terra", luna: "gpt-5.6-luna", gpt55: "gpt-5.5", gpt56: "gpt-5.6-sol",
};
const EFFORT_ALIASES: Record<string, ReasoningLevel> = {
  fast: "low", smart: "medium", deep: "high", xhigh: "xhigh", extra: "xhigh", max: "max", think: "max",
};

function splitModel(value: string): { model: string; reasoning?: ReasoningLevel } {
  const cleaned = value.replace(/\[1m\]/gi, "").trim();
  const parts = cleaned.split("@");
  if (parts.length > 2 || (parts.length === 2 && !VALID_REASONING.includes(parts[1].toLowerCase() as ReasoningLevel))) {
    throw new Error("Invalid @effort");
  }
  return { model: parts[0], reasoning: parts[1]?.toLowerCase() as ReasoningLevel | undefined };
}

function assertModel(model: string): void {
  // Unknown model families fail before credentials are read or fetch is called.
  if (!/^(gpt-\d[\w.-]*|codex[\w.-]*)$/.test(model)) throw new Error("Unsupported Codex model");
}

export function codexDefaults(defaults?: ProviderModel): ProviderModel {
  const parsed = splitModel(defaults?.model || process.env.CCX_DEFAULT_MODEL || "gpt-6.1-sol");
  assertModel(parsed.model);
  return { provider: "codex-oauth", model: parsed.model, reasoning: defaults?.reasoning || parsed.reasoning || "medium" };
}

export function parseProviderModel(field: string, defaults?: ProviderModel): ProviderModel {
  if (typeof field !== "string" || !field.trim()) throw new Error("Model is required");
  const base = codexDefaults(defaults);
  const configured = codexDefaults();
  const parsed = splitModel(field);
  let model = parsed.model;
  const lower = model.toLowerCase();
  if (/^(opus|sonnet|haiku)$/.test(lower) || /^claude-[\w.-]+$/.test(lower)) {
    return { ...configured, reasoning: parsed.reasoning || configured.reasoning };
  }
  if (["codex", "cx", "sol", "codex-oauth"].includes(lower) || EFFORT_ALIASES[lower]) {
    return { ...base, reasoning: parsed.reasoning || EFFORT_ALIASES[lower] || configured.reasoning };
  }
  if (/[:/]/.test(model)) {
    const match = /^codex-oauth[:/]([^:/]+)$/.exec(model);
    if (!match) throw new Error("Only codex-oauth:<model> is supported");
    model = match[1];
  } else model = MODEL_ALIASES[lower] || model;
  assertModel(model);
  return { provider: "codex-oauth", model, reasoning: parsed.reasoning || configured.reasoning };
}
