import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));

const repo = mkdtempSync(join(tmpdir(), "gitcat-graph-actions-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "T");
writeFileSync(join(repo, "a.txt"), "uno\n"); git("add", "-A"); git("commit", "-qm", "uno");
const first = git("rev-parse", "HEAD");
writeFileSync(join(repo, "a.txt"), "dos\n"); git("commit", "-qam", "dos");

test("crear una rama desde un commit del grafo empieza en ese commit, no en HEAD", async () => {
  const plan = await service.prepareOperation(repo, "create_branch", { name: "arreglo/antiguo", from: first }, "es");
  assert.equal(plan.allowed, true);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.command, `git switch -c arreglo/antiguo ${first}`);
  const result = await service.executePlan(repo, plan, "es");
  assert.equal(result.error, undefined);
  assert.equal(git("branch", "--show-current"), "arreglo/antiguo");
  assert.equal(git("rev-parse", "HEAD"), first);
  git("switch", "-q", "main");
});

test("el punto de partida solo puede ser un commit que exista", async () => {
  await assert.rejects(service.prepareOperation(repo, "create_branch", { name: "x", from: "--orphan" }, "en"), /starting commit is invalid/);
  await assert.rejects(service.prepareOperation(repo, "create_branch", { name: "x", from: "deadbeefdeadbeef" }, "en"), /no longer exists/);
});

test("renaming a branch previews the exact non-overwriting command and preserves both tips", async () => {
  git("branch", "feature/original", first);
  git("branch", "feature/occupied", "main");
  const main = git("rev-parse", "main");
  const before = git("status", "--porcelain");

  await assert.rejects(service.prepareOperation(repo, "rename_branch", { name: "feature/original" }, "en"), /new branch name is missing/);
  await assert.rejects(service.prepareOperation(repo, "rename_branch", { name: "feature/original", to: "feature/occupied" }, "en"), /already exists/);
  await assert.rejects(service.prepareOperation(repo, "rename_branch", { name: "main", to: "primary" }, "en"), /cannot rename the default branch/);

  const plan = await service.prepareOperation(repo, "rename_branch", { name: "feature/original", to: "feature/renamed" }, "en");
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.command, "git branch -m -- feature/original feature/renamed");
  assert.equal(git("rev-parse", "feature/original"), first);

  const result = await service.executePlan(repo, plan, "en");
  assert.equal(result.error, undefined);
  assert.equal(git("branch", "--list", "feature/original"), "");
  assert.equal(git("rev-parse", "feature/renamed"), first);
  assert.equal(git("rev-parse", "feature/occupied"), main);
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(git("status", "--porcelain"), before);
});

test("branch cleanup keeps a protected branch even when Git could delete it", async () => {
  git("branch", "backup/keep", first);
  git("branch", "feature/cleanup", first);
  await assert.rejects(service.prepareOperation(repo, "delete_branch", { name: "backup/keep" }, "en"), /protected by its prefix/);
  const plan = await service.prepareOperation(repo, "delete_branch", { name: "feature/cleanup" }, "en");
  assert.equal(plan.command, "git branch -d -- feature/cleanup");
  assert.equal((await service.executePlan(repo, plan, "en")).error, undefined);
  assert.equal(git("branch", "--list", "feature/cleanup"), "");
  assert.equal(git("rev-parse", "backup/keep"), first);
});
