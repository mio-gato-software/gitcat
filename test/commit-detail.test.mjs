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
const { getCommitDetail, getCommitFileDiff } = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));

const repo = mkdtempSync(join(tmpdir(), "gitcat-commit-detail-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main", ".");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
writeFileSync(join(repo, "one.txt"), "one before\n");
writeFileSync(join(repo, "two.txt"), "two before\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
writeFileSync(join(repo, "one.txt"), "one after\n");
writeFileSync(join(repo, "two.txt"), "two after\n");
git("add", "-A");
git("commit", "-q", "-m", "change two files");
const commit = git("rev-parse", "HEAD").trim();

test("un commit se puede leer completo o reducido al archivo que se pulsó", async () => {
  const full = await getCommitDetail(repo, commit);
  assert.deepEqual(full.files.map(({ path }) => path).sort(), ["one.txt", "two.txt"]);
  assert.match(full.diff, /one after/);
  assert.match(full.diff, /two after/);

  const one = await getCommitFileDiff(repo, commit, "one.txt");
  assert.deepEqual(one.files.map(({ path }) => path), ["one.txt"]);
  assert.match(one.diff, /one after/);
  assert.doesNotMatch(one.diff, /two after/);
});

test("el diff de un archivo solo acepta rutas que pertenecen al commit", async () => {
  await assert.rejects(() => getCommitFileDiff(repo, commit, "missing.txt"), /no forma parte de este commit/);
  await assert.rejects(() => getCommitFileDiff(repo, commit, "../outside.txt"), /no pertenece a este repositorio/);
});

test("el historial trae el cuerpo del mensaje y cuánto cambió cada commit", async () => {
  const { loadHistory } = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
  writeFileSync(join(repo, "three.txt"), "a\nb\nc\n");
  git("add", "-A");
  git("commit", "-q", "-m", "tres líneas", "-m", "Un cuerpo\ncon dos líneas");
  const page = await loadHistory(repo, { scope: "all", limit: 1 });
  assert.equal(page.commits[0].subject, "tres líneas");
  assert.equal(page.commits[0].body, "Un cuerpo\ncon dos líneas");
  assert.deepEqual(page.commits[0].stats, { files: 1, additions: 3, deletions: 0 });
  const detail = await getCommitDetail(repo, page.commits[0].hash);
  assert.deepEqual(detail.stats["three.txt"], { additions: 3, deletions: 0, binary: false });
  assert.equal(detail.body, "Un cuerpo\ncon dos líneas");
});
