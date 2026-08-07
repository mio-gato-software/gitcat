import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pending = await import(pathToFileURL(join(root, "dist-electron/electron/pending-operation.js")));

test("«quedarse con un lado» hace lo correcto según la forma del conflicto", () => {
  // El caso que importa: cuando los dos lados tienen el archivo, ninguno de los dos es un borrado.
  assert.equal(pending.resolutionFor("both-modified", "ours"), "checkout");
  assert.equal(pending.resolutionFor("both-modified", "theirs"), "checkout");
  assert.equal(pending.resolutionFor("both-added", "theirs"), "checkout");
  // Un lado que no tiene el archivo no puede sacarlo del índice: quedarse con él es borrarlo.
  assert.equal(pending.resolutionFor("deleted-by-us", "ours"), "remove");
  assert.equal(pending.resolutionFor("deleted-by-us", "theirs"), "add");
  assert.equal(pending.resolutionFor("deleted-by-them", "ours"), "add");
  assert.equal(pending.resolutionFor("deleted-by-them", "theirs"), "remove");
  assert.equal(pending.resolutionFor("added-by-us", "ours"), "add");
  assert.equal(pending.resolutionFor("added-by-us", "theirs"), "remove");
  assert.equal(pending.resolutionFor("added-by-them", "ours"), "remove");
  assert.equal(pending.resolutionFor("added-by-them", "theirs"), "add");
  assert.equal(pending.resolutionFor("both-deleted", "ours"), "remove");
  assert.equal(pending.resolutionFor("both-deleted", "theirs"), "remove");
});

test("los códigos de estado de un conflicto se leen como lo que significan", () => {
  assert.deepEqual(pending.conflictsFrom([
    { code: "UU", path: "a" }, { code: "M", path: "b" }, { code: "DU", path: "c" }, { code: "??", path: "d" }
  ]), [{ path: "a", kind: "both-modified" }, { path: "c", kind: "deleted-by-us" }]);
  assert.equal(pending.conflictKind("AA"), "both-added");
  assert.equal(pending.conflictKind("M"), undefined);
});

test("solo un rebase y un cherry-pick pueden saltarse el commit atascado", () => {
  assert.equal(pending.canSkip("rebase"), true);
  assert.equal(pending.canSkip("cherry_pick"), true);
  assert.equal(pending.canSkip("merge"), false);
  assert.equal(pending.canSkip("revert"), false);
});

test("el progreso de un rebase sale de sus propios archivos, y lo ilegible no se inventa", () => {
  assert.deepEqual(pending.parseRebaseProgress({ msgnum: "2\n", end: "5\n", "head-name": "refs/heads/feature/x", onto: "abc123" }),
    { step: 2, total: 5, branch: "feature/x", onto: "abc123" });
  // El rebase basado en parches usa otros dos nombres para lo mismo.
  assert.deepEqual(pending.parseRebaseProgress({ next: "1", last: "3" }), { step: 1, total: 3, branch: undefined, onto: undefined });
  assert.deepEqual(pending.parseRebaseProgress({}), { step: undefined, total: undefined, branch: undefined, onto: undefined });
  assert.deepEqual(pending.parseRebaseProgress({ msgnum: "cero", end: "0" }).step, undefined);
});

test("coincide con lo que Git deja de verdad en un rebase atascado", () => {
  const repo = mkdtempSync(join(tmpdir(), "branchline-conflict-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "f.txt"), "uno\ndos\ntres\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  git("switch", "-qc", "feature/x");
  writeFileSync(join(repo, "f.txt"), "uno\nDOS-mio\ntres\n");
  git("commit", "-qam", "mi cambio");
  git("switch", "-q", "main");
  writeFileSync(join(repo, "f.txt"), "uno\nDOS-suyo\ntres\n");
  git("commit", "-qam", "su cambio");
  git("switch", "-q", "feature/x");
  try { git("rebase", "main"); } catch { /* el conflicto es justo lo que se está provocando */ }

  const read = (name) => { try { return readFileSync(join(repo, ".git/rebase-merge", name), "utf8"); } catch { return undefined; } };
  const files = Object.fromEntries(["msgnum", "end", "next", "last", "head-name", "onto", "onto-name"].map((name) => [name, read(name)]));
  const progress = pending.parseRebaseProgress(files);
  assert.equal(progress.step, 1);
  assert.equal(progress.total, 1);
  assert.equal(progress.branch, "feature/x", "la rama se lee sin el refs/heads/");

  const status = git("status", "--short").trim();
  assert.match(status, /^UU/, `git reportó "${status}"`);
  assert.deepEqual(pending.conflictsFrom([{ code: "UU", path: "f.txt" }]), [{ path: "f.txt", kind: "both-modified" }]);

  // Y la resolución que la tabla indica deja el rebase terminado de verdad.
  assert.equal(pending.resolutionFor("both-modified", "theirs"), "checkout");
  git("checkout", "--theirs", "--", "f.txt");
  git("add", "--", "f.txt");
  git("-c", "core.editor=true", "rebase", "--continue");
  assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "uno\nDOS-mio\ntres\n");
  assert.equal(git("status", "--short").trim(), "", "el árbol queda limpio");
});
