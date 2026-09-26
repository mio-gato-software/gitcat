import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const electron = await import(electronStub);
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const connection = await import(pathToFileURL(join(root, "dist-electron/shared/ai-connection.js")));
const settingsFile = join(electron.app.getPath("userData"), "gitcat-settings.json");

/** Stubbed Responses API: each call takes the next queued answer. No request ever reaches a paid provider. */
const queue = [];
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  const next = queue.shift();
  if (!next) throw new Error("llamada al proveedor no esperada");
  if (next.throws) throw next.throws;
  return { ok: next.status === 200, status: next.status, text: async () => next.body ?? "", json: async () => next.payload ?? { status: "completed", output_text: "ok" } };
};
const providerError = (status, error) => ({ status, body: JSON.stringify({ error }) });
const encryption = electron.safeStorage.isEncryptionAvailable;

test.beforeEach(async () => {
  queue.length = 0; calls = 0;
  electron.safeStorage.isEncryptionAvailable = encryption;
  await service.saveLlmConfig({ apiKey: "", model: connection.recommendedModel, clearApiKey: true });
});

test("a fresh profile starts with no assistant, secure storage ready and the recommended model", () => {
  const config = service.getLlmConfig();
  assert.equal(config.configured, false);
  assert.equal(config.secureStorage, true);
  assert.equal(config.model, connection.recommendedModel);
  assert.equal(config.lastProblem, undefined);
  assert.ok(connection.supportedModels.some((model) => model.id === connection.recommendedModel && model.recommended));
  assert.equal(connection.isSupportedModel(connection.recommendedModel), true);
  assert.equal(connection.isSupportedModel("my-custom-model"), false);
});

test("provider failures are told apart from the provider's own answer", () => {
  const classify = (status, error) => connection.classifyProviderFailure({ status, body: error === undefined ? "" : JSON.stringify({ error }) });
  assert.equal(classify(401, { code: "invalid_api_key", message: "Incorrect API key provided" }), "invalid_key");
  assert.equal(classify(404, { code: "model_not_found", message: "The model `x` does not exist" }), "unknown_model");
  assert.equal(classify(400, { param: "model", message: "Invalid model" }), "unknown_model");
  assert.equal(classify(400, { message: "The requested model 'gpt-x' does not exist." }), "unknown_model");
  assert.equal(classify(403, { code: "model_not_found", message: "Project does not have access to model" }), "unknown_model");
  assert.equal(classify(403, { message: "Country, region, or territory not supported" }), "no_access");
  assert.equal(classify(429, { code: "insufficient_quota", type: "insufficient_quota" }), "billing");
  assert.equal(classify(429, { code: "rate_limit_exceeded" }), "rate_limited");
  assert.equal(classify(500), "outage");
  assert.equal(classify(503, { message: "The engine is currently overloaded" }), "outage");
  assert.equal(classify(418), "unexpected");
  assert.equal(connection.classifyProviderFailure({ transport: "timeout" }), "timeout");
  assert.equal(connection.classifyProviderFailure({ transport: "unreachable" }), "unreachable");
  assert.equal(connection.maskKeys("Incorrect API key provided: sk-proj-abcdefghijklmnop"), "Incorrect API key provided: sk-proj-a…");
});

test("an invalid key is not saved and comes back as a reason, with the key masked", async () => {
  queue.push(providerError(401, { code: "invalid_api_key", message: "Incorrect API key provided: sk-bad-1234567890abcd" }));
  const result = await service.connectLlm({ apiKey: "sk-bad-1234567890abcd", model: connection.recommendedModel });
  assert.equal(result.ok, false);
  assert.equal(result.problem.kind, "invalid_key");
  assert.doesNotMatch(result.problem.detail, /1234567890abcd/);
  assert.equal(result.config.configured, false);
  assert.equal(result.config.lastProblem, undefined, "A rejected candidate leaves no trace on the saved connection");
});

test("an unknown model is not saved and keeps the model that was there", async () => {
  queue.push(providerError(404, { code: "model_not_found", message: "The model `gpt-imaginary` does not exist or you do not have access to it." }));
  const result = await service.connectLlm({ apiKey: "sk-good", model: "gpt-imaginary" });
  assert.equal(result.ok, false);
  assert.equal(result.problem.kind, "unknown_model");
  assert.equal(service.getLlmConfig().model, connection.recommendedModel);
});

