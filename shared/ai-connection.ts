import type { AiProblemKind } from "./types.js";

/**
 * The models GitCat is built and tested with, offered as a choice instead of an empty identifier
 * field. Any other identifier stays available as an advanced override; it is verified the same way.
 */
export const recommendedModel = "gpt-6-luna";
export const supportedModels: readonly { id: string; recommended: boolean }[] = [{ id: recommendedModel, recommended: true }];

export function isSupportedModel(model: string) {
  return supportedModels.some((entry) => entry.id === model.trim());
}

/** Masks anything shaped like an API key, so an error the provider echoes never shows one. */
export function maskKeys(text: string) {
  return text.replace(/\b(sk-[A-Za-z0-9_-]{0,6})[A-Za-z0-9_*-]{6,}/g, "$1…");
}

type ProviderErrorBody = { error?: { code?: unknown; type?: unknown; param?: unknown; message?: unknown } };

/**
 * Tells a failed provider answer apart from its HTTP status and the error object the provider
 * returns. It classifies the provider's reply, never what the person wrote.
 */
export function classifyProviderFailure(failure: { status?: number; body?: string; transport?: "timeout" | "unreachable" }): AiProblemKind {
  if (failure.transport) return failure.transport;
  const status = failure.status ?? 0;
  let error: ProviderErrorBody["error"] = {};
  try { error = (JSON.parse(failure.body ?? "") as ProviderErrorBody)?.error ?? {}; } catch { /* not JSON: the status decides */ }
  const code = String(error?.code ?? "").toLowerCase();
  const type = String(error?.type ?? "").toLowerCase();
  const param = String(error?.param ?? "").toLowerCase();
  const message = String(error?.message ?? "");
  if (status === 401 || code === "invalid_api_key") return "invalid_key";
  if (code === "model_not_found" || (param === "model" && status >= 400 && status < 500 && status !== 429)) return "unknown_model";
  if (status === 402 || /insufficient_quota|billing/.test(`${code} ${type}`)) return "billing";
  if (status === 429) return "rate_limited";
  if (status === 404) return "unknown_model";
  if (status === 403) return "no_access";
  if (status === 408) return "timeout";
  if (status >= 500) return "outage";
  if (status === 400 && /\bmodel\b/i.test(message) && /does not exist|not found|not supported|unsupported|do not have access/i.test(message)) return "unknown_model";
  return "unexpected";
}
