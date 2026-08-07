import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseNameStatus } = await import(pathToFileURL(join(root, "dist-electron/electron/diff-status.js")));

test("un renombrado consume dos rutas y no descoloca lo que viene detrás", () => {
  // El caso que rompe un parser ingenuo: tras una R, todo se atribuiría al archivo equivocado.
  const raw = ["M", "a.txt", "R100", "viejo.txt", "nuevo.txt", "A", "z.txt", ""].join("\0");
  assert.deepEqual(parseNameStatus(raw), [
    { code: "M", path: "a.txt", from: undefined },
    { code: "R100", path: "nuevo.txt", from: "viejo.txt" },
    { code: "A", path: "z.txt", from: undefined }
  ]);
});

test("una copia se lee igual que un renombrado", () => {
  const raw = ["C75", "origen.txt", "copia.txt", "D", "fuera.txt", ""].join("\0");
  assert.deepEqual(parseNameStatus(raw).map((change) => [change.code, change.path]), [["C75", "copia.txt"], ["D", "fuera.txt"]]);
});

test("una salida vacía o truncada no inventa archivos", () => {
  assert.deepEqual(parseNameStatus(""), []);
  // Un estado sin su ruta se descarta en vez de producir un archivo sin nombre.
  assert.deepEqual(parseNameStatus("M\0"), []);
  assert.deepEqual(parseNameStatus(["R100", "solo-origen.txt", ""].join("\0")), []);
});

test("coincide con lo que git escribe de verdad, renombrado incluido", () => {
  const repo = mkdtempSync(join(tmpdir(), "branchline-status-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "viejo.txt"), "contenido que se conserva entero\n".repeat(20));
  writeFileSync(join(repo, "otro.txt"), "otro\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const first = git("rev-parse", "HEAD").trim();
  git("mv", "viejo.txt", "nuevo.txt");
  writeFileSync(join(repo, "otro.txt"), "otro cambiado\n");
  writeFileSync(join(repo, "tercero.txt"), "nuevo archivo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "renombra y cambia");

  const raw = git("diff", "--name-status", "-z", "-M", first, "HEAD", "--");
  const parsed = parseNameStatus(raw);
  const rename = parsed.find((change) => change.code.startsWith("R"));
  assert.ok(rename, `git no reportó un renombrado: ${JSON.stringify(raw)}`);
  assert.equal(rename.path, "nuevo.txt");
  assert.equal(rename.from, "viejo.txt");
  // Y los otros dos archivos conservan su propio estado, que es lo que un parser mal hecho pierde.
  assert.deepEqual(parsed.filter((change) => !change.code.startsWith("R")).map((change) => [change.code, change.path]).sort(),
    [["A", "tercero.txt"], ["M", "otro.txt"]]);
});