test("an outage or a network failure while connecting is reported as the provider's problem, not the person's", async () => {
  queue.push(providerError(503, { message: "Service unavailable" }));
  assert.equal((await service.connectLlm({ apiKey: "sk-good", model: connection.recommendedModel })).problem.kind, "outage");
  const aborted = Object.assign(new Error("fetch failed"), { name: "TypeError" });
  queue.push({ throws: aborted });
  assert.equal((await service.connectLlm({ apiKey: "sk-good", model: connection.recommendedModel })).problem.kind, "unreachable");
  assert.equal(service.getLlmConfig().configured, false);
});

test("without secure storage no key is saved, not even as plain text, and nothing is sent", async () => {
  electron.safeStorage.isEncryptionAvailable = () => false;
  const result = await service.connectLlm({ apiKey: "sk-plaintext-never", model: connection.recommendedModel });
  assert.equal(result.ok, false);
  assert.equal(result.problem.kind, "storage_unavailable");
  assert.equal(result.config.secureStorage, false);
  assert.equal(calls, 0, "The provider is not contacted with a key that could not be kept");
  if (existsSync(settingsFile)) assert.doesNotMatch(readFileSync(settingsFile, "utf8"), /sk-plaintext-never/);
  // The model can still be chosen: it is not a secret.
  const saved = await service.connectLlm({ apiKey: "", model: "custom-model" });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.model, "custom-model");
});

test("a working key connects, and a later outage is shown on the connection until a check works again", async () => {
  queue.push({ status: 200 });
  const result = await service.connectLlm({ apiKey: "sk-good", model: connection.recommendedModel });
  assert.equal(result.ok, true);
  assert.equal(result.config.configured, true);
  assert.doesNotMatch(readFileSync(settingsFile, "utf8"), /"sk-good"/, "The saved key is encrypted, never written as typed");

  queue.push(providerError(500, { message: "Internal server error" }));
  const failed = await service.verifyLlmConfig();
  assert.equal(failed.ok, false);
  assert.equal(failed.problem.kind, "outage");
  assert.equal(service.getLlmConfig().configured, true, "An outage does not disconnect the saved key");
  assert.equal(service.getLlmConfig().lastProblem.kind, "outage");

  queue.push({ status: 200 });
  const retried = await service.verifyLlmConfig();
  assert.equal(retried.ok, true);
  assert.equal(retried.config.lastProblem, undefined);
});

test("a saved key that secure storage cannot unlock is kept on disk and explained", async () => {
  queue.push({ status: 200 });
  await service.connectLlm({ apiKey: "sk-locked", model: connection.recommendedModel });
  const before = JSON.parse(readFileSync(settingsFile, "utf8"));
  // A new launch: nothing in memory, the encrypted key on disk, and secure storage locked.
  await service.saveLlmConfig({ apiKey: "", model: connection.recommendedModel, clearApiKey: true });
  writeFileSync(settingsFile, JSON.stringify(before));
  electron.safeStorage.isEncryptionAvailable = () => false;
  service.loadLlmConfig();
  const locked = service.getLlmConfig();
  assert.equal(locked.configured, false);
  assert.equal(locked.storedKeyUnreadable, true);
  // Changing only the model keeps the locked key instead of dropping it.
  await service.saveLlmConfig({ apiKey: "", model: "another-model" });
  assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).encryptedApiKey, before.encryptedApiKey);
  const check = await service.verifyLlmConfig();
  assert.equal(check.ok, false);
  assert.equal(check.problem.kind, "storage_unavailable");
  // Once secure storage is back, checking again unlocks it.
  electron.safeStorage.isEncryptionAvailable = encryption;
  queue.push({ status: 200 });
  const unlocked = await service.verifyLlmConfig();
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.config.configured, true);
});

test("the assistant path never falls back to local rules without a provider", async () => {
  const config = service.getLlmConfig();
  assert.equal(config.configured, false);
  await assert.rejects(() => service.verifyLlmConfig(), /No hay ninguna API key/);
  assert.equal(calls, 0);
});
